# Infinity Agents Edge

Cloudflare Worker edge for the Infinity Agents Analysis/Coding web application
and the isolated ImageJudge API. It is an OIDC relying party for
`https://auth.zhangyvjing.com`,
keeps browser sessions in the Infinity D1 database, and proxies model/tool
calls without exposing upstream API keys to clients.

## Endpoints

- `GET /health`
- `GET /auth/login`
- `GET /auth/callback`
- `POST /auth/logout`
- `GET /api/me` (authenticated)
- `GET /api/sessions` (authenticated)
- `POST /api/sessions` (authenticated)
- `GET /api/sessions/:id/messages` (authenticated)
- `PATCH /api/sessions/:id/title` (authenticated)
- `DELETE /api/sessions/:id` (authenticated)
- `POST /api/chat` (authenticated SSE stream)

Analysis/Coding task control uses the same authenticated browser session:

- `GET /api/projects/default`
- `POST /api/method-sources/upload`
- `POST /api/dataset-snapshots/upload`
- `POST /api/task-specs` and `POST /api/task-specs/:id/freeze`
- `POST /api/dataset-snapshots`
- `POST/GET /api/tasks`, `POST /api/tasks/direct`, `GET /api/tasks/:id` (the
  generic `POST /api/tasks` requires an Agent confirmation; the authenticated
  Task Center uses the dedicated direct route)
- `GET/POST /api/worker-enrollments` and `POST /api/worker-enrollments/:id/revoke`
- `POST /api/tasks/:id/cancel`
- `GET /api/tasks/:id/events` and `/events/stream`
- `GET /api/tasks/:id/artifacts` and `GET /api/artifacts/:id`

Task creation has two equivalent entry points that use the same TaskSpec and
Task API:

1. The Analysis conversation can call `request_task_creation`; its inline card
   keeps the Agent confirmation ID and resumes the conversation after submit.
2. The Task Center has a direct creation card. It sends the same uploads and
   TaskSpec/Task function path to `/api/tasks/direct` with
   `agent_confirmation=false`, a fresh idempotency key, and no chat
   confirmation row. It does not call the Agent again. The generic task route
   does not accept a caller-supplied Task Center source flag.

## Worker Control API

The Task Center's collapsed “Add Worker” card creates a persistent machine
registration through the authenticated `POST /api/worker-enrollments` endpoint.
Only `namespace` is supplied by the browser. Namespace is reusable, so one
user can create multiple Worker IDs in the same scope. The server assigns the
trust level from the verified Zhang Auth role: only a superuser receives
`owner_trusted`; ordinary users and students receive `institution_trusted`.
The server returns a non-expiring opaque credential once for local setup:

```text
POST /api/worker-enrollments
{ "namespace": "infinity" }
→ { "worker_id": "...", "namespace": "infinity", "worker_credential": "...",
    "credential_expires_at": null, "persistent": true, "one_time": false }
```

The raw credential is never stored as plaintext in D1 or returned by the list
endpoint. `worker_registrations` stores its SHA-256 digest plus an AES-GCM
encrypted copy; the encryption key is the `WORKER_CREDENTIAL_ENCRYPTION_KEY`
Cloudflare Secret and never enters D1, the browser bundle, or logs. The owner
can explicitly retrieve or rotate the persistent credential through the
authenticated Task Center API. It must not be committed or placed in a browser
bundle.

Before polling, a persistent Worker performs a reverse handshake. D1 keeps one
short lease per `worker_id + namespace`; a second active instance using the same
credential receives `WORKER_ALREADY_CONNECTED`. The session expires without
revoking the durable credential when a machine stops. The control flow is:

