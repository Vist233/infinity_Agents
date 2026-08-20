# C2 Execution Card — Worker v2 HTTPS Control Plane

## Delivered

- Added `cloudflare-worker/src/worker-v2.ts` and routed it before browser
  cookie/CSRF authentication in `src/index.ts`.
- Implemented:
  - `POST /api/worker/v2/connect`
  - `POST /heartbeat`
  - `POST /poll`
  - `POST /tasks/:id/accept`
  - `POST /tasks/:id/renew`
  - `GET /tasks/:id/spec`
  - `GET /tasks/:id/inputs/method|dataset`
  - `POST /tasks/:id/artifacts/start`
  - `PUT /artifacts/:upload/parts/:part`
  - `POST /artifacts/:upload/complete`
  - `POST /tasks/:id/fail`
  - `POST /tasks/:id/cancelled`
- Connect authenticates a persistent credential hash from canonical D1 and
  binds one active runtime session to one Worker ID/instance.
- Every non-connect request validates credential, Worker ID, session, protocol,
  runtime capability, image compatibility, pool binding, and session epoch.
- Namespace, Pool, Provider, trust, database, Redis, D1, and R2 administrative
  fields are rejected if supplied by a Worker. The server's public pool policy
  is authoritative.
- Polling does not filter by task owner, so any public Worker can execute any
  queued task; it returns no `created_by` or arbitrary user-resource listing.
- Accept uses a D1 conditional update on task status and lease epoch, then
  records a fenced `task_attempts` row and outbox/event records. A stale
  Worker receives a conflict rather than a second lease.
- Spec/input access requires the current Attempt lease. Input bodies stream
  from R2 and include server-recorded size/hash metadata.
- Artifact upload uses R2 multipart sessions. Each part is streamed through an
  incremental SHA-256 transform; complete re-reads the assembled R2 object and
  independently validates total bytes and SHA-256 before a D1 atomic success
  transition. No verifier process is involved.
- Browser Worker issuance/list/credential/rotate/revoke routes now use
  canonical D1 `workers`; ordinary users receive server-generated public-pool
  credentials and cannot submit a Namespace.

## Test boundary

The R2 test uses an in-memory R2-compatible fake. It proves protocol and
checksum behavior, not a remote R2 account. Remote D1/R2 deployment is a later
authorized C5/release action.

## Safety

No PostgreSQL client, Redis admin connection, zhangbot change, remote D1
migration, Docker restart, GHCR push, Cloudflare deploy, or GitHub push was
performed by C2.
