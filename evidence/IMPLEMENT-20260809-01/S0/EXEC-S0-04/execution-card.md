# EXEC-S0-04: add an isolated local acceptance stack

## Control

- run_id: `IMPLEMENT-20260809-01`
- primary_executor: current Codex runtime; exact model ID is not exposed to the workspace
- stage: `S0`
- baseline_commit: `c4a3c4fc4aafe9e6de37677ba7147b4c0cd6da35`
- risk: `R2`

## One outcome

Add a reviewable acceptance compose configuration with independent PostgreSQL,
password-protected Redis, API, Frontend, Outbox, Worker A/B, and
`workspace/<RUN_ID>` storage.

## Scope

- files added: `.env.local.example`, `docker-compose.acceptance.yml`, `backend/Dockerfile.api`, `frontend/Dockerfile.acceptance`
- files changed: none in the existing local compose
- external systems: compose config validation only; no container start/stop

## Frozen boundaries

- Redis namespace is supplied by `RUN_ID`
- service ports bind to loopback only
- fixture root is an explicit environment value; no machine path is embedded
- Worker Docker Socket mounts are clearly marked local-only and remain an L8 security blocker

## Acceptance

- `docker compose --env-file .env.local.example -f docker-compose.acceptance.yml config --quiet`: exit 0
- expanded configuration shows unique workspace/namespace paths and loopback ports
- no existing containers or user namespace were started, stopped, or changed

## Rollback

Remove the four added configuration files; no schema, data, or external state was changed.
