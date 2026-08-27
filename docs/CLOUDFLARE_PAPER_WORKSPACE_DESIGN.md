# Cloudflare Paper Workspace Production Design

> Status: proposed execution contract.  This document is authoritative only for
> `cloudflare-deploy`; it must not be merged into, or implemented on, `main`.
>
> Baseline: `cloudflare-deploy` after C7 (`57f6fb9` runtime contract).  C7's
> Worker/D1/R2/Redis task runtime remains in service and is not redesigned here.
>
> Purpose: complete the Paper/Analysis product so a user can search a paper,
> materialize its PDF, read page-scoped text, inspect extracted figures, and
> resume that work after a refresh without losing tool history.

## 1. Decision and scope

The current Edge PaperAgent is a deliberately small implementation:

- `search_paper` searches arXiv and PubMed;
- `read_paper` returns abstract-level content only;
- the chat loop holds OpenAI-style `tool_calls` and `tool` results only in
  request memory;
- D1 persists only final user/assistant text in `chat_messages`.

The repository also contains a Python reference implementation that can
download PDFs, extract text with `pypdf`, extract embedded images with PyMuPDF,
and inspect cached material.  It is not a Cloudflare production service.  It is
useful as a behavioral reference, but it must not be exposed, copied wholesale,
or treated as a second production database.

The supported source contract is deliberately narrower than generic web
downloading. arXiv references are materializable. The current PubMed search
path returns a PMID-shaped `pubmed:<PMID>` reference and explicitly marks it
`availability.kind=abstract_only` with reason code
`PUBMED_PMC_NOT_RESOLVED`; `materialize_paper` returns the stable
`paper_pubmed_full_text_unavailable` result for that reference and creates no
resource. Only a separately controlled metadata path may return an eligible
`pubmed:PMC<PMCID>` reference. A numeric PMID must never be treated as a
PMCID. `approved_url` is not an active public source kind in this release; the
resource API rejects it with `PAPER_APPROVED_URL_DISABLED` before creating D1
state. A future approved-URL feature requires a dedicated source-admission
design.

This programme has five in-scope outcomes:

1. Every user-visible and model-relevant tool call is durably recorded.
2. A paper becomes a durable, authorized resource rather than a transient URL.
3. PDF download and extraction run in a dedicated trusted processor, never in a
   normal Edge request and never in the public Claude-Code Worker pool.
4. The Edge Agent gains an explicit full-text, page, image, and image-analysis
   tool contract.
5. Each implementation card produces reproducible evidence and has a rollback
   boundary.

Out of scope:

- changing C7's public Worker pool, its lease/fencing protocol, or Case 2;
- adding PostgreSQL/Hyperdrive to the Cloudflare production path;
- placing a Cloudflare account token, D1 API token, R2 parent credential, or a
  provider secret in the browser or any public Worker;
- claiming OCR for scanned PDFs in the first full-text release;
- reintroducing the removed generic Chat Agent product.

## 2. Non-negotiable architecture

```text
Browser
  -> Edge Worker: OIDC, session authorization, chat/SSE, D1 metadata
  -> D1: conversation events, paper metadata, leases, audit state
  -> R2: PDF bytes, extracted page text, image objects, immutable manifests
  -> trusted Paper Processor: download, validate, parse, upload results

Redis remains a recreatable notification hint only.  It contains no PDF bytes,
full text, source URLs containing credentials, tool payloads, or user secrets.
```

The processor is a fixed-purpose service on the owner-approved `zhangbot`
Linux VPS. This is the sole allowed host and sole active instance for the
release; it is not a student/public Worker, the existing generic Claude Code
runtime, or a Docker deployment. It receives a short-lived,
resource-and-attempt-scoped capability over the fixed HTTPS Edge control API at
`https://infinity.zhangyvjing.com`. It has no inbound listener and may make
outbound HTTPS requests only to that control plane and the explicit arXiv/PMC
source allowlist. It never receives D1/R2 parent credentials and never gets
the ability to list another user's resources.

