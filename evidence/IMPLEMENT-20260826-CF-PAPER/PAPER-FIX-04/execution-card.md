# Execution card: IMPLEMENT-20260826-CF-PAPER / PAPER-FIX-04

- baseline branch: `cloudflare-deploy`
- baseline commit: `6d0f6c823c443b299360b8fcfc659c07f8ae3eb4`
- single objective: repair production chat rehydration and durable Paper task
  projection so a real materialization is visible and resumable after stream
  close and browser refresh.
- allowed scope: Worker session-history projection, frontend chat/session
  state, live Paper stream correlation, progress-hook input, focused tests,
  governing design/execution documents, and this evidence directory.
- explicitly out of scope: deployment, remote D1 migration, R2 write,
  Processor/zhangbot, WAF, Secret, Redis, Kimi/provider, browser claim, and
  Git push.
- rollback: revert the local review commit. Preserve all D1 chat events,
  resource metadata, continuations, leases, R2 objects, and production
  configuration.

The card started from a clean worktree after PAPER-FIX-03/PAPER-10 release
postflight. The production reproduction supplied by the coordinator proves
the resource was created; this card addresses only the client/history
projection and selection path.
