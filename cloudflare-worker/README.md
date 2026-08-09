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
- `POST/GET /api/tasks`, `GET /api/tasks/:id`
- `POST /api/tasks/:id/cancel`
- `GET /api/tasks/:id/events` and `/events/stream`
- `GET /api/tasks/:id/artifacts` and `GET /api/artifacts/:id`

Task creation is an in-conversation handshake, not a permanent page form:

1. Analysis calls `request_task_creation` when the user asks for a background
   task.
2. The Worker stores a short-lived pending confirmation and emits a
   `task_confirmation` SSE event; the frontend renders the card directly under
   that Agent message and closes the stream.
3. After the user supplies the execution document and ZIP dataset, the card
   creates one idempotent queued Task and resumes `POST /api/chat` with the
   confirmation ID and verified task ID.
4. The Worker supplies the queued task as the tool result, and Analysis sends
   the follow-up response. The card remains in the message flow; the Task
   Center is history/status only.

## Worker Control API

An operator first issues a short-lived one-time enrollment token through the
authenticated `POST /api/worker-enrollments` endpoint. The operator ID must be
listed in the private `WORKER_ENROLLMENT_ADMIN_USER_IDS` variable. The Worker
then exchanges that token once:

```text
POST /api/worker/v1/enroll
{ "enrollment_token": "...", "public_key": "...", "version": "...", "capabilities": [...] }
→ { "worker_id": "...", "worker_credential": "...", "credential_expires_at": "..." }
```

The returned credential is an opaque bearer credential; it is stored only as a
hash in D1 and can be revoked by the operator. It must not be committed or
placed in a browser bundle. Subsequent Worker requests use
`Authorization: Bearer <worker_credential>` and the control flow is:

```text
POST /api/worker/v1/poll
POST /api/worker/v1/offers/:offer_id/accept
POST /api/worker/v1/attempts/:attempt_id/heartbeat
GET  /api/worker/v1/attempts/:attempt_id/resources/:resource_id
POST /api/worker/v1/attempts/:attempt_id/artifacts
POST /api/worker/v1/attempts/:attempt_id/finalize
POST /api/worker/v1/verifier/attempts/:attempt_id/publish  (trusted verifier only)
```

Every Attempt is bound to `worker_id + task_id + fencing_epoch`; expired or
revoked Workers cannot renew a lease or finalize an Artifact. Inputs are read
through exact Attempt-scoped URLs, and uploaded results remain in R2
quarantine after Worker finalize. Worker finalize returns
`verification_pending`; only a separately authenticated verifier holding the
private `WORKER_VERIFIER_TOKEN` can independently validate and publish a
user-visible Artifact. If that verifier secret is not configured, no Worker
can self-promote an arbitrary result to `succeeded`. The current Cloudflare
control plane does not expose D1, Redis, R2 parent credentials, or provider
keys to the Worker.

### macOS / Windows bootstrap client

`worker-client.mjs` is a dependency-free Node 18+ HTTPS client for both macOS
and Windows. It keeps the one-time token out of the saved file and stores the
resulting credential under a user-only config path:

```sh
export WORKER_ENROLLMENT_TOKEN='one-time-token-from-the-operator'
node worker-client.mjs enroll \
  --control-url https://infinity.zhangyvjing.com
node worker-client.mjs health
node worker-client.mjs poll
```

On Windows, set `WORKER_ENROLLMENT_TOKEN` in the Worker service environment and
apply a Windows ACL granting only that service account access to the config
file. The enrollment endpoint is HTTPS-only and the client never needs a
Cloudflare account, D1, Redis, R2, Tunnel, Queue, or provider key. An invalid
token smoke test must not be mistaken for a joined Worker.

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
npm run build

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

`WORKER_VERIFIER_TOKEN` must remain unset until an independent verifier service
exists. Worker finalize therefore remains `verification_pending` and cannot
self-publish a user-visible artifact. Redis on `zhangbot` is intentionally
not a Worker binding: the deployed Worker uses D1/R2 only, while a future
Task Relay may reach Redis solely through an outbound Tunnel.

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

The macOS/Windows client joins only after an operator has issued a one-time
token through the authenticated enrollment endpoint. Do not commit the
returned credential or token. Test invalid-token rejection before using a
real token, then verify enrollment, `health`, `poll`, token replay rejection,
and revoke behavior from the operator account.

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
