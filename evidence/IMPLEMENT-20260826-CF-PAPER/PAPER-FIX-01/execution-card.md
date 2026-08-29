# Execution card: IMPLEMENT-20260826-CF-PAPER / PAPER-FIX-01

- Status: `COMPLETE` for this local implementation card only.
- Branch: `cloudflare-deploy`.
- Baseline commit: `cf41ab96ee5734eb3039da12aeca1ab623bca404`.
- Sole objective: make Paper intent a durable, resumable orchestration rather
  than ordinary assistant prose. A `processing` materialization must create a
  durable request/resource correlation, must not emit final completion, and
  must be able to re-enter the same ready resource for text/image actions.
- Allowed changes: the Edge chat loop, D1 repository/fake-D1/schema tests,
  Paper tool context, exact continuation route, provider prompt, related
  Processor lifecycle assertions, the two governing Paper documents, and this
  card's no-secret evidence.
- Explicitly out of scope: frontend Paper task/progress UI, production
  deployment, browser claim, Cloudflare writes, remote D1 migration, R2
  writes, Processor/zhangbot writes, Redis/Relay/Cloudflared changes, and Git
  push.

## Safety and rollback

The new `0022_paper_request_continuations.sql` migration is additive and is
checked in for a later release; this card did not apply it remotely. The
ledger stores only opaque IDs, bounded state, timestamps, and safe error codes.
PDF/full-text bytes, R2 object keys, provider payloads, credentials, and
secrets remain outside it. The route derives resource/turn scope server-side,
checks session/user/resource ownership, and uses an atomic D1 execution lease.

Rollback for this local card is to revert the review commit(s). If a future
release has already applied the additive migration, retain the table and
metadata and disable/revert the Worker route; do not drop data or manufacture
completion by editing D1.
