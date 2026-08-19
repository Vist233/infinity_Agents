# Execution Card P6 / CARD-03 — multipart result transfer and finalize

## Result

The API exposes authenticated start/part/complete/abort endpoints. Each part
is streamed to a dedicated staging directory, checked for declared size and
SHA-256, and recorded in PostgreSQL. Complete rechecks every part hash,
concatenates without loading the archive into memory, validates the ZIP,
manifest, paths, regular-file metadata, size/ratio limits, and secret content,
then atomically inserts the Artifact and marks the upload completed in one
database transaction. Failed publication removes the destination and staging
files when the lease still permits database cleanup.

The Worker chooses multipart only above the server threshold, hashes and
streams each part, validates the server response, and attempts lease-bound
abort cleanup on transfer failure. Small results continue using the existing
raw streaming endpoint.

## Modified files

- `backend/app.py`
- `backend/code_agent/worker/executor.py`
- `tests/test_artifact_multipart_worker.py`

## Verification

- Multipart API/helper and Worker transfer tests — **20 passed**, exit 0.
- Full Python suite after the final path/fencing corrections — **321 passed,
  45 skipped**, exit 0.
- `python -m py_compile backend/app.py backend/code_agent/worker/executor.py` — exit 0.
- `git diff --check` — exit 0.
- Secret scan of the new diff — no credential/provider secret literal.

## Remaining P6 gate

The real multipart path still needs to be exercised in the PostgreSQL + Redis
+ Docker Worker integration run (P9), including a downloaded Artifact hash and
post-task directory cleanup. No manual success or fixture executor is counted.

## External systems

No PostgreSQL, Redis, Docker, Cloudflare, remote repository, credential, or
production database was modified.
