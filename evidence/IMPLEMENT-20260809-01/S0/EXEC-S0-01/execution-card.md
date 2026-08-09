# EXEC-S0-01: restore deterministic local baseline checks

## Control

- run_id: `IMPLEMENT-20260809-01`
- primary_executor: current Codex runtime; exact model ID is not exposed to the workspace
- stage: `S0`
- baseline_commit: `c4a3c4fc4aafe9e6de37677ba7147b4c0cd6da35`
- risk: `R1`

## One outcome

Frontend deterministic checks run with real exit codes and no lint errors.

## Scope

- files changed: `frontend/test/setup.ts`, `frontend/app/code-agent/tasks/[task_id]/page.tsx`, `frontend/app/image-judge/page.tsx`
- files read-only: all other product and test files
- external systems: none; local test/build commands only

## Acceptance

- `npm run lint`: exit 0; warnings only
- `npm run typecheck`: exit 0
- `npm run test:unit`: 28 passed, exit 0
- `npm run build`: exit 0
- changed-file secret-pattern scan: clean

## Rollback

Reverse the three-file patch; no schema, data, or external state was changed.
