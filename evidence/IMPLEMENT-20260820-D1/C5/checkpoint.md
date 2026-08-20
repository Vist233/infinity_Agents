# C5 checkpoint — partial

- Current branch HEAD: `625b6c6` (checkpoint-only commits after the deployed code)
- Deployed code candidate: `cc88c73`

- Status: `PARTIAL`
- D1 migration: passed remotely
- Edge v2 deployment: passed; latest version `489d6721-1075-44cb-9b42-b77c233708a9`
- zhangbot Redis Relay: passed health and process boundary checks
- Worker 3 persistent connect/poll: passed
- Task Center direct-route repair: passed local unit/E2E gates and deployed; direct creation now
  uses `/api/tasks/direct`, while unauthenticated direct creation returns 401
- Worker credential Namespace boundary: passed frontend unit/type/build gates and deployed; client
  recovery/rotation sends only Worker ID, while unauthenticated recovery returns 401
- GHCR multi-architecture image: published as `ghcr.io/vist233/infinity-agent-worker:v1`
  with manifest digest `sha256:16325edb2a6ad962cddaf003d937b8bdc77725857e2f817e4c8abd2fbab0d6c1`
- Real Docker/Claude Case 2: blocked by missing reachable Worker host and real queued input
- Real Docker/Claude Case 3: blocked by the same gate
- Browser UI: not claimed; both available browser surfaces returned client-side blocking
- GHCR: complete for the current image candidate; named Tunnel and final C7 publish gate remain
  pending

Do not report C5 as complete until the two real cases produce and download their R2 Artifacts,
with D1 Attempt/Event records, SHA-256 evidence, multipart evidence where applicable, and cleared
Worker attempt directories.
