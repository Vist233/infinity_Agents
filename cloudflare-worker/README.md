# Infinity Agents Edge

This directory contains the Cloudflare browser/authentication edge for Infinity
Agents and the isolated ImageJudge API. It is not the execution runtime. The
production Worker is the image built from `backend/Dockerfile.worker` and is
started by Compose with administrator-provided PostgreSQL, Redis, Worker ID,
credential, Namespace, and local Provider settings.

## Edge endpoints

- `GET /health`
- `GET /auth/login`
- `GET /auth/callback`
- `POST /auth/logout`
- `GET /api/me` (authenticated)
- `GET/POST /api/sessions` and session message/title/delete routes
- `POST /api/chat` (authenticated SSE stream used by the Analysis workspace)
- `/image-judge/*` desktop authorization, token, logout, health, and evaluate
  routes

The edge also contains the current authenticated browser task and persistent
Worker-registration handlers in `src/tasks.ts`. Those handlers are a migration
boundary while the central PostgreSQL API proxy is completed; they must not be
read as a second production Task fact source. PostgreSQL is the target and
eventual sole source of truth for Task, Attempt, Worker, Event, and Artifact.

The Task Center direct route uses `agent_confirmation=false` and creates a task
without a chat confirmation row. A task is still named from its execution
document, and its only input kinds are `Method` and `Dataset` (25 MB each).

## Retired Worker protocol

The former D1-only HTTPS Worker control implementation and its Node bootstrap
client were removed. The edge deliberately returns:

```text
/api/worker/v1/* → 410 LEGACY_WORKER_PROTOCOL_DISABLED
```

The 410 boundary is covered by Cloudflare tests so an old Worker cannot silently
claim a new task. The repository no longer contains a Cloudflare poll client,
verifier container, Docker socket/Docker-in-Docker path, or one-time enrollment
client.

## Unified Docker Worker

The long-lived Worker loop is:

```text
PostgreSQL/Redis hint
→ claim with lease + fencing
→ download Method + Dataset
→ fixed Goal-Driven Claude Code runtime
→ upload Artifact (single request or multipart)
→ checksum/manifest/finalize in PostgreSQL
→ clean task directory
→ wait for the next task
```

Use the image-only Compose template from the repository root. It never builds
source during deployment and requires a local tag or immutable image digest:

```sh
export WORKER_IMAGE='infinity-agent-worker@sha256:<verified-digest>'
export WORKER_ID='<server-issued-worker-id>'
export WORKER_CREDENTIAL='<server-issued-persistent-credential>'
export WORKER_DATABASE_URL='<administrator-provided PostgreSQL URL>'
export WORKER_REDIS_URL='<administrator-provided Redis URL>'
export REDIS_NAMESPACE='<administrator-provided namespace>'
docker compose -f docker-compose.cloudflare-workers.yml up -d worker-b
docker compose -f docker-compose.cloudflare-workers.yml logs -f worker-b
```

Provider keys, `ANTHROPIC_BASE_URL`, and `ANTHROPIC_MODEL` stay in the local
Worker environment. They are not sent to the Cloudflare bundle. The image does
not contain Docker CLI, Docker daemon, or `/var/run/docker.sock`; Claude Code
runs directly inside the Worker container as the dedicated non-root runtime
user.

## Checks

```sh
npm ci
npm run check
npm test
```

The old `/api/worker/v1/*` tests are negative compatibility tests only. They do
not prove the central PostgreSQL/Redis Worker path; that path requires the
central API, real PostgreSQL/Redis, a server-issued credential, and the real
Case 2/Case 3 acceptance run.
