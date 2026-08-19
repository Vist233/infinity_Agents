# Execution Card P6 / CARD-02 — lease-scoped multipart upload state

## Result

PostgreSQL now records large-result upload sessions and individual parts. The
Worker role receives only the columns needed to create/delete a session or
advance its timestamps; RLS requires the current Worker, current active
Attempt, and an active lease. Acceptance preflight includes both new tables.

The database policy does not carry the lease token in session context, so the
API SQL also compares the server-authenticated lease token at session creation,
part insertion/update, deletion, and finalization. This closes the race where
the same Worker ID remains active after a lease is fenced.

## Modified files

- `backend/db.py`
- `scripts/rls_roles.sql`
- `scripts/acceptance_preflight.sh`
- `tests/test_artifact_multipart_contract.py`

## Verification

- Multipart schema/path/RLS contract tests — **8 passed**, exit 0.
- `git diff --check` — exit 0.
- Python compile check — exit 0.
- Secret scan of the new diff — no credential/provider secret literal.
- Read-only review attempts were started but did not return before the
  bounded review window; the main Agent performed the documented review and
  corrected active-Attempt, lease-token, and symlink issues before commit.

## External systems

No PostgreSQL, Redis, Docker, Cloudflare, remote repository, credential, or
production database was modified.
