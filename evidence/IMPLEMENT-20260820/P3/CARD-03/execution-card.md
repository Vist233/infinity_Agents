# Execution Card P3 / CARD-03 — remove legacy trust capability branches

## Result

Worker execution authorization no longer treats the legacy `trust_level` value
as a capability. New and authenticated Worker identities use the single
`public-default` execution policy, while the existing owner-scoped claim gate
remains in place until the public-pool cross-user scheduling decision is
explicitly authorized and implemented as a separate card.

## Modified files

- `backend/app.py`
- `backend/code_agent/task_service.py`
- `backend/code_agent/worker/consumer.py`
- `scripts/rls_roles.sql`
- `tests/test_worker_enrollment.py`

## Verification

- `python -m compileall -q backend tests` — exit 0.
- `pytest -q tests/test_task_ownership.py tests/test_worker_enrollment.py tests/test_fault_injection.py tests/test_concurrency_recovery.py tests/test_db_rls.py tests/test_security.py` — **36 passed, 35 skipped**, exit 0.
- `git diff --check` — exit 0.

## Boundary

No cross-user Worker scheduling permission was widened by this card. `created_by`
still controls the current compatibility claim predicate. The remaining public
pool scheduling change requires an explicit authorization checkpoint.