Its release artifact is a reviewed Git commit plus source, dependency-lock,
and systemd-unit hashes, installed in a Python 3.10 virtualenv under a
commit-named release directory. The `systemd-user` service uses
`PrivateTmp`, `NoNewPrivileges`, `ProtectSystem`, bounded memory/tasks, a
controlled work directory, and a mode-0600 env file containing only
`PAPER_PROCESSOR_TOKEN`. The Edge separately holds
`PAPER_PROCESSOR_SHARED_SECRET`. The definition also fixes health/restart
rules, singleton/lease assumptions, log-redaction rules, and rollback. The
Dockerfile is retained only as historical/reference material and is not a
deployable artifact for this runtime.

The processor may use a temporary local working directory.  That directory is
not a product storage location: it is deleted after a terminal attempt.  The
durable equivalent of the user's "current directory" is a resource namespace in
R2, referenced by opaque D1 metadata.

## 3. Conversation event contract

### 3.1 Why `chat_messages` is insufficient

An LLM tool turn is a sequence, not a pair of text messages:

```text
user message
assistant tool_call(id, name, arguments)
tool result(tool_call_id, payload)
assistant continuation/final answer
```

Dropping the middle two events makes a reloaded model context structurally
different from the context that produced the answer.  It also prevents the UI
from honestly showing whether a paper was merely searched, is downloading, or
was fully parsed.

### 3.2 Canonical table

Add a forward-only D1 migration that creates `chat_events`.

```sql
CREATE TABLE chat_events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES chat_sessions(id),
  turn_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'user_message', 'assistant_message', 'tool_call', 'tool_result',
    'system_status', 'error'
  )),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool', 'system')),
  content TEXT,
  tool_call_id TEXT,
  tool_name TEXT,
  tool_arguments_json TEXT,
  result_summary TEXT,
  result_object_key TEXT,
  result_sha256 TEXT,
  result_bytes INTEGER,
  status TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_chat_events_session_event ON chat_events(session_id, event_id);
CREATE UNIQUE INDEX idx_chat_events_tool_call ON chat_events(session_id, tool_call_id)
  WHERE event_type = 'tool_call' AND tool_call_id IS NOT NULL;
```

Rules:

- `chat_events` becomes the only canonical source for new conversation turns.
  Do not dual-write new events into `chat_messages`.
- The migration backfills legacy `chat_messages` rows as `user_message` or
  `assistant_message`, preserving chronological order and preserving the
  original table until a separately approved retirement migration.
- Every event is written before the next model completion request.  A tool
  result is written exactly once per `tool_call_id`; retries reuse or append a
  clearly marked terminal result, never a duplicate opaque call.
- D1 stores a bounded summary.  Payloads above the configured threshold are
  immutable R2 objects; D1 records their key, byte count, SHA-256, and a safe
  summary.  Provider responses, token streams, and arbitrary unbounded text do
  not become a D1 blob.
- The model-history builder reconstructs the exact provider message shape from
  the events.  It applies an explicit context policy: retain the newest complete
  tool turns, summarize older tool results, and never retain an orphaned tool
  result without its call.
- The ordinary session-history API returns safe event summaries.  Full result
  payload retrieval has a separate authorized resource endpoint and does not
  expose raw R2 keys.

`chat_request_idempotency` remains the request-level retry guard; it does not
replace the event ledger.

### 3.3 SSE and frontend contract

Replace the lossy `{ type: 'tool_call', tool_name }` event with stable event
payloads containing at least `event_id` or client correlation ID,
`tool_call_id`, `tool_name`, `status`, and a display-safe summary.  Add a
`tool_result` SSE event.  Arguments must be redacted/size-capped before browser
delivery.

The client keeps a collapsed per-turn tool timeline while streaming, and rebuilds
the same timeline from durable history after reload.  It must not infer state
from a tool name or assume that a completed assistant text means a PDF finished.

## 4. Paper resource contract

### 4.1 D1 metadata and state machine

Create these D1 entities in a new migration.  Names may vary only if the
implementation card updates this document and all tests together.

