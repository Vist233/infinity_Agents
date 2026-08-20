# CHECKPOINT IMPLEMENT-20260820-D1 / C5 / namespace-client-boundary

- baseline commit: `0fa4534`
- current commit: this card commit (the commit that contains this checkpoint)
- main Agent: Codex
- sub Agent review: not run; final read-only review is reserved for C7
- completed outcome: client credential recovery/rotation no longer sends Namespace; server remains
  the sole source of Pool/Namespace values.
- modified files: `frontend/lib/api/tasks.ts`, `frontend/components/tasks/WorkerEnrollmentPanel.tsx`,
  `frontend/lib/api/tasks.test.ts`, and this evidence card
- tests and exit codes: see `tests-and-exit-codes.txt`
- failed/skipped tests: none in the final gate
- PostgreSQL state: not used; Cloudflare D1 remains the production SQL source
- Redis state: not changed
- Docker state: not changed
- browser verification: previous local Task Center suite 6/6 passed; this card changes only the
  credential URL boundary
- Artifact paths and hashes: none
- secret scan: passed; see `secret-scan.txt`
- remaining risks: real remote Docker/Claude Case 2/3, Redis outage/replay, named Tunnel, online
  browser C6 and final C7 review
- rollback commit: `0fa4534`
- next exact card: connect an actual remote Docker Worker and run Case 2 through D1/R2/Relay/Claude
- external systems modified: none yet; deployment follows after this commit
