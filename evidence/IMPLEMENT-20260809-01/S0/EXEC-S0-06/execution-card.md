# EXEC-S0-06: add a non-destructive acceptance preflight

## Control

- run_id: `IMPLEMENT-20260809-01`
- primary_executor: current Codex runtime; exact model ID is not exposed to the workspace
- stage: `S0`
- baseline_commit: `c4a3c4fc4aafe9e6de37677ba7147b4c0cd6da35`
- risk: `R1`

## One outcome

Provide `scripts/acceptance_preflight.sh` to verify an explicitly configured
acceptance environment before task submission, without starting, stopping, or
cleaning containers.

## Acceptance

- shell syntax check: exit 0
- missing env file negative check: exit 2 with actionable guidance
- checks include compose validity, required API stack, stopped Outbox/Workers,
  empty PG Task/Outbox, empty namespaced Redis streams, and empty task input/output roots
- script output never prints passwords or provider credentials

## Current limitation

The positive runtime check is pending a user-created `.env.local` and an
acceptance stack startup; the existing development namespace is intentionally
not used as a substitute.

## Rollback

Remove `scripts/acceptance_preflight.sh`; no external state was changed.
