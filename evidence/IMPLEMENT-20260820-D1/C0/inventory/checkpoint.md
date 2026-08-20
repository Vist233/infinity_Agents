# C0 Checkpoint

## Status

**Complete for inventory only.** The repository is ready to begin C1. The D1
architecture is not yet implemented and no acceptance/deployment claim is made.

## Baseline

- Branch: `cloudflare-deploy`
- Commit: `be4024e`
- Clean worktree before evidence: yes
- Local Python contract subset: 23 passed
- Cloudflare test/typecheck: not run successfully because local `vitest` and
  `tsc` dependencies are absent

## Findings that drive C1

- `cloudflare-worker/src/tasks.ts` is the current D1 browser/legacy Worker
  implementation and contains trust-level and user/public registration paths.
- `cloudflare-worker/src/index.ts` has no Worker v2 route.
- `backend/code_agent/worker/consumer.py` opens PostgreSQL and consumes direct
  Redis Streams; it is not a D1/Relay Worker.
- `cloudflare-worker/src/env.ts` has D1/R2 bindings but no Relay contract.
- `backend/code_agent/worker/claude_runtime.py` is reusable as the sole
  Goal-Driven Claude Code runtime.

## Next checkpoint

C1 must add and test a forward D1 schema that makes Task, Attempt, Worker,
Event, Outbox, and Artifact metadata canonical, enforces one public pool and
browser owner/project isolation, and provides the fields required by the v2
prepared-query state machine. Do not delete the old Python PostgreSQL chain
until C2–C4 prove its replacement.
