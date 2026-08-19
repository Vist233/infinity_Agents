# Execution Card P0 / CARD-02 — remove obsolete local Worker code

## Result

The local branch now has one executable Worker path: `consumer.py` dispatches
to `executor.py`, which invokes the direct Claude Code runtime in the
long-lived `Dockerfile.worker` image. The old nested-Docker, Cloudflare-only
client, fixture executor, and unused code-agent stream were deleted after
their call sites were checked and their relevant coverage was moved to the
unified runtime contract tests.

## Verification

- Python compile and full suite: **301 passed, 45 skipped**.
- Focused cleanup/runtime gate: **24 passed, 3 skipped**.
- Local unified Worker image built successfully.
- `claude --version`: `2.1.226 (Claude Code)`.
- Container has no `docker` command and no `/var/run/docker.sock`.
- Backend compile inside the image succeeded.

## Boundary

No PostgreSQL, Redis, Cloudflare, GHCR, or remote Worker was modified. The
local test image is only a disposable verification tag; no container was left
running.
