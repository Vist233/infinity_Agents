# Execution card: IMPLEMENT-20260826-CF-PAPER / PAPER-FIX-03

- baseline branch: `cloudflare-deploy`
- baseline commit: `cc00064e058bd87236f0f4929d3ee4cb7cbd8e59`
- single objective: add a durable authenticated frontend Paper progress/task
  surface driven by the FIX-02 read model and existing continuation action.
- allowed scope: frontend Paper timeline derivation, progress polling/reconnect
  hook, safe task card, continuation SSE consumption, Analysis controller and
  workspace integration, focused UI/API/E2E tests, governing design/execution
  documents, and this evidence directory.
- explicitly out of scope: Cloudflare or zhangbot writes, deployment, remote
  D1 migrations, R2 writes, Processor/WAF/Redis/Secret changes, browser claim,
  production acceptance, and Git push.
- rollback: revert the local review commit or remove the frontend projection.
  Preserve D1/R2 resources, continuation rows, leases, chat history, and all
  Processor/Cloudflare state.

The card was started from a clean worktree after PAPER-FIX-02 acceptance.  The
server read model remains authoritative; the browser stores only bounded
correlation/progress state and may submit only the existing session-bound
continuation action.
