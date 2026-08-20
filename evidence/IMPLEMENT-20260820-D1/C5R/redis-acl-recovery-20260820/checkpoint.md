# CHECKPOINT IMPLEMENT-20260820-D1 / C5R / redis-acl-recovery-20260820

## Status

PASS — authorized Redis recovery and Outbox replay completed.

## Evidence

- Relay hint path returned HTTP 200 before and after the controlled Redis outage.
- While Redis was stopped, the running v2 Worker continued D1 `poll` and `heartbeat` requests with HTTP 200.
- The recovered scheduled Outbox path changed all 10 pending rows to `published`, each with one publish attempt; D1 `task_attempts` remained 4.
- Redis metadata scan found only allowed namespace keys and fixed event fields, with no input, artifact, user body, or secret indicators.
- Production Edge version after secret correction and deploy: `09680075-63b3-41cf-8254-cfcf21772272`.

## Integrity notes

The first manual ACL edit attempt contained shell interpolation damage and Redis correctly refused the invalid configuration. A second repair attempt used an escaped newline incorrectly and was also rejected. Both attempts were immediately repaired before continuing; final ACL was verified, and both Redis and Relay were active. No credential was printed, rotated, or stored in the repository.

## Remaining release gates

- C6 real logged-browser product verification remains open.
- The named Cloudflare Tunnel remains open; the current temporary HTTPS relay path remains unchanged until the named path has DNS and connection proof.
- C7 final deterministic regression and read-only review remain open.
- Case 3 remains `DEFERRED_BY_OWNER`, not PASS.
