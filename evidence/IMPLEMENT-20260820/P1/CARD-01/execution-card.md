# Execution Card P1 / CARD-01 — atomic Task submission

## Outcome

Authenticated Task Center and Analysis submission paths now write the Task,
user-scoped idempotency record, initial `task_queued` lifecycle event, and
PostgreSQL Outbox hint in the same database transaction.  A missing lifecycle
event raises and rolls the transaction back.  The two streamed bundle paths
use the same event-before-Outbox ordering.

The legacy `create_task` helper remains only for compatibility tests and is not
the authenticated API path.

## Scope

- `backend/code_agent/task_service.py`
- `backend/app.py`
- `tests/test_task_api.py`

## Exit criteria

- No production authenticated submission path creates an Outbox row outside
  its Task transaction.
- An Outbox payload references the durable Task event.
- The idempotency key remains scoped by `(user_id, resource_type)`.
- Existing user-ownership and bundle cleanup tests remain passing.
