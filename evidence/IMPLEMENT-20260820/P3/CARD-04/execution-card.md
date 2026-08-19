# Execution Card P3 / CARD-04 — remove unused one-time enrollment flow

## Result

The production Python enrollment module now exposes only the persistent
credential path. The unused `EnrollmentToken` model and the unreferenced
`issue_enrollment_token` / `complete_enrollment` functions were removed.
The database token tables remain untouched as migration-era compatibility
objects until a separate schema cleanup card proves that no deployed edge
consumer still depends on them.

## Modified files

- `backend/worker_enrollment.py`

## Verification

- `rg -n "EnrollmentToken|issue_enrollment_token|complete_enrollment" backend tests scripts cloudflare-worker frontend` — no runtime or test references.
- `python -m compileall -q backend tests` — exit 0.
- `pytest -q tests/test_worker_enrollment.py tests/test_security_boundaries.py tests/test_task_ownership.py` — **23 passed**, exit 0.
- `pytest -q` — **302 passed, 45 skipped**, exit 0.
- `git diff --check` — exit 0.

## Boundary

This card does not change Worker credential authority, trust labels, pool
selection, claim scope, or user task visibility. The existing persistent
credential issuance and session authentication paths remain intact.

## External systems

PostgreSQL, Redis, Docker, Cloudflare, and remote repositories were not
modified.
