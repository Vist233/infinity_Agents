# EXEC-L1-01: PostgreSQL canonical runtime schema and transactional Worker state machine

## Control
- run_id: IMPLEMENT-LOCAL-PG
- primary_executor: single local agent (Lingma)
- stage: L1
- baseline_commit: 1f43a1b4671324e47fff8c03ab83e2bd3c970e6e (main)
- current_dirty_files: .gitignore (adds .local-test/)
- risk: R1 (new isolated schema only; no active production path touched)

## Authority
- docs/POST_CLOUDFLARE_MAIN_LOCAL_POSTGRESQL_PLAN_2026-08-20.md §L1
- docs/MAIN_LOCAL_COMPONENT_MAP_2026-08-21.md (invariants 1, 3, 4, 5)
- Cloudflare contract source: worker-v2.ts session/claim/lease semantics (reference only)

## One outcome
- observable result: five real PostgreSQL integration tests pass against an
  isolated postgres:16-alpine container (empty-DB migration, immutable session
  reconnect, cross-user public claim once, input ownership denial, stale
  session fencing rejection).
- explicit non-goals: no FastAPI endpoints (L2), no Redis (L3), no changes to
  the active Cloudflare tree or old PostgreSQL v1 code.

## Scope
- files allowed: backend/local_runtime/**, tests/test_local_runtime_pg.py
- files read-only: cloudflare-worker/**, backend/code_agent/**
- files forbidden: everything else
- external systems allowed: isolated local Docker PostgreSQL on 127.0.0.1:25432 only

## Frozen invariants
- PostgreSQL is the only source of truth for Task/Attempt/Worker/Session/Event/Outbox/Artifact metadata (new schema `infinity_runtime`, not reusing old v1 tables).
- Browser users are isolated by created_by; public Workers claim without creator filtering.
- One credential = one active instance; expired reconnect creates an immutable new session.
- Every state write re-validates session/attempt/lease/fencing conditions inside a transaction.

## Baseline
- exact checks: HEAD 1f43a1b, branch main, git status shows only the new
  untracked L1 files plus .gitignore tweak.
- known failures: none relevant; L1 tests previously skipped for lack of a DSN.

## Implementation steps
1. Start isolated postgres:16-alpine container bound 127.0.0.1:25432 with a
   generated random password stored only in gitignored .local-test/pg-test.env.
2. Run the five tests with LOCAL_RUNTIME_TEST_DATABASE_URL pointing at it.
3. Fix any SQL/state-machine issue found (none needed: 5/5 passed first run).
4. Ruff lint, no-DSN skip behavior, git diff --check.

## Acceptance
- positive check: `pytest tests/test_local_runtime_pg.py -v` => 5 passed (real PG).
- negative/security check: cross-user dataset reuse raises
  TASK_RESOURCE_OWNERSHIP_INVALID; stale session renew raises
  ATTEMPT_FENCING_REJECTED; concurrent double claim yields exactly one
  attempt/event/outbox row.
- integration check: empty-DB migration applies 0001 once and is repeatable.
- expected state: L1 code committed on main; container left running for L2/L3 reuse.

## Rollback
- code/config: revert the L1 commit; schema lives in isolated test database only.
- schema/data: drop container; no shared database touched.

## Stop conditions
- none hit during this card.
