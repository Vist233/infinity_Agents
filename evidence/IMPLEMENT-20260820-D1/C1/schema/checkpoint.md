# C1 Checkpoint

## Status

**Complete.** D1 now has a forward canonical schema and the browser task write
path records Task/idempotency/Event/Outbox atomically. Browser task detail and
artifact access remain owner-scoped. The migration was replayed successfully in
SQLite and the Cloudflare suite is green at 48 tests.

## Required C2 work

Implement the v2 HTTPS control plane against these tables. It must authenticate
the persistent credential by hash, enforce one active session per Worker,
reject forged Namespace/Pool/Provider/trust fields, claim with a D1 conditional
update and fencing epoch, authorize spec/input/artifact calls to the active
Attempt, and expose no owner-wide browser data to a Worker.
