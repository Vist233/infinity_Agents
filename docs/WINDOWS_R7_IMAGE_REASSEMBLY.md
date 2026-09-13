# Windows r7 image staging verification

This runbook is for the interrupted private-image staging path. It is
verification-only by default. It does not restart a Worker, change a Compose
file, read an env file, or delete an existing archive.

## Fixed input contract

The expected archive is the locally verified amd64 r7 image:

| Field | Expected value |
| --- | --- |
| Piece prefix | `infinity-agents-worker-r7-8m-piece-part-` |
| Accepted pieces | `part-000` through `part-048` (49 total) |
| Full piece size | `8,388,608` bytes |
| Final piece size | `3,929,088` bytes |
| Archive size | `406,582,272` bytes |
| Archive SHA-256 | `bdd3073f097da34d3226ea1f2d9b6182d0b5fa1bf9ede54412d4b2950a623774` |
| Archive filename | `infinity-agents-worker-r7-canonical.tar` |

An earlier bounded report counted 40 `part-*` entries. A later independent
listing found only the 8 MiB `part-000` file plus an older, differently named
partial file (`infinity-agents-worker-r7-piece-000`). These observations must
not be merged by assumption. The script accepts only the fixed names above,
prints the exact candidate names and byte counts, and rejects missing,
unexpected, or incorrectly sized pieces.

## Safe execution on Windows

From the repository checkout, first run verification without Docker:

```powershell
powershell -NoProfile -File .\scripts\reassemble-r7-worker-image.ps1 `
  -StagingDirectory C:\Users\86138\InfinityAgentsWorkers
```

The script reuses an existing archive only when its size and SHA-256 already
match. Otherwise it writes a uniquely named temporary candidate, concatenates
the exact ordered pieces, verifies the candidate size and hash, and performs a
non-overwriting move. A failed or incomplete run cannot replace an existing
archive.

Only after the verification output matches the fixed contract may the operator
explicitly request the Docker load step:

```powershell
powershell -NoProfile -File .\scripts\reassemble-r7-worker-image.ps1 `
  -StagingDirectory C:\Users\86138\InfinityAgentsWorkers `
  -LoadDocker
```

`-LoadDocker` is the only mutating operation in the script beyond creating the
verified archive. It runs after the full SHA-256 check and does not recreate
either Worker. A separate, reviewed deployment step must pin the loaded image
and verify both containers before any live Task is considered.

The companion offline contract test is
`tests/test_windows_r7_reassembly_contract.py`. It covers the 49-piece layout,
the 40-piece incomplete snapshot, the legacy filename exclusion, and the
hash-before-load/non-overwrite guard. No SSH, registry, Docker daemon, or
production data is needed to run it.
