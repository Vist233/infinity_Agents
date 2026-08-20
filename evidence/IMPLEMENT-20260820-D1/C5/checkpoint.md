# C5 checkpoint — partial

- Current branch HEAD: `849d44f`
- Deployed code candidate: `cc88c73`

- Status: `PARTIAL`
- D1 migration: passed remotely
- Edge v2 deployment: passed; latest version `489d6721-1075-44cb-9b42-b77c233708a9`
- zhangbot Redis Relay: health endpoint and process boundary pass, but authenticated `/v1/hints`
  currently returns `503 REDIS_UNAVAILABLE`; Redis user `api` lacks the `infinity-public:*` key
  pattern and Lua scripting permission. The exact ACL correction is awaiting explicit authorization
  before changing the shared service.
- Local Worker 3 v2: image built from `backend/Dockerfile.worker`; `connect` returned `200`,
  `poll` returned `200`, and the container remained running through the Relay outage. The first
  run exposed and fixed an uninitialized-hints crash; the regression test now passes.
- Task Center direct-route repair: passed local unit/E2E gates and deployed; direct creation now
  uses `/api/tasks/direct`, while unauthenticated direct creation returns 401
- Worker credential Namespace boundary: passed frontend unit/type/build gates and deployed; client
  recovery/rotation sends only Worker ID, while unauthenticated recovery returns 401
- GHCR multi-architecture image: GitHub Actions run `32354521182` succeeded after the local Worker
  crash fix; current `v1` manifest digest is
  `sha256:c20e098a2a96be9fb36480a8bcb922aab0d50087f80a68239f4fb26a333fd43c`.
- Real Docker/Claude Case 2: blocked by the missing authenticated queued input; the local Worker
  is now available, but the online browser Task Center was client-blocked during this run
- Real Docker/Claude Case 3: blocked by the same gate
- Browser UI: not claimed; both available browser surfaces returned client-side blocking
- GHCR: complete for the current image candidate; named Tunnel and final C7 publish gate remain
  pending

Do not report C5 as complete until the two real cases produce and download their R2 Artifacts,
with D1 Attempt/Event records, SHA-256 evidence, multipart evidence where applicable, and cleared
Worker attempt directories.
