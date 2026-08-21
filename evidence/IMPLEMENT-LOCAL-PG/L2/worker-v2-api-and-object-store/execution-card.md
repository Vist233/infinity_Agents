# EXEC-L2-01: Local Worker v2 API (FastAPI) and controlled filesystem object store

## Control
- run_id: IMPLEMENT-LOCAL-PG
- primary_executor: single local agent (Lingma)
- stage: L2
- baseline_commit: f7887d9a9a501e9dcd75e3919c6bbcd03781fa8d (main, after L1)
- current_dirty_files: none outside the allowed scope
- risk: R1 (new isolated module and tests only; no active production path touched)

## Authority
- docs/POST_CLOUDFLARE_MAIN_LOCAL_POSTGRESQL_PLAN_2026-08-20.md §L2
- docs/MAIN_LOCAL_COMPONENT_MAP_2026-08-21.md (invariants 1, 2, 3, 4, 5)
- Worker client contract: backend/code_agent/worker/control_plane.py (read-only)
- Cloudflare contract source: cloudflare-worker/src/worker-v2.ts (reference only)

## One outcome
- observable result: the full Worker v2 HTTP lifecycle (connect, heartbeat,
  poll, accept, renew, spec, input stream, artifact start/part/complete)
  passes end-to-end against real PostgreSQL 16 plus the local object store;
  a superseded session, a forbidden infrastructure body field, a checksum
  mismatch and object-key traversal are all rejected.
- explicit non-goals: no Redis (L3), no frontend/auth wiring (L4), no changes
  to the active Cloudflare tree, the cloudflare-deploy branch, or L1 files.

## Scope
- files allowed: backend/local_runtime/** (new files only), tests/test_local_object_store.py, tests/test_local_runtime_api.py
- files read-only: backend/local_runtime/repository.py, migrations.py, sql/0001; backend/code_agent/worker/control_plane.py; cloudflare-worker/src/worker-v2.ts
- files forbidden: everything else
- external systems allowed: isolated local Docker PostgreSQL on 127.0.0.1:25432 only

## Frozen invariants
- Same routes, headers and JSON shapes as the Cloudflare edge contract, so the
  same Docker Worker image runs by pointing WORKER_CONTROL_BASE_URL at this app.
- Bytes live only under the configured object root; the database keeps keys,
  sizes, hashes and publication state.
- Object keys reject traversal, absolute paths, backslashes, colons and symlinks.
- Every attempt-scoped write re-validates session liveness, attempt lease and
  fencing inside a transaction; artifacts publish only after measured size and
  sha256 match the declared values.

## Baseline
- exact checks: HEAD f7887d9, branch main, git status clean before L2.
- known failures: none; L1 suite green.

## Evidence
- tests-and-exit-codes.txt: ruff 0; L2 suite 12 passed (exit 0); regression
  L1 + worker v2 contract suites 12 passed (exit 0); no-DSN run skips PG
  tests (exit 0).
- diff-summary.txt, baseline.txt, secret-scan.txt in this directory.
