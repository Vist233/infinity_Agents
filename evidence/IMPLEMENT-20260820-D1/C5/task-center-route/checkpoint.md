# CHECKPOINT IMPLEMENT-20260820-D1 / C5 / task-center-route

- baseline commit: `424ccb5`
- current commit: this card commit (the commit that contains this checkpoint)
- main Agent: Codex
- sub Agent review: not run; final read-only review is reserved for C7
- completed outcome: direct Task Center creation now reaches the Edge direct route and the local
  browser test verifies the real request path and payload.
- modified files: `frontend/lib/api/tasks.ts`, `frontend/e2e/code-agent.spec.ts`,
  `frontend/lib/api/tasks.test.ts`, and this evidence card
- tests and exit codes: see `tests-and-exit-codes.txt`
- failed/skipped tests: none in the final gate
- PostgreSQL state: not used; D1 remains the production SQL source
- Redis state: not changed
- Docker state: not changed
- browser verification: local Playwright Task Center suite 6/6 passed; online browser remains
  blocked by the client and is not claimed as passed
- Artifact paths and hashes: none
- secret scan: passed; see `secret-scan.txt`
- remaining risks: real remote Docker/Claude Case 2/3, Relay recovery, named Tunnel, online C6 and
  final C7 review remain incomplete
- rollback commit: `424ccb5`
- next exact card: real remote Worker Case 2 with an authenticated queued D1 Task
- external systems modified: none by this card
