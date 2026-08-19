# Execution Card P2 / CARD-01 — Redis recovery and readiness

## Outcome

Redis is now an explicit dispatch dependency rather than an invisible stale
connection. A broken Redis operation drops the connection so the Worker or
Outbox publisher must reconnect. The publisher refuses to become ready when
Redis cannot be reached, while PostgreSQL Outbox rows remain pending for retry.
The Worker health response reports `status=degraded` and `ready=false` when
Redis is unavailable.

## Scope

- `backend/code_agent/redis_client.py`
- `backend/code_agent/outbox.py`
- `backend/app.py`
- Redis and health regression tests

## Exit criteria

- Redis failures do not mark Outbox rows published.
- Redis failures cannot leave a Worker advertising ready.
- Reconnect is required before the next consume/publish cycle.