```text
paper_resources
  resource_id (opaque UUID), session_id, user_id
  source_kind = arxiv | pubmed_pmc | user_upload | approved_url
  source_ref, canonical_ref, title
  status = requested | downloading | extracting | ready | failed | deleted
  source_sha256, pdf_object_key, pdf_size_bytes, pdf_sha256
  text_manifest_key, image_manifest_key, page_count, image_count
  error_code, error_message_safe, created_at, updated_at, ready_at

paper_processing_attempts
  attempt_id, resource_id, processor_id, lease_token_hash, fencing_epoch
  status = queued | claimed | downloading | extracting | uploading |
           succeeded | failed | expired | cancelled
  started_at, lease_expires_at, finished_at, error_code, error_message_safe

paper_resource_links
  session_id, resource_id, purpose = search_result | read | upload
  created_at
```

Ownership is checked by `session_id + user_id` on every Edge route.  A guessed
`resource_id`, R2 key, page number, or image name never grants access.  A public
paper may later be deduplicated at the object level only after its provenance is
verified; it must never make user-uploaded or arbitrary URLs public.

The allowed transitions are:

```text
requested -> downloading -> extracting -> uploading -> ready
requested/downloading/extracting/uploading -> failed | cancelled
ready -> deleted
claimed/downloading/extracting/uploading -> expired -> queued | failed
```

Each transition is a conditional D1 update bound to the current processor
attempt, lease token, and fencing epoch.  A stale processor cannot publish a
later result.

### 4.2 R2 layout and manifest

R2 keys are opaque and never returned as browser-facing identifiers:

```text
paper/{resource_id}/source.pdf
paper/{resource_id}/text/pages.jsonl
paper/{resource_id}/text/manifest.json
paper/{resource_id}/images/page-0001/image-0001.png
paper/{resource_id}/images/manifest.json
paper/{resource_id}/processor/manifest.json
```

The final processor manifest contains parser version, source and output hashes,
page count, per-page text byte counts, image IDs/pages/content types/hashes, and
warnings such as `no_text_layer` or `image_extraction_partial`.  It does not
contain secret headers, source URL query tokens, local paths, or raw stack
traces.

The Edge validates the manifest and each declared object before marking a
resource `ready`.  Partial output is never presented as ready.

## 5. Source admission and PDF processing

### 5.1 Allowed sources

The normal path uses immutable canonical references returned by `search_paper`:

- arXiv ID -> the known arXiv PDF endpoint;
- PubMed result -> only an eligible, public PMC PDF endpoint. PMID-only search
  results remain abstract-only with their stable availability reason;
- user upload -> a private, previously validated R2 upload object.

Do not make arbitrary web URLs a default Agent tool argument.  If
`approved_url` is later required, it needs a separate security card: HTTPS only,
no credentials in URLs, DNS resolution and every redirect checked against
loopback/private/link-local/multicast/metadata ranges, strict redirect count,
streaming byte cap, content-type plus PDF magic validation, and an audit record.
Fail closed if this validation cannot be completed.

### 5.2 Trusted processor requirements

The processor implements deterministic transformation only.  It does not obey
document instructions and does not call an LLM while holding raw resources.

1. Receive an exact resource lease via fixed HTTPS endpoints.
2. Download only the server-authorized input, with a byte cap and hash while
   streaming.  Stop before buffering an unbounded response.
3. Check `%PDF-` magic, page limit, encrypted/malformed PDF policy, and input
   size before parsing.
4. In a non-root, limited CPU/memory/time, no-network-after-download process,
   extract per-page text and embedded images.
5. Save only supported image formats and enforce image count, dimension, and
   byte limits.  Keep image-to-page provenance.
6. Upload immutable output plus manifest through an attempt-scoped API; the
   Edge checks lease/fencing/hash/manifest before publishing.
7. Remove its temporary directory on success, failure, cancellation, and
   restart recovery.

Initial extraction scope is text-layer PDFs and embedded raster images.  It
returns explicit warnings for scanned/image-only pages.  OCR and page rasterizing
are a later card, not a silent fallback.