```text
POST /api/worker/v1/connect
POST /api/worker/v1/heartbeat
GET  /api/worker/v1/health
POST /api/worker/v1/poll
POST /api/worker/v1/offers/:offer_id/accept
POST /api/worker/v1/attempts/:attempt_id/heartbeat
GET  /api/worker/v1/attempts/:attempt_id/resources/:resource_id
POST /api/worker/v1/attempts/:attempt_id/artifacts
POST /api/worker/v1/attempts/:attempt_id/artifacts/multipart/init
PUT  /api/worker/v1/attempts/:attempt_id/artifacts/:artifact_id/parts/:part_number
POST /api/worker/v1/attempts/:attempt_id/artifacts/:artifact_id/multipart/complete
POST /api/worker/v1/attempts/:attempt_id/finalize
GET  /api/worker/v1/verifier/pending                         (trusted verifier only)
GET  /api/worker/v1/verifier/artifacts/:artifact_id          (trusted verifier only)
POST /api/worker/v1/verifier/attempts/:attempt_id/publish  (trusted verifier only)
```

Every Attempt is bound to `worker_id + task_id + fencing_epoch`; expired or
revoked Workers cannot renew a lease or finalize an Artifact. Inputs are read
through exact Attempt-scoped URLs, and uploaded results remain in R2
quarantine after Worker finalize. Worker finalize returns
`verification_pending`; only a separately authenticated verifier holding the
private `WORKER_VERIFIER_TOKEN` can independently validate and publish a
user-visible Artifact. If that verifier secret is not configured, no Worker
can self-promote an arbitrary result to `succeeded`. The Worker receives no D1
or R2 parent credential. Redis and provider settings are local Worker settings;
only non-secret capability flags and the provider model name cross the handshake.

The local verifier is a separate Docker service. It polls the two verifier-only
endpoints, streams each quarantine ZIP to its own temporary volume, validates
the SHA-256, size, ZIP CRCs, duplicate/path-traversal entries, and symlinks,
then calls the publish endpoint. The execution Workers never receive the
verifier token. Once published, the ordinary authenticated task artifact API
and the Task Center download action can read the result from R2.

### macOS / Windows bootstrap client

`worker-client.mjs` is a dependency-free Node 18+ HTTPS client for both macOS
and Windows. Configure a persistent registration without putting the raw
credential in shell history:

```sh
export INFINITY_WORKER_CREDENTIAL='credential-from-task-center'
node worker-client.mjs configure \
  --control-url https://infinity.zhangyvjing.com \
  --worker-id worker-from-task-center \
  --namespace infinity
node worker-client.mjs connect
node worker-client.mjs health
node worker-client.mjs poll
```

On Windows, set `INFINITY_WORKER_CREDENTIAL` in the Worker service environment and
apply a Windows ACL granting only that service account access to the config
file. The control endpoint is HTTPS-only. The client config can also hold local
`REDIS_URL`, `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`,
`ANTHROPIC_BASE_URL`, and `ANTHROPIC_MODEL` values; only boolean capability
signals and the non-secret model name are sent during the handshake. The older
`enroll` command and `/api/worker/v1/enroll` endpoint remain only as a legacy
one-time bootstrap path while pre-existing clients are migrated.

### Local Docker execution

`docker-compose.cloudflare-workers.yml` starts two local Docker Workers without
PostgreSQL or a second Redis container. Each service uses a separate local env
file with `CONTROL_BASE_URL`, one server-created Worker ID and credential, a
unique `WORKER_INSTANCE_ID`, the existing remote `REDIS_URL`, and the provider
variables inherited from the user's local shell. The Worker downloads exact
Attempt resources over HTTPS, invokes the Claude Code CLI directly inside that
same container with Goal-Driven instructions, and uploads results to R2
quarantine. It never mounts the host Docker socket and never starts Docker
inside Docker. None of the Redis or provider secrets are sent to Cloudflare.
Each Worker has isolated input/output named volumes; after one Attempt the
task-local files are removed and Compose restarts the container for the next
cycle. Results up to 20 MB use the single upload endpoint; larger results use
8 MB R2 Multipart parts and are checked for contiguous parts, total size, and
object size before finalize.

When `verifier.cloudflare.env` exists, the same bootstrap also starts the
separate `verifier` service. It is the only local process that uses
`WORKER_VERIFIER_TOKEN`; it has no Docker socket and does not execute Claude
Code. Without that file, execution Workers can still run and submit quarantine
artifacts, but the web download remains intentionally gated.

