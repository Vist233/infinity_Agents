# EXEC-S0-07: bring up an isolated local acceptance stack

## Control

- run_id: `IMPLEMENT-20260809-01`
- primary_executor: current Codex runtime; exact model ID is not exposed to the workspace
- stage: `S0`
- baseline_commit: `c4a3c4fc4aafe9e6de37677ba7147b4c0cd6da35`
- risk: `R1`

## One outcome

Provide a repeatable local stack with isolated PostgreSQL, password-protected
Redis, API, and frontend services, while keeping Outbox and Workers stopped
until the preflight succeeds.

## Acceptance

- Compose configuration validates with exit 0.
- The stack uses a fresh acceptance RUN_ID, namespaced Redis keys, isolated
  workspace paths, and loopback-only API/frontend ports.
- API and frontend are running; Outbox and both Workers are stopped.
- The positive preflight passes with zero tasks, zero Outbox rows, zero task and
  event stream entries, and empty acceptance input/output roots.
- The frontend is served from a verified host-built Next bundle; no private npm
  credential is copied into an image or evidence file.

## Boundary

The Worker path remains intentionally unstarted. The compose file still marks
the Docker Socket mount as local acceptance only; a controlled Executor is a
later L8 requirement.

## Rollback

Stop only the acceptance project and remove its local RUN_ID workspace when the
user explicitly requests cleanup. Existing development containers and data
were not stopped or modified.