## 6. Production Agent tool contract

The production model receives only these paper tools.  Tool schemas use opaque
references, bounded selectors, and no server paths.

| Tool | Purpose | Terminal result |
|---|---|---|
| `search_paper(query, num_results)` | Find canonical public references and metadata | normalized result list with `paper_ref` and availability; PMID-only PubMed results are explicitly abstract-only |
| `materialize_paper(paper_ref)` | Create or reuse an authorized PDF resource | `resource_id`, durable processing state, safe progress |
| `read_paper(resource_id, mode, pages?, query?, max_chars?)` | Read ready material | page text, search hits, outline, or image manifest entries |
| `analyze_paper_image(resource_id, image_id, prompt, detail)` | Submit one authorized extracted image to the configured vision provider | structured result and provenance |

`read_paper.mode` is one of `text`, `search`, `outline`, or `images`.

- `text` accepts a bounded page range and character limit;
- `search` accepts a bounded literal or regex policy and returns page-scoped
  excerpts;
- `outline` returns page/heading metadata;
- `images` returns image IDs, pages, dimensions, and authorized display URLs,
  never filesystem paths or bare R2 keys.

When a resource is not ready, `read_paper` returns a structured processing state
instead of falling back to an abstract or pretending the full text was read.
The Agent reports that distinction to the user.

Image bytes are retrieved through an authorized same-origin route or a narrowly
scoped, short-lived capability.  Do not Base64-embed large images into SSE or
model context.  The image-analysis tool sends only the selected authorized image
and records provider egress in the resource/tool event audit trail.

## 7. Security, privacy, and reliability gates

Before a PDF resource feature reaches production, all of the following are true:

- no public/client/public-Worker code holds D1, R2, Redis, processor, or model
  parent credentials;
- direct URL, redirect, DNS rebinding, private-address, oversized body,
  non-PDF, malformed PDF, zip-like payload, parser timeout, and parser memory
  exhaustion all fail safely;
- Alice cannot enumerate, read, display, analyze, or receive Bob's PDF/text/
  images/tool payloads, including after session deletion or access revocation;
- a processor restart, duplicate delivery, stale lease, and duplicate upload
  produce at most one published resource manifest;
- resource deletion revokes future content access, cancels active processing,
  and schedules object cleanup without breaking immutable task evidence;
- logs and evidence contain no cookies, source URL credentials, full private
  text, image bytes, R2 keys, or provider secrets;
- metrics distinguish queue latency, download failure, extraction failure,
  manifest validation failure, page/image counts, result size, and stale-lease
  rejection.

Access-token JWT verification also gets an explicit `header.alg === 'ES256'`
and `kid` validation for Access Tokens, with negative tests for `none`, `HS256`,
missing `kid`, and an unknown key.  Current ECDSA-only verification limits the
practical algorithm-confusion surface, but the production contract must be
explicit.

## 8. Compatibility, migration, and rollback

- Existing conversation history remains readable after the `chat_events`
  backfill.  It will have no retrospective tool trace; the UI labels it as
  legacy rather than inventing one.
- Existing `paper_authorizations` may remain during migration, but the resource
  authorization path must converge on `paper_resource_links`; do not create two
  permanently authoritative authorization systems.
- Every migration is additive/backfill-first.  Destructive table removal occurs
  only in a later, separately approved card after production observation.
- A deployment failure rolls back Worker code first.  Additive D1 schemas and
  immutable R2 objects stay compatible with the preceding code; do not manually
  rewrite a resource state to manufacture a pass.

## 9. Definition of done

The Paper Workspace is complete only when a real authenticated browser can:

1. search an open paper;
2. request materialization and see durable progress;
3. refresh during and after processing without losing the tool timeline;
4. read selected page text, search text, list images, and analyze one selected
   image;
5. be denied every attempt to access another user's resource;
6. recover correctly from duplicate processing, processor restart, stale lease,
   malicious source URL, bad PDF, and failed upload;
7. pass unit, integration, real D1/R2, real browser, secret-scan, and rollback
   evidence gates specified in the execution plan.
