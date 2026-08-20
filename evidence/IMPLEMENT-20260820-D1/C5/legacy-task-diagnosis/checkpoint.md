# CHECKPOINT IMPLEMENT-20260820-D1 / C5 / legacy-task-diagnosis

- baseline commit: `d3d499f`
- current commit: pending documentation commit
- main Agent: Codex
- sub Agent review: pending final C7; no sub Agent used for this read-only diagnosis
- completed outcome: historical Task `4350...` is present and failed through the legacy
  `worker_attempts` path; it is not current v2 evidence and is not reusable
- modified files: `HANDOFF.md` and this evidence card
- tests and exit codes: recorded in `tests-and-exit-codes.txt`; all read-only queries exit 0
- failed/skipped tests: none for this card
- PostgreSQL state: not accessed
- Redis state: not modified
- Docker state: not modified
- browser verification: not applicable
- Artifact paths and hashes: none
- secret scan: PASS
- remaining risks: real v2 Case 2/3 still need a newly created queued Task
- rollback commit: `d3d499f`
- next exact card: run real Case 2 through the local v2 Worker after an authenticated Task exists
- external systems modified: none; D1 was read-only