ImageJudge uses the same Worker under an isolated `/image-judge/*` namespace:

- `GET /image-judge/healthz`
- `GET /image-judge/desktop/authorize`
- `GET /image-judge/auth/callback`
- `POST /image-judge/desktop/token`
- `POST /image-judge/desktop/refresh`
- `POST /image-judge/desktop/logout`
- `POST /image-judge/api/v1/evaluate`

## Deployment

Run these commands from the `cloudflare-deploy` branch. The frontend build is
required first because Wrangler uploads `../frontend/out` as the Worker asset
directory. `--remote` is intentional: production D1 migrations must be
applied to the configured Cloudflare databases, never to a local preview.

```sh
cd frontend
npm ci
CLOUDFLARE_EXPORT=1 npm run build

cd ../cloudflare-worker
npm ci
npm run check
npm test
npx wrangler d1 migrations apply infinity-agents-db --remote
npx wrangler d1 migrations apply image-judge-db --remote
npx wrangler deploy
```

Before the first production deploy, configure secrets interactively. Do not
put their values in `wrangler.jsonc`, `.env` files, the frontend bundle, or
the Git repository:

```sh
npx wrangler secret put STEPFUN_API_KEY
npx wrangler secret put ZHANG_AUTH_CLIENT_SECRET
npx wrangler secret put WORKER_ENROLLMENT_ADMIN_USER_IDS
npx wrangler secret put IMAGE_JUDGE_ZHANG_AUTH_CLIENT_SECRET
npx wrangler secret put IMAGE_JUDGE_TOKEN_SIGNING_SECRET
npx wrangler secret put IMAGE_JUDGE_DASHSCOPE_API_KEY
```

`WORKER_VERIFIER_TOKEN` is configured only when the separate Docker verifier is
running. The execution Workers never receive this secret: they finalize into
`verification_pending`, while the verifier checks and publishes the result.
If the verifier is stopped, the secret may remain configured but no new result
is promoted. Redis on `zhangbot` is intentionally not a Worker binding: the
deployed Worker uses D1/R2 only, while the local execution Workers use the
existing Redis service.

After deploy, run the read-only smoke checks below and record the version ID
shown by Wrangler:

```sh
curl -fsS https://infinity.zhangyvjing.com/health
curl -fsS https://infinity.zhangyvjing.com/image-judge/healthz
curl -fsSI https://infinity.zhangyvjing.com/
curl -fsSI https://infinity.zhangyvjing.com/code-agent/
curl -fsSI https://infinity.zhangyvjing.com/code-agent/tasks/
curl -fsSI https://infinity.zhangyvjing.com/image-judge/
```

The macOS/Windows client joins after the authenticated Task Center has created
the persistent registration. Do not commit the returned credential. Verify
the registration, `health`, `poll`, and revoke behavior; multiple Worker IDs
may share one Namespace.

The deployed Worker needs these Analysis/Coding secrets:

- `STEPFUN_API_KEY`: StepFun Coding Plan key.
- `ZHANG_AUTH_CLIENT_SECRET`: confidential secret for client `infinity-agents`.

The callback is fixed to `https://infinity.zhangyvjing.com/auth/callback`. The
Worker stores the provider access/refresh tokens server-side and validates the
access token against the configured Zhang Auth JWKS before every protected API
request. Browser cookies contain only an opaque session identifier.

ImageJudge has separate `IMAGE_JUDGE_DB`, `IMAGE_JUDGE_KV`,
`IMAGE_JUDGE_USER_LOCK`, migrations, and `IMAGE_JUDGE_*` secrets. Its Zhang Auth
callback is `https://infinity.zhangyvjing.com/image-judge/auth/callback`. The
platform model secret is intentionally unset while local BYOK validation is in
progress; the endpoint returns `PLATFORM_MODEL_NOT_CONFIGURED` instead of
retrying.
