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
`PrivateTmp`, `NoNewPrivileges`, `ProtectSystem`, `ProtectHome`, bounded
memory/tasks, identity/network restrictions, a controlled work directory, and
a mode-0600 env file containing only `PAPER_PROCESSOR_TOKEN`. On this
unprivileged user manager, disposable host probes reject `PrivateDevices` and
the kernel protection controls with systemd status `218/CAPABILITIES`, so the
approved unit records those controls as unsupported rather than claiming they
are active. The Edge separately holds
`PAPER_PROCESSOR_SHARED_SECRET`. The definition also fixes health/restart
rules, singleton/lease assumptions, log-redaction rules, and rollback. The
Dockerfile is retained only as historical/reference material and is not a
deployable artifact for this runtime.

The Processor runtime has a bounded execution contract: each grant has a
240-second attempt deadline, 90-second download budget, 120-second extraction
budget, 90-second upload/finalize budget, and a 30-second D1 lease heartbeat.
The application enforces a 192 MiB resident-memory budget before and during
PDF extraction, while systemd supplies `MemoryHigh=192M` and
`MemoryMax=256M`. A deadline, memory breach, or failed heartbeat is reported
through the existing fenced Edge failure operation using only a safe error
code; it cannot remain an unobserved `processing` attempt. The runner emits
only redacted stage/terminal events and never logs payloads, headers, tokens,
source URLs, local paths, or exception tracebacks.

The Edge ingress has a separate, defense-in-depth service-to-service contract.
The zhangbot read-only egress preflight on 2026-08-28 agreed on public IPv4
`39.105.204.121` across three providers. A zone-level Cloudflare custom rule
may skip only Browser Integrity Check (`action=skip`,
`action_parameters.products=["bic"]`) for that IP, host
`infinity.zhangyvjing.com`, and this finite fixed path set:

```text
POST /api/paper-processor/connect
POST /api/paper-processor/poll
POST /api/paper-processor/control
PUT  /api/paper-processor/object
```

The control endpoint accepts only a server-allowlisted JSON operation envelope;
the object endpoint accepts only a bounded JSON upload envelope plus the
binary body. Attempt, resource, and object identifiers never occur in the
Processor URL. The rule must keep matching requests logged and must not skip
Security Level, User Agent Blocking, Zone Lockdown, managed/custom WAF phases,
rate limiting, Bot Fight Mode, or other custom rules. It must not be an IP
Access `Allow`, a whole-host exception, or a browser-signature workaround.
Non-zhangbot IPs and all non-Processor paths remain protected by the existing
zone controls. This fixed path set is expressible on the current Free plan and
does not require a plan upgrade.

The control operation allowlist is exactly `input`, `input_source`, `renew`,
`stage`, `finalize`, `cancel`, and `fail`. The fixed object endpoint accepts
only the `upload` operation and the object kinds `source_pdf`, `text_pages`,
`text_manifest`, `image`, and `image_manifest`; object IDs are accepted only
where the server-side kind contract requires them. The Worker rejects extra
envelope fields and derives all D1/R2 destinations from the authorized
session, attempt, resource, lease, fencing epoch, and object kind.

The Worker also requires the non-secret `PAPER_PROCESSOR_SOURCE_IP` binding and
the Cloudflare-injected `CF-Connecting-IP` to match before it evaluates
Processor ID, bootstrap secret, session, nonce, lease, or fencing state. A
missing/mismatched source or route fails with
`PAPER_PROCESSOR_SOURCE_FORBIDDEN`; missing or incorrect Processor bootstrap
credentials still fail with `PAPER_PROCESSOR_UNAUTHENTICATED`. The source IP
must be rechecked before every release; a changed address is a blocker, not a
reason to widen the exception. If the Cloudflare control plane cannot create
and read back this exact host/IP/method/path expression and BIC-only scope,
PAPER-10 remains blocked.

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

Every `search_paper` result crosses one normalization boundary before it is
returned to the model or written to the cache.  The boundary is applied to
both fresh upstream records and legacy cached records: a canonical arXiv ref
gets `availability.kind=materializable` when that field is absent, while a
PubMed record without an explicit `pubmed:PMC<PMCID>` remains
`abstract_only`.  This is a metadata default only; it never rewrites a PMID
into a PMCID or permits an untrusted source/ref to reach materialization.

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

