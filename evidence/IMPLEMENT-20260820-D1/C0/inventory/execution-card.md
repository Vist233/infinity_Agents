# C0 Execution Card — D1 + zhangbot Redis Worker Runtime

## Objective

Freeze the `cloudflare-deploy` baseline and inventory every production path that
can create, claim, execute, update, stream, or publish a task. The target is the
2026-08-20 D1/Redis ADR, not the historical PostgreSQL acceptance chain.

## Scope and safety boundary

- Branch: `cloudflare-deploy` only.
- Baseline: `be4024e` (`docs: constrain continuation to cloudflare deploy`).
- Worktree: `/Users/zhangyvjing/Code/infinity_Agents`; clean at the start.
- No remote D1 migration, zhangbot SSH change, Worker restart, GHCR push,
  Cloudflare deploy, or GitHub push is performed by C0.
- Historical PostgreSQL code is inventoried but is not deleted until the D1
  replacement has tests and a call-graph proof in C4.
- The seven authoritative documents were read in the required order before
  this card was written.

## Inventory and disposition

| Area | Current implementation | Target disposition | Evidence / next stage |
|---|---|---|---|
| Cloudflare entrypoint | `cloudflare-worker/src/index.ts` routes browser `/api/*`; `/api/worker/v1/*` returns 410; no v2 route | Keep browser routing; add isolated Worker v2 router with Worker auth, fixed protocol, and no browser session dependency | C2 |
| Browser task API | `cloudflare-worker/src/tasks.ts` uses D1 for task inputs/spec/tasks/events/artifact metadata and owner filters | Keep user-facing task surface; refactor into canonical D1 tables and batch Task/Event/Outbox writes; preserve owner/project isolation | C1/C6 |
| Worker registration | `tasks.ts` + migrations `0007`–`0013`; legacy trust levels, user/public split, recoverable credentials, old session shape | Migrate to one `public-default` pool, server-issued persistent credentials, role-independent Worker execution; lock/remove obsolete trust and private-pool paths after replacement | C1/C2 |
| D1 schema | `migrations-infinity/0001`–`0013`; has tasks/resources/artifacts and additive old Worker tables, but no canonical Attempt/Outbox/streaming upload contract for v2 | Add one forward D1 migration; use SQLite/D1 semantics and prepared conditional updates; retain old migrations as history | C1 |
| Worker v2 control plane | Absent; old Python API under `backend/app.py` is the active Worker gateway | Implement `/api/worker/v2/connect`, heartbeat, poll, accept, renew, spec/input, artifact multipart, fail/cancelled in the Cloudflare Worker | C2 |
| Python Worker consumer | `backend/code_agent/worker/consumer.py` opens `asyncpg` from `DATABASE_URL`, consumes Redis Stream, and claims via PostgreSQL/RLS | Replace production loop with HTTPS v2 calls plus Redis hints; no SQL client, no owner-filtered claim, no raw Redis admin access | C4 |
| Python task executor | `backend/code_agent/worker/executor.py` reads PostgreSQL rows/files, calls old attempt gateway, and uploads through old API; direct Claude runtime is already present | Reuse the direct Claude/cleanup core; change input/spec/status/artifact transport to v2 and R2 object protocol | C4 |
| Goal-driven runtime | `backend/code_agent/worker/claude_runtime.py` builds the platform-owned Goal-Driven prompt and runs Claude Code as non-root child | Keep and test as the only runtime; pass the frozen TaskSpec/Method/Dataset contract supplied by v2 | C4/C5 |
| Redis | `backend/code_agent/redis_client.py` directly uses Redis Streams, progress keys, heartbeats and rate-limit keys; `backend/code_agent/outbox.py` publishes from PostgreSQL | Replace Worker data-plane access with a fixed signed hint/event protocol; Redis remains reconstructible coordination only | C3/C4 |
| zhangbot Redis Relay | No Relay implementation or deployment artifact exists in this branch | Add a minimal authenticated HTTPS Relay on zhangbot; fixed event schema, signature/replay/idempotency, no raw command/key/user-data API | C3 (remote rollout only with explicit authorization) |
| Artifact storage | Cloudflare has `RESOURCE_BUCKET` R2 binding and direct task resource upload; Python path also has local filesystem artifact roots and multipart endpoints | Canonicalize Method/Dataset/Artifact objects in R2 with D1 metadata; finalize checks attempt/lease/fencing/size/hash/manifest | C1/C2/C4 |
| Docker image | `backend/Dockerfile.worker` installs Claude Code and runs `consumer.py`; no Docker socket/DinD is mounted | Keep one image/runtime; update entrypoint/config to v2; publish only after local/remote acceptance authorization | C4/C5 |
| Compose | `docker-compose.cloudflare-workers.yml`, `docker-compose.acceptance.yml`, and `docker-compose.local.yml` still inject PostgreSQL/Redis URLs and old protocol settings | Update only after v2 is proven; remove PostgreSQL/old RLS/old queue from the production Worker service, not prematurely from historical tests | C4 |
| Tests | Cloudflare tests cover old task/registration behavior; Python tests cover old PostgreSQL/RLS plus direct runtime contracts | Add D1 fake/conformance and v2 protocol tests; mark old PG tests historical; real Case 2/3 is release evidence only after C5 | C1–C7 |
| Frontend | Worker UI consumes old enrollment/list/status routes; task UI consumes browser task routes | Keep UI product shape; update only API contracts needed for public pool, arbitrary Worker count, status, artifact and isolation | C6 |

## Explicit current gaps

1. There is no v2 Worker protocol in the deployed Cloudflare Worker.
2. The production-shaped Docker Worker still requires PostgreSQL and directly
   claims against the old Python data plane.
3. A zhangbot HTTPS Redis Relay does not exist.
4. D1 currently contains legacy trust/private-worker concepts that conflict
   with one public pool and must be normalized, then removed or locked.
5. The current Cloudflare and Python test suites do not prove the D1 + Relay +
   R2 + real Docker chain.
6. Cloudflare Node dependencies are not installed in this checkout, so the
   TypeScript test and typecheck commands cannot yet run; this is an environment
   prerequisite, not a passing result.

## C0 exit criteria

- Baseline branch, commit, worktree, and clean status recorded.
- All seven required design/runbook documents read.
- Task, Worker, D1, Redis, Relay, R2, Docker, runtime, and test paths listed.
- Each path has a keep/migrate/delete disposition and next stage.
- No production or remote state changed.
