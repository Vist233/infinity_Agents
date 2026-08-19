# Execution Card P6 / CARD-01 — validate streamed Worker result archives

## Result

Remote Worker result uploads now require a SHA-256 header and are validated
before publication. The API streams the archive to a bounded staging file,
checks ZIP paths, regular-file metadata, entry count, per-file/total size,
compression ratio, UTF-8 manifest shape, per-file SHA-256, and secret-like
content. It stores only a bounded metadata summary, not arbitrary manifest
metadata. Failed validation removes the staging file. API startup removes only
stale entries under the dedicated `.worker-staging` directory, refusing to
follow that directory if it is a symlink.

## Modified files

- `backend/app.py`
- `backend/code_agent/worker/executor.py`
- `tests/test_artifact_validation.py`
- `tests/test_goal_driven_worker_inputs.py`

## Verification

- Focused Artifact/input/security suite — **31 passed**, exit 0.
- Full Python suite — **311 passed, 45 skipped**, exit 0.
- `python -m compileall -q backend tests` — exit 0.
- `git diff --check` — exit 0.
- Read-only review by Faraday — final P6 review passed; 34 targeted checks reported.

## Boundary

The existing active lease preflight remains before request-body streaming, and
the database insert still repeats lease/fencing protection. This card does not
change Worker task claim scope or user task visibility. Multipart upload for
large results remains a separate card.

## External systems

PostgreSQL, Redis, Docker, Cloudflare, and remote repositories were not
modified.