### 6.1 Durable paper-intent continuation

The chat turn and the asynchronous resource lifecycle are separate durable
facts.  When `materialize_paper` is called from a chat turn, the Edge creates a
row in the additive `paper_request_continuations` ledger and returns its opaque
`continuation_id` together with the `resource_id` and processing state.  The
unique key `(session_id, turn_id, resource_id)` makes repeated tool delivery
idempotent.  The ledger contains only bounded identifiers, status, timestamps,
an optional client request ID, and a safe error code; it never contains PDF or
full-text bytes, R2 keys, provider payloads, or credentials.

The continuation state is `waiting -> ready -> running -> completed`, with
explicit `failed`, `cancelled`, and `expired` terminal/retry states.  Processor
finalization moves a waiting row to `ready`; resource failure, cancellation, or
deletion propagates to the continuation.  A five-minute execution lease and a
24-hour absolute continuation expiry are claimed atomically in D1.  A stale
running lease may be reclaimed only by the same authenticated owner while the
resource is still ready.  Completion requires the active run ID and a still
ready resource, so duplicate or late completions cannot close another run.

`POST /api/paper/continuations/:continuation_id` accepts only the owning
`session_id`.  The Edge derives the resource and original turn from D1, checks
session/user/resource ownership, and rebuilds provider messages from the
canonical event ledger.  It records a system-status event, then requires the
provider to call `read_paper` or `analyze_paper_image` for that exact resource
before a continuation can complete.  The provider cannot supply an R2 key,
path, or replacement resource.  Cross-user or unknown IDs return the same
not-found boundary; expired, completed, not-ready, cancelled, and in-progress
requests return stable conflict codes.  A model or tool failure releases the
run lease back to `ready` for a controlled retry, while preserving the failed
tool/error events.

The initial provider contract is equally strict: a paper/PDF/full-text intent
with no Paper tool call returns `PAPER_TOOL_CALL_REQUIRED`, emits no `done`
event, and creates no resource.  A materialization result with `processing`
emits `paper_processing` and a processing assistant event, never a final
completion.  Frontend task/progress projection is intentionally a later card;
the durable ledger and event contract are the source of truth.

### 6.2 Paper progress read model and event projection

The frontend reads one owner-scoped progress snapshot through the fixed route
`GET /api/paper/resources/:resource_id/progress?session_id=:session_id`.
Authentication is the existing session cookie; the `session_id` query value is
required and is checked against the authenticated user, the resource owner, and
an active `paper_resource_links` row.  A missing, guessed, revoked, or
cross-user resource has the same `PAPER_RESOURCE_NOT_FOUND` boundary.  A
known deleted resource returns `PAPER_RESOURCE_DELETED` and no progress body.
There is no resource-list endpoint in this contract, so refresh cannot be used
to enumerate another user's resources.

The response is a bounded, read-only projection of D1 authority:

```json
{
  "resource": {
    "resource_id": "opaque-resource-id",
    "status": "requested|downloading|extracting|uploading|ready|failed|cancelled",
    "stage": "same lifecycle value as status",
    "source_kind": "arxiv|pubmed_pmc|user_upload",
    "title": "optional bounded title",
    "page_count": null,
    "image_count": null,
    "error": null,
    "created_at": 0,
    "updated_at": 0,
    "ready_at": null
  },
  "revision": "resource-updated:latest-continuation:latest-event",
  "materialize": {
    "invocation_status": "succeeded|not_recorded",
    "invocation_event_id": "opaque-event-id",
    "invoked_at": 0,
    "resource_ready": false
  },
  "correlation": {
    "continuations": [{
      "continuation_id": "opaque-continuation-id",
      "original_turn_id": "opaque-chat-turn-id",
      "status": "waiting|ready|running|completed|failed|cancelled|expired",
      "expires_at": 0,
      "updated_at": 0,
      "completed_at": null
    }]
  },
  "events": [{
    "event_id": "opaque-event-id",
    "stage": "materialize|download|extraction|upload|image_analysis|cancel|delete|cleanup",
    "outcome": "started|succeeded|failed|denied|cancelled",
    "error_code": null,
    "created_at": 0
  }],
  "resume": {
    "available": true,
    "continuation_id": "opaque-continuation-id",
    "method": "POST",
    "path": "/api/paper/continuations/opaque-continuation-id",
    "body": {"session_id": "owning-session-id"},
    "reason_code": null
  }
}
```

