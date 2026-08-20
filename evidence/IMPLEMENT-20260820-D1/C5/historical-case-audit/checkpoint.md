# CHECKPOINT IMPLEMENT-20260820-D1 / C5 / historical-case-audit

- baseline commit: `b21d6f1`
- current commit: this card commit (the commit that contains this checkpoint)
- main Agent: Codex
- sub Agent review: not run; final read-only review is reserved for C7
- completed outcome: existing succeeded Case 2/3 rows are explicitly classified as historical and
  excluded from current C5 evidence.
- modified files: this evidence card only
- tests and exit codes: see `tests-and-exit-codes.txt`
- failed/skipped tests: none; this is a read-only evidence audit
- PostgreSQL state: not used; D1 remains the production SQL source
- Redis state: not changed
- Docker state: not changed
- browser verification: not applicable
- Artifact paths and hashes: historical hashes were observed but are not accepted as current C5
  evidence because the associated protocol/spec/finalize chain is legacy
- secret scan: passed; see `secret-scan.txt`
- remaining risks: an authenticated Task Center submission and a reachable remote Docker/Claude
  Worker are still required for current Case 2/3
- rollback commit: `b21d6f1`
- next exact card: run current Case 2 through v2 on the actual remote Worker host
- external systems modified: none
