# C4 Follow-up Card — Expired D1 Lease Recovery

## Finding

The first C4 candidate renewed leases and fenced stale Workers, but had no
Cloudflare-side scheduler to transition an expired `claimed/running` Attempt.
A crashed Worker could therefore leave a Task permanently unavailable.

## Fix

`cloudflare-worker/src/lease-recovery.ts` now scans bounded expired public
Attempts. One D1 batch atomically:

1. marks the Attempt `expired`;
2. requeues the Task when attempts remain, or marks it failed/cancelled;
3. writes the corresponding Task Event and Redis Outbox hint.

`src/index.ts` runs this recovery before the scheduled Outbox flush. A second
recovery run cannot update the same active Attempt because the status and active
lease predicates no longer match.

## Boundary

This is D1-only state recovery. It does not add PostgreSQL, a Redis queue
authority, a second Worker consumer, or a verifier.
