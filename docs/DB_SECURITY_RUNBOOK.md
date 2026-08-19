# Local PostgreSQL security profile

> **2026-08-20 架构覆盖说明**：所有 Worker 使用同一公共执行策略。数据库中仍保留
> `trust_level`、`required_trust_level` 等旧列，只为平滑迁移历史表结构；迁移会把它们
> 固定为 `public`，运行时不读取它们，也不会向 API 或 Worker 暴露信任等级。任务的
> owner/project 隔离仍是用户数据可见性边界；专用 issuer 角色只负责 credential 签发的
> 数据库权限隔离，不代表另一种 Worker 执行等级。

`scripts/rls_roles.sql` is the explicit database-security step for a clean
local acceptance database. It creates non-superuser, `NOBYPASSRLS` API,
Worker, server-only credential-issuer, Outbox, and lease-reaper roles, adds project/Task composite references, and forces RLS on the
project, resource, provider, Task, Attempt, Outbox, and Artifact tables.

The application must set the request-scoped `app.user_id` on the same
connection as each API query. A Worker must set both `app.worker_id` and its
persistent credential proof; `app.current_worker_id()` is non-null only when
the digest matches an active enrollment. The Outbox publisher uses the dedicated service role. An unset
context intentionally returns no rows and cannot satisfy a policy. The script
is not run automatically against the existing development database because
legacy rows need an explicit constraint-repair review first.

The acceptance Compose stack already verifies the application-level equivalent
with user-owned Projects, opaque Resource IDs, and cross-user 404 responses.
The SQL profile is the database-level gate required before treating that
application test as a release-level RLS result.

## Acceptance gate

The isolated acceptance stack keeps this migration explicit. Before starting
Outbox or Workers, run:

```bash
set -a; . .env.local; set +a
docker compose --env-file .env.local -f docker-compose.acceptance.yml up -d postgres redis
docker compose --env-file .env.local -f docker-compose.acceptance.yml run --rm migrate
scripts/acceptance_prepare_db_logins.sh .env.local
docker compose --env-file .env.local -f docker-compose.acceptance.yml exec -T postgres \
  psql -U "$ACCEPTANCE_ADMIN_USER" -d "$ACCEPTANCE_POSTGRES_DB" \
  -v RLS_API_LOGIN_ROLE="$ACCEPTANCE_API_DB_USER" \
  -v RLS_TRUST_ISSUER_LOGIN_ROLE="$ACCEPTANCE_TRUST_ISSUER_DB_USER" \
  -v RLS_USER_CONTEXT_SECRET="$ACCEPTANCE_RLS_USER_CONTEXT_SECRET" \
  -v RLS_OUTBOX_LOGIN_ROLE="$ACCEPTANCE_OUTBOX_DB_USER" \
  -v RLS_WORKER_LOGIN_ROLE="$ACCEPTANCE_WORKER_A_DB_USER" \
  -v RLS_WORKER_B_LOGIN_ROLE="$ACCEPTANCE_WORKER_B_DB_USER" \
  -v RLS_WORKER_GATEWAY_LOGIN_ROLE="$ACCEPTANCE_WORKER_GATEWAY_DB_USER" \
  -v RLS_REAPER_LOGIN_ROLE="$ACCEPTANCE_REAPER_DB_USER" \
  -v RLS_ARTIFACT_ROOT="$ARTIFACT_STORAGE_ROOT" \
  -v ON_ERROR_STOP=1 -f /dev/stdin < scripts/rls_roles.sql
docker compose --env-file .env.local -f docker-compose.acceptance.yml up -d api frontend
bash scripts/acceptance_preflight.sh .env.local
docker compose --env-file .env.local -f docker-compose.acceptance.yml up -d --build outbox reaper worker-a worker-b
```

The acceptance frontend is built in a Linux build container before the runtime
container starts. It uses the named `frontend_node_modules` volume so host
macOS native modules are never mounted into the Alpine image. If the local
registry requires authentication, set `ACCEPTANCE_NPMRC` to an absolute path
in `.env.local`; Compose mounts that file read-only only for the build step,
never into the running frontend.

With `ACCEPTANCE_WORKER_ENROLLMENT_REQUIRED=1`, populate
`ACCEPTANCE_WORKER_A_CREDENTIAL` and `ACCEPTANCE_WORKER_B_CREDENTIAL` with the
persistent credentials returned by Add Worker for the two distinct Worker IDs
in the active Namespace. The database stores only credential hashes. Do not
replace this gate with an anonymous or one-time token for an acceptance run.

