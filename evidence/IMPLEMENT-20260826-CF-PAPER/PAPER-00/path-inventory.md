# PAPER-00 active path inventory

## Production boundary

- Branch: `cloudflare-deploy`.
- Current baseline: `61adfab9d18e457b076ce8918afc9124124c3273`.
- C7 runtime contract reference: `57f6fb9f4a788d0f2d2111fb2e423b59cfc0df4a`, as recorded by `HANDOFF.md`.
- D1 is the Cloudflare metadata fact source; the `DB` binding points to `infinity-agents-db`.
- R2 is the object source; `RESOURCE_BUCKET` points to `infinity-agents-resources`.
- Redis is only the C7 HTTPS Relay hint/presence/realtime path. The Paper feature currently has no Redis or processor path.
- No PostgreSQL or Hyperdrive path is active for Cloudflare production.

## Active Edge route composition

`cloudflare-worker/src/index.ts` is the single Edge entry point:

- `GET /health` returns the public Edge health response.
- ImageJudge is isolated under `/image-judge/healthz`, `/image-judge/desktop/*`, `/image-judge/auth/*`, and `/image-judge/api/*`.
- Browser authentication uses `GET /auth/login`, `GET /auth/callback`, and CSRF-protected `POST /auth/logout`.
- C7 Worker v2 routes are delegated under `/api/worker/v2/*`: connect, heartbeat, poll, accept, renew, task spec, method/dataset input reads, artifact multipart start/part/complete, fail, and cancelled.
- `/api/worker/v1/*` is explicitly closed with `LEGACY_WORKER_PROTOCOL_DISABLED`.
- Authenticated browser API includes `/api/me`, `/api/settings`, `/api/sessions`, `/api/sessions/:id/messages`, `/api/sessions/:id/title`, `/api/chat`, `/api/chat/task-confirmation/cancel`, task/project/spec/method/dataset routes, task events/cancel/artifacts, artifact reads, and Worker enrollment/public-pool administration routes.
- Other `GET`/`HEAD` requests are static asset requests; task detail URLs are mapped to the static task shell.

## Current D1 schema inventory

The final tables created by `cloudflare-worker/migrations-infinity/0001` through `0016` are:

`auth_sessions`, `chat_sessions`, `chat_messages`, `paper_authorizations`, `paper_cache`, `daily_usage`, `projects`, `task_specs`, `task_resources`, `method_sources`, `dataset_snapshots`, `tasks`, `task_idempotency`, `task_events`, `artifacts`, `worker_enrollments`, `worker_offers`, `worker_attempts`, `chat_task_confirmations`, `chat_request_idempotency`, `worker_registrations`, `user_settings`, `user_access_roles`, `worker_sessions`, `worker_pools`, `worker_admin_events`, `worker_pool_policy`, `workers`, `worker_sessions_runtime`, `task_attempts`, `outbox_events`, `artifact_uploads`, `artifact_upload_parts`, and `c7_artifact_upload_winners`.

The temporary `worker_sessions_runtime_v2` table in migration `0016` is an in-migration replacement table and is not a final application table.

Paper-specific current facts:

- `chat_messages` stores only `session_id`, `role`, `content`, and timestamp; there is no canonical tool-call/result ledger.
- `paper_authorizations` authorizes a `(session_id, ref)` pair surfaced by search.
- `paper_cache` stores JSON/text search and abstract cache data with expiry.
- No `chat_events`, `paper_resources`, `paper_processing_attempts`, or `paper_resource_links` table exists yet.

## Current Paper tools

`cloudflare-worker/src/tools.ts` advertises exactly these model tools:

- `request_task_creation`: creates a confirmation-card draft only.
- `search_paper(query, num_results)`: calls arXiv and PubMed HTTP APIs, normalizes metadata, caches results in D1, and writes legacy `paper_authorizations`.
- `read_paper(ref)`: checks the legacy per-session authorization, then returns arXiv/PubMed abstract and metadata. It does not download or parse a PDF and has no page, image, or resource mode.

The chat loop in `cloudflare-worker/src/chat.ts`:

- reads prior `chat_messages`;
- inserts the new user/final assistant text into `chat_messages`;
- keeps provider tool calls and tool results in the in-request `messages` array;
- emits a lossy `tool_call` SSE event containing only the tool name; and
- has no durable `tool_call`/`tool_result` event replay after refresh.

`cloudflare-worker/src/sessions.ts` returns text-only message history from `GET /api/sessions/:id/messages`.

## Python and Worker boundaries

- The current checkout has no `backend/agent` package or `backend/agent/tools/pdf_extractor.py`; stale legacy imports in `backend/app.py`/`backend/code_agent/analysis_agent.py` refer to paths not present in this C7 production tree.
- `backend/Dockerfile.worker` copies only `claude_runtime.py`, `control_plane.py`, `executor_v2.py`, and `consumer_v2.py` from the v2 Worker path. It has no SQL or Redis client and is not a Paper Processor.
- Therefore Python PaperAgent/PDF behavior is not an active Cloudflare service, database, or storage authority. A later dedicated Processor must be added as a separate fixed-purpose boundary and must not extend the public Claude-Code Worker.

## PAPER-00 gap statement

The current Cloudflare path can search and read abstract-level paper metadata, but it cannot durably record tool calls/results, materialize a PDF into D1 metadata plus R2 objects, process pages/images in a trusted Processor, serve page-scoped text/images, analyze a selected image, or restore a complete tool timeline after refresh. These are the explicit gaps for PAPER-01 through PAPER-10.