`stage` is a lifecycle projection, not model prose.  `materialize.invocation_status
= succeeded` records that the tool invocation was durably accepted; it does not
mean the resource is ready.  `resource.status = ready` is established only by
the D1/R2/Processor completion contract.  Failed progress exposes only a
validated error code and bounded safe message; audit `metadata_json`, provider
payloads, PDF/full text, image bytes, source URLs, local paths, and R2 object
keys never cross this API boundary.  Events are limited to safe D1 columns and
the response is capped to recent bounded continuation/event rows.

Repeated GETs do not claim leases, mutate state, or enqueue work.  The
`revision` changes only when the resource, continuation, or audit event
projection changes, allowing reconnect/refresh code to discard an unchanged
snapshot safely.  A ready snapshot may expose one action only: the existing
`POST /api/paper/continuations/:continuation_id` contract with a session-only
body.  The server still rechecks ownership, resource readiness, continuation
expiry, and the atomic execution lease; the browser cannot choose a resource,
R2 key, page object, or provider payload.

The frontend contract client normalizes this response and the existing
`paper_processing` stream event into bounded typed data.  `PAPER-FIX-03`
projects that contract as a durable task surface: it derives a candidate only
from a successful `materialize_paper` tool-result timeline entry containing a
server-shaped `mode` and opaque `resource_id`.  Assistant prose, including
"开始下载/解析", never creates a task and a successful tool invocation is
never rendered as `ready` without a subsequent progress snapshot.

On initial receipt or history rehydration, the UI reads the known resource by
the owner-scoped progress route.  While the server reports
`requested|downloading|extracting|uploading`, it reconnects with bounded
backoff (1, 2, 4, 8, then 15 seconds); `ready`, `failed`, and `cancelled` stop
the timer.  A stale response from a previous session/component generation is
discarded.  Network/invalid-snapshot failures display only a generic retry
state, while a failed resource displays only the normalized server-provided
safe error.  `401/403` and `404/410` are represented as denied/absent and
render no resource card, preserving the non-enumerating boundary.

Only a server-advertised ready snapshot can expose the one-click resume/read
action.  The action sends the existing authenticated
`POST /api/paper/continuations/:continuation_id` request with the owning
session ID, consumes its bounded SSE event contract, and suppresses duplicate
clicks while the same action is in flight.  The browser does not choose a
resource, page, image, provider payload, R2 key, or lifecycle transition; the
server and D1/R2/Processor contracts remain authoritative.  A component
unmount, session switch, or refresh cannot make an old response update the new
session's task surface.

### 6.3 Production chat rehydration and task projection

The chat surface treats a Paper task as a projection of durable correlation,
not as a phrase in an assistant message.  `GET /api/sessions/:session_id/messages`
therefore returns an additive `paper_tasks` array alongside `messages` and the
safe tool `events` timeline:

```json
{
  "resource_id": "opaque-resource-id",
  "continuation_id": "opaque-continuation-id",
  "correlation_id": "opaque-chat-turn-id",
  "tool_call_id": "opaque-tool-call-id",
  "materialize_status": "succeeded",
  "readiness": "unknown"
}
```

The Edge constructs each candidate only when the canonical D1 event ledger has
a successful `materialize_paper` result for the same turn and tool call, and
the owner/session/resource-validated continuation ledger has the same resource
(and, when present, continuation) identity.  Assistant prose, a bare resource
ID, a malformed result, a failed tool result, or a cross-user/unlinked resource
does not produce a candidate.  The projection exposes no source reference,
provider payload, PDF/full-text data, R2 key, or secret, and legacy text-only
history returns an empty array.

