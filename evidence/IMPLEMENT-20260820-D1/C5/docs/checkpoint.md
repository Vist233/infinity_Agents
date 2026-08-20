# CHECKPOINT IMPLEMENT-20260820-D1 / C5 / docs

- baseline commit: `3983110eb6c182e7bdef5a360e6116b1178d16cf`
- current commit: this card commit (the commit that contains this checkpoint)
- main Agent: Codex
- sub Agent review: not run; this is a documentation-only C5 card
- completed outcome: D1-only production instructions are now consistent in the continuation plan
  and Cloudflare Edge README.
- modified files: `docs/D1_REDIS_WORKER_CONTINUATION_PLAN_2026-08-20.md`,
  `cloudflare-worker/README.md`, and this evidence card
- tests and exit codes: see `tests-and-exit-codes.txt`
- failed/skipped tests: none for this card
- PostgreSQL state: not used; historical files remain outside the D1 production path
- Redis state: not changed
- Docker state: not changed
- browser verification: not attempted in this documentation card; prior online browser surfaces
  were blocked by the client
- Artifact paths and hashes: none
- secret scan: passed; see `secret-scan.txt`
- remaining risks: real remote Docker/Claude Case 2 and Case 3, Redis recovery, named Relay Tunnel,
  browser C6 and final read-only C7 review remain incomplete
- rollback commit: previous `3983110eb6c182e7bdef5a360e6116b1178d16cf`
- next exact card: C5 remote Worker Case 2 with real D1/R2/Relay/Claude path
- external systems modified: none by this card
