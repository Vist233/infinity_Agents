# EXEC-S0-05: freeze a redacted scientific fixture manifest

## Control

- run_id: `IMPLEMENT-20260809-01`
- primary_executor: current Codex runtime; exact model ID is not exposed to the workspace
- stage: `S0`
- baseline_commit: `c4a3c4fc4aafe9e6de37677ba7147b4c0cd6da35`
- risk: `R1`

## One outcome

Record the three local scientific fixtures with relative contracts, file counts,
tree hashes, required outputs, and verifier expectations without copying user
paths or fixture contents.

## Acceptance

- all three fixture directories were present
- manifest includes a relative-path-only policy
- tree hashes were computed from sorted relative-file SHA-256 lines
- expected outputs match the observed fixture layout

## Rollback

Remove the manifest/evidence directory; no source fixture or external state was changed.
