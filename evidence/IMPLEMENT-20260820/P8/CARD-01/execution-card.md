# Execution Card P8 / CARD-01 — image-only Worker packaging and local cleanup

## Scope

This card closes only local packaging and repository cleanup. It does not publish
GHCR, push GitHub, deploy Cloudflare, touch online PostgreSQL/Redis, or start a
Worker container.

## Completed changes

- `docker-compose.cloudflare-workers.yml` is image-only and requires an explicit
  local tag or immutable image digest; it no longer builds source during a
  deployment start.
- `docker-compose.local.yml` uses the same image-only rule for local Worker,
  Outbox, and Reaper services.
- The image check workflow validates both `linux/amd64` and `linux/arm64`
  without publishing.
- `backend/Dockerfile.worker` remains the sole Worker image entry. It contains
  Claude Code but no Docker CLI, Docker daemon, or Docker socket.
- Removed the unreferenced Cloudflare D1/HTTPS execution implementation:
  `cloudflare-worker/src/worker-control.ts`, `cloudflare-worker/worker-client.mjs`,
  and its orphaned `worker-client.test.mjs`.
- Updated the Worker handoff, public-pool runbook, edge README, root handoff,
  and current architecture notes so they no longer instruct users to run the
  deleted Node poll client, old `--build` flow, or D1-only Worker route.
- Updated `scripts/run_local_cloudflare_workers.sh` to inject the current
  `WORKER_REDIS_URL` and call the image-only Compose file; removed the orphaned
  `docker-compose.cloudflare-workers.remote-redis.yml` override.
- Retained D1 migrations and 410 negative tests as migration/compatibility
  evidence. The live `src/tasks.ts` handler is not deleted because the central
  PostgreSQL edge proxy is still an open P7 item; deleting it now would remove
  the current browser task route without an approved replacement.

## Local image evidence

| Check | Result |
|---|---|
| Docker server | 29.6.2 |
| Build definition | `backend/Dockerfile.worker` |
| Claude Code | `2.1.226 (Claude Code)` |
| amd64 build | exit 0; local image `infinity-agent-worker:p8-amd64`; image ID `sha256:b8a7b35c1a56c257cea39ded14afa038d537fb65d9dde8b030ab743463d28143` |
| amd64 runtime boundary | exit 0; `runtime-boundary-ok` |
| multi-arch build | exit 0; `linux/amd64,linux/arm64`; manifest list `sha256:770112b5581b75487ece9567f225320f05d13697a9e48683003cc0a96e732979` |
| OCI evidence | `/private/tmp/infinity-agent-worker-p8.oci.tar`, 1,696,704,512 bytes, SHA-256 `90d5cd1bd6e0b75f2d2cc7707d1a9c181a73a6267fef7fa378dc72c45669792f` |
| image env scan | only non-secret runtime configuration; no credential/provider value supplied |
| Compose Cloudflare config | exit 0 |
| Compose local config | exit 0 with example file and non-secret placeholder credentials |

The first boundary command used a login shell and produced a false `python not
found` because `/etc/profile` replaced the virtualenv PATH. The corrected
non-login runtime command passed; no image change was needed.

## Tests and exit codes

```text
cloudflare-worker: npm test       -> 44 passed, exit 0
cloudflare-worker: npm run check -> exit 0
frontend: npm run test:unit      -> 41 passed, exit 0
frontend: npm run typecheck      -> exit 0
backend: pyenv shell Agent; python -m pytest -q -> 321 passed, 45 skipped, exit 0
git diff --check                  -> exit 0
bash -n scripts/run_local_cloudflare_workers.sh -> exit 0
Cloudflare regression after bootstrap cleanup -> 44 passed, exit 0
```

The frontend test output contains the pre-existing React `act(...)` warnings;
there are no test failures.

## Local state and cleanup boundary

- No container was created by this card.
- An existing user container named `infinity-agent-worker-b` was observed as
  already running with image `infinity-agent-worker:cloudflare`; it was not
  stopped, restarted, or deleted.
- The local Docker cache contains the P8 test tags and OCI tarball; these are
  disposable build artifacts, not deployed credentials or running services.
- No online database, Redis, Cloudflare, GitHub, or GHCR state was modified.
