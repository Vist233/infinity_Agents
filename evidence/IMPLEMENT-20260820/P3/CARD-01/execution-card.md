# Execution Card P3 / CARD-01 — Worker protocol session and local cleanup

## Outcome

The new Worker data plane now records the server-owned execution pool,
protocol/runtime/image metadata, active instance fence, session epoch, ready
state, and last error. A persistent credential can be held by only one live
instance. Old rows start as `legacy-v0` and `ready=false`, so they cannot enter
the new claim/input path until a compatible handshake completes.

The independent Verifier modules and their tests were removed because the
current architecture performs deterministic output, manifest, ZIP, hash,
lease, and fencing checks inside the Worker/data plane; OAuth PKCE verifier
logic and Attempt gateway token verification were intentionally retained.

## Scope

- `backend/db.py`, `backend/db_rls.py`, `scripts/rls_roles.sql`
- `backend/worker_enrollment.py`
- `backend/app.py`
- `backend/code_agent/worker/consumer.py`
- `backend/code_agent/worker/executor.py`
- `backend/code_agent/task_service.py`, `backend/code_agent/models.py`
- Worker compose/env templates and protocol tests
- Removed independent `verifier.py`, `verifier_service.py` and their tests

## Deliberately not completed in this card

The existing owner/trust claim predicate is still present. The requested
public-pool rule that allows a compatible Worker to claim another user's Task
requires an explicit authorization checkpoint because it expands the
cross-user execution scope. The valid-lease input and Artifact boundaries
remain in place.
