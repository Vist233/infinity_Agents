# EXEC-S0-03: isolate Redis streams and short-lived keys by namespace

## Control

- run_id: `IMPLEMENT-20260809-01`
- primary_executor: current Codex runtime; exact model ID is not exposed to the workspace
- stage: `S0`
- baseline_commit: `c4a3c4fc4aafe9e6de37677ba7147b4c0cd6da35`
- risk: `R1`

## One outcome

`REDIS_NAMESPACE` scopes task/event streams, consumer groups, progress keys,
worker heartbeats, and rate-limit keys. Empty namespace keeps legacy local
names unchanged.

## Scope

- files changed: `backend/code_agent/redis_client.py`, `backend/code_agent/outbox.py`, `backend/code_agent/worker/consumer.py`
- files read-only: database schema, frontend, Docker compose, user data
- external systems: no writes

## Acceptance

- namespaced import smoke: PASS
- Redis/SSE/retry/rate-limit focused tests: 20 passed, exit 0
- default namespace behavior remains backward-compatible by construction

## Rollback

Reverse the three-file patch; no schema, data, or external state was changed.