`ACCEPTANCE_REQUIRE_RLS=1` is the default. The preflight checks the three data-plane roles plus
`infinity_trust_issuer` and `infinity_reaper` (`NOBYPASSRLS`), `FORCE ROW LEVEL SECURITY`,
and at least one policy on every protected table. It also checks that API,
Outbox, Worker-A, Worker-B, and Reaper each use a separate non-superuser,
non-`BYPASSRLS` login with only the managed role it needs. The dedicated Trust
Issuer login is checked the same way. The API's Worker
HTTP gateway uses a separate Worker-role login and pool. Setting it to `0`
is only for a disposable UI-only smoke run and is not an acceptance or
production result.

Run `scripts/acceptance_prepare_db_logins.sh .env.local` as the bootstrap
administrator before applying the SQL profile. The runtime pool is wrapped by
`backend.db_rls.RlsPool` when `DB_RLS_ENABLED=1`; it selects the managed role
from the actor context, injects `app.user_id` or `app.worker_id` plus the
persistent Worker credential on checkout, and resets all actor settings before
release. The server-owned public enrollment path uses a dedicated
`TRUST_ISSUER_DATABASE_URL` login that inherits only
`infinity_trust_issuer`; the ordinary API login is explicitly denied membership
in that role. The API's Worker gateway uses its own Worker-role pool. Worker,
Outbox, Reaper, and Trust Issuer logins
cannot set one another's roles. A deployment must still run the negative
Alice/Bob and no-context probes against the real database; a schema-only
preflight is not sufficient.

## Legacy Worker columns and current public policy

`worker_enrollments.trust_level`, `worker_enrollment_tokens.trust_level`, and
`tasks.required_trust_level` are server-maintained compatibility columns. The
schema migration normalizes every existing value to `public` and adds a fixed
constraint; runtime identity, claim, input, artifact, and finalize code never
uses these columns as a capability decision. New Worker rows always use the
server-owned `public-default` execution pool.

Every credential is persistent, separately revocable, and bound to one active
Worker instance at a time. A signed-in user may request a server-issued
credential and inspect the resulting Worker status, but cannot choose the
Namespace, pool, database, Redis, Provider, trust label, or dispatch policy.
The dedicated `infinity_trust_issuer` login remains because ordinary API
connections must not be able to invoke the protected credential-issuance
function directly; it is a database privilege boundary, not a trust tier.

The owner/project predicates remain deliberately in the user-facing Task API
and the current Worker claim path as a data-visibility boundary. Removing that
predicate would require an explicit cross-user Method/Dataset authorization
contract; it is not safe to infer that change from the single-public-pool
decision.

Worker task policies require a credential-bound active lease for claims,
attempts, events, artifacts, and outbox rows. The status transition keeps the
lease marker until its natural expiry so RLS can validate the terminal row in
the same update; terminal rows are excluded from all data-plane operations.
The `tasks_worker_update_guard` trigger additionally enforces Worker-side
claim/lease/state transitions, prevents lease replacement and arbitrary active
attempt changes, and requires a result artifact to belong to the active attempt.
Worker artifact uploads carry metadata in headers and stream the raw body only
after authentication and lease preflight, avoiding multipart temp-file spooling
for rejected uploads.

The task update trigger is paired with a deferred lifecycle trigger. The
deferred check waits until the claim/retry transaction contains its active
Attempt, durable Task event, and matching Outbox row, so a direct Worker SQL
update cannot commit only a partial state transition. Successful Worker tasks
must reference an artifact, and local artifact metadata must contain the task's
own output namespace without traversal segments. Multipart routes require a
declared `Content-Length` and reject oversized values before framework parsing;
raw Worker artifact uploads remain streamed and separately bounded. An
unbounded chunked multipart body is rejected with HTTP 411 instead of being
handed to the framework parser.

Worker Namespace is the Redis/control-plane cluster boundary. The authenticated
Namespace is written into the RLS connection context, must match the active
enrollment, and the control plane rejects a Worker from a different served
Redis Namespace. One account's active Worker enrollments are bound to one
Namespace; task ownership remains the database isolation boundary inside that
cluster.

Lease recovery runs in the dedicated `backend.code_agent.worker.reaper` service
under `infinity_reaper`, not inside a normal data-plane Worker. Its
RLS policy can select expired claimed/running tasks, mark the related attempt
lost while the lease is still expired, transition the task only to a lease-free
queued/failed state, and append the corresponding recovery event and Outbox
record. The recovery write and its durable notifications are one transaction.