During a live chat stream, the typed `paper_processing` event is correlated to
the in-memory successful `materialize_paper` tool event before the frontend
creates the same opaque candidate.  A display-safe materialize summary is
therefore sufficient; the browser does not parse assistant prose or require a
JSON payload in the rendered summary.  Stream close after `paper_processing`
settles the chat run as resumable processing rather than as a final success or
transport error.  The progress hook then obtains the authoritative lifecycle
from the owner-scoped progress endpoint, so accepted materialization cannot be
rendered as `ready`.

Creating a new session updates the local session list by idempotent upsert and
selects that session before sending the first turn.  Renaming the first turn
also uses an upsert, so a stale session-list response cannot erase the newly
created item.  Selecting a sidebar session explicitly starts the authenticated
history load (with in-flight de-duplication), which restores messages, tool
timeline, `paper_tasks`, and the progress read model after refresh.  All
responses remain scoped to the selected session generation; a stale load cannot
paint another session's messages or task card.

Image bytes are retrieved through an authorized same-origin route or a narrowly
scoped, short-lived capability.  Do not Base64-embed large images into SSE or
model context.  The image-analysis tool sends only the selected authorized image
and records provider egress in the resource/tool event audit trail.

### 6.4 Paper-intent orchestration and materialization guard

The chat loop distinguishes paper discovery from a request that asks to download,
parse, or read PDF/full-text content.  A search-only request may finish after a
successful `search_paper` call and an explanatory answer.  A full-text request
cannot finish merely because any Paper tool ran: its terminal condition is a
successful `materialize_paper` result with a server-issued `resource_id` and
`continuation_id`, or an explicit safe failure.

The provider is instructed to call `materialize_paper` after it receives eligible
search results, but the instruction is not the safety boundary.  If the provider
repeats `search_paper` until the bounded tool-loop limit, the Edge may perform one
controlled recovery call using the first canonical, explicitly
`availability.kind = materializable` reference from a successful search result in
the same turn.  The candidate is limited to the existing canonical arXiv and
eligible `pubmed:PMC...` forms; a numeric PubMed PMID, prose, malformed JSON,
arbitrary URL, or a ref not surfaced by the current session is never passed to
`materialize_paper`.  The normal materialization function still rechecks session,
user, and paper authorization and persists the synthetic call/result in the same
durable event ledger.

The recovery call is at most once per chat turn and uses the existing
`client_request_id`/resource idempotency and continuation contract.  A processing
result returns `paper_processing` without `done`; a ready result remains a
materialization success and must still be read through the existing resource
contract.  If no eligible candidate exists, or materialization returns an error or
malformed success shape, the loop emits a safe `PAPER_MATERIALIZE_REQUIRED` or
`PAPER_MATERIALIZE_FAILED` error and never writes a successful assistant terminal
state.  Search failures remain tool failures.  This prevents an empty provider
response after repeated search calls from becoming a false completion while
preserving ordinary search behavior.

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
- The Paper task surface can be disabled or reverted independently of the
  resource/continuation data.  Reverting it stops browser polling and resume
  controls without deleting history, cancelling leases, removing R2 objects,
  or changing D1 lifecycle state.

## 9. Definition of done

### 9.1 Processor lease recovery

Before every server-selected Processor poll, the Worker atomically retires any
expired active Processor attempt with the bounded
`PAPER_PROCESSOR_LEASE_EXPIRED` code and returns its non-terminal resource to
`requested`.  A new claim receives the next fencing epoch.  This recovery is
driven solely by D1 lease time and never by a browser retry or manual database
edit; a live lease is never reclaimed.

### 9.2 Bounded terminal download retry

An explicit `PAPER_PROCESSOR_DOWNLOAD_TIMEOUT` is operationally different from
an invalid or unsafe source: it may reflect a transient upstream transfer
failure after the Processor has already proved the source eligible.  The owner
may request that same arXiv/PMCID resource once more through
`materialize_paper`.  The Worker atomically records a bounded retry audit fact
and moves that exact failed resource back to `requested`; it retains all prior
attempts, so the next Processor claim receives the next fencing epoch.

The transition requires same session and user ownership, the exact timeout
code, no active attempt, and exactly one historical Processor attempt.  It
never applies to parse/security/cancellation failures and never creates an
unbounded browser-driven loop.  A second terminal attempt stays failed and is
reported as such.

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
