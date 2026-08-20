# CHECKPOINT IMPLEMENT-20260820-D1 / C5 / publish

- baseline commit: `f86b566`
- current commit: this card commit (the commit that contains this checkpoint)
- main Agent: Codex
- sub Agent review: not run; final read-only review is reserved for C7
- completed outcome: Cloudflare Edge version `cf1bc7d5-7ec9-4c52-a68d-90e4dcb0d3c6` is serving the
  tested candidate; Edge and Relay health checks are green and the direct Task route remains
  authenticated.
- modified files: this evidence card only
- tests and exit codes: see `tests-and-exit-codes.txt`
- failed/skipped tests: none in the release gate
- PostgreSQL state: not used; Cloudflare D1 remains the production SQL source
- Redis state: Relay health 200; no business event was injected
- Docker state: no Worker container was started locally
- browser verification: local browser suite had already passed 6/6; online browser UI is still
  blocked by the client and is not claimed as passed
- Artifact paths and hashes: none; real Case 2/3 still pending
- secret scan: passed; see `secret-scan.txt`
- remaining risks: remote Worker host, authenticated Case 2/3, Redis outage/replay, named Tunnel,
  online C6 and final C7 read-only review
- rollback commit: `424ccb5` for the docs-only state, or `f86b566` for the deployed code candidate
- next exact card: connect an actual remote Docker Worker and run Case 2 through D1/R2/Relay/Claude
- external systems modified: GitHub `cloudflare-deploy` push and Cloudflare Edge deployment
