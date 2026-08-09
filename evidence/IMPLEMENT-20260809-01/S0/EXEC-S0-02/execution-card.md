# EXEC-S0-02: make real regression fixtures portable and strict

## Control

- run_id: `IMPLEMENT-20260809-01`
- primary_executor: current Codex runtime; exact model ID is not exposed to the workspace
- stage: `S0`
- baseline_commit: `c4a3c4fc4aafe9e6de37677ba7147b4c0cd6da35`
- risk: `R1`

## One outcome

Real Docker regression tests use `GOAL_DRIVEN_FIXTURE_ROOT` and only accept a
successful `done` event.

## Scope

- files changed: `tests/test_regression.py`, `backend/code_agent/service.py`
- files read-only: Worker runtime implementation and fixture contents
- external systems: no writes; focused pytest checks only

## Acceptance

- no legacy iCloud path remains in the changed harness
- missing fixture root produces explicit skips
- configured fixture cases are resolved from the environment
- an `error` event cannot satisfy the real Docker test
- focused non-integration regression: 3 passed
- focused integration selection without configured root: 3 skipped

## Rollback

Reverse the two-file patch; no schema, data, or external state was changed.
