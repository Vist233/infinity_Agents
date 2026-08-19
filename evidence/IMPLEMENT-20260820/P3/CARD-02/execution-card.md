# Execution Card P3 / CARD-02

## Result

The browser no longer supplies a Worker Namespace. The control plane generates
the public-pool Worker ID and persistent credential, stores a credential hash
plus an encrypted recovery copy, and exposes status only for the authenticated
creator. The UI keeps credential recovery/rotation controls while removing the
old trust-level and user-selected Namespace fields.

## Modified files

- `backend/app.py`
- `backend/db.py`
- `backend/worker_enrollment.py`
- `scripts/rls_roles.sql`
- `frontend/components/tasks/WorkerEnrollmentPanel.tsx`
- `frontend/components/tasks/PublicWorkerAdminPanel.tsx`
- `frontend/lib/api/tasks.ts`

## Verification

- `pytest -q tests/test_worker_enrollment.py tests/test_claude_runtime.py tests/test_goal_driven_cases.py tests/test_task_ownership.py` — **20 passed**, exit 0.
- `python -m compileall -q backend` — exit 0.
- `git diff --check` — exit 0 before commit.
- Current commit: `d86d142 feat: persist server-owned public worker credentials`.

## Boundary

The encrypted recovery value is decrypted only for the credential owner. It is
not returned in status payloads, is not used as a Worker database capability,
and no Namespace, pool, endpoint, Provider, or trust field is accepted from the
browser request.

## Remaining P3 item

Public-pool scheduling must still be explicitly reviewed before changing the
existing owner/trust claim predicate to allow a Worker to claim another
user's task. No cross-user execution permission was widened by this card.
