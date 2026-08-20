# EXEC-C5-LOCAL-WORKER: local D1 Worker survives Relay outage

## Control

- run_id: `IMPLEMENT-20260820-D1`
- stage: `C5`
- baseline_commit: `b623530`
- allowed external systems: local Docker, read-only Cloudflare D1, existing zhangbot Relay health/hints
- external writes excluded: no D1 mutation, no Redis ACL change, no manual Task insertion

## One outcome

Build and run the single production Worker image locally, establish a real v2 session against the
Cloudflare Edge, and prove that Relay 503 or a transient control-plane transport error does not
terminate the Worker or stop D1 polling.

## Acceptance

- positive: local v2 `connect`, `heartbeat`, and `poll` return successful HTTP responses;
- resilience: Relay `/v1/hints` may return 503 while the Worker remains running and continues polling;
- resilience: a transient control-plane TLS/transport error is retried without a container restart;
- regression: the uninitialized-hints and transport-retry paths have focused tests;
- non-goals: this card does not claim Case 2/3, Artifact upload, or a browser-created queued Task.
