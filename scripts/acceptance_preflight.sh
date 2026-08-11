#!/usr/bin/env bash

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${1:-$PROJECT_ROOT/.env.local}"
COMPOSE_FILE="$PROJECT_ROOT/docker-compose.acceptance.yml"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing acceptance env file: $ENV_FILE" >&2
  echo "Copy .env.local.example to .env.local and fill local-only values." >&2
  exit 2
fi

set -a
# The acceptance env file is local-only and is never emitted by this script.
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

: "${ACCEPTANCE_RUN_ID:?ACCEPTANCE_RUN_ID is required}"
: "${ACCEPTANCE_POSTGRES_DB:?ACCEPTANCE_POSTGRES_DB is required}"
: "${ACCEPTANCE_POSTGRES_USER:?ACCEPTANCE_POSTGRES_USER is required}"
: "${ACCEPTANCE_POSTGRES_PASSWORD:?ACCEPTANCE_POSTGRES_PASSWORD is required}"
: "${ACCEPTANCE_ADMIN_PASSWORD:?ACCEPTANCE_ADMIN_PASSWORD is required}"
: "${ACCEPTANCE_REDIS_PASSWORD:?ACCEPTANCE_REDIS_PASSWORD is required}"
: "${ACCEPTANCE_REDIS_NAMESPACE:?ACCEPTANCE_REDIS_NAMESPACE is required}"
: "${ACCEPTANCE_RLS_USER_CONTEXT_SECRET:?ACCEPTANCE_RLS_USER_CONTEXT_SECRET is required}"
: "${ACCEPTANCE_API_DB_USER:?ACCEPTANCE_API_DB_USER is required}"
: "${ACCEPTANCE_API_DB_PASSWORD:?ACCEPTANCE_API_DB_PASSWORD is required}"
: "${ACCEPTANCE_TRUST_ISSUER_DB_USER:?ACCEPTANCE_TRUST_ISSUER_DB_USER is required}"
: "${ACCEPTANCE_TRUST_ISSUER_DB_PASSWORD:?ACCEPTANCE_TRUST_ISSUER_DB_PASSWORD is required}"
: "${ACCEPTANCE_OUTBOX_DB_USER:?ACCEPTANCE_OUTBOX_DB_USER is required}"
: "${ACCEPTANCE_OUTBOX_DB_PASSWORD:?ACCEPTANCE_OUTBOX_DB_PASSWORD is required}"
: "${ACCEPTANCE_WORKER_A_DB_USER:?ACCEPTANCE_WORKER_A_DB_USER is required}"
: "${ACCEPTANCE_WORKER_A_DB_PASSWORD:?ACCEPTANCE_WORKER_A_DB_PASSWORD is required}"
: "${ACCEPTANCE_WORKER_B_DB_USER:?ACCEPTANCE_WORKER_B_DB_USER is required}"
: "${ACCEPTANCE_WORKER_B_DB_PASSWORD:?ACCEPTANCE_WORKER_B_DB_PASSWORD is required}"
: "${ACCEPTANCE_WORKER_GATEWAY_DB_USER:?ACCEPTANCE_WORKER_GATEWAY_DB_USER is required}"
: "${ACCEPTANCE_WORKER_GATEWAY_DB_PASSWORD:?ACCEPTANCE_WORKER_GATEWAY_DB_PASSWORD is required}"
: "${ACCEPTANCE_REAPER_DB_USER:?ACCEPTANCE_REAPER_DB_USER is required}"
: "${ACCEPTANCE_REAPER_DB_PASSWORD:?ACCEPTANCE_REAPER_DB_PASSWORD is required}"
ACCEPTANCE_REQUIRE_RLS="${ACCEPTANCE_REQUIRE_RLS:-1}"
ACCEPTANCE_ALLOW_EXISTING_DATA="${ACCEPTANCE_ALLOW_EXISTING_DATA:-0}"
ACCEPTANCE_ADMIN_USER="${ACCEPTANCE_ADMIN_USER:-$ACCEPTANCE_POSTGRES_USER}"

for service_login in \
  "$ACCEPTANCE_API_DB_USER" "$ACCEPTANCE_OUTBOX_DB_USER" \
  "$ACCEPTANCE_TRUST_ISSUER_DB_USER" \
  "$ACCEPTANCE_WORKER_A_DB_USER" "$ACCEPTANCE_WORKER_B_DB_USER" \
  "$ACCEPTANCE_WORKER_GATEWAY_DB_USER" \
  "$ACCEPTANCE_REAPER_DB_USER"; do
  if [[ "$service_login" == "$ACCEPTANCE_ADMIN_USER" || "$service_login" == "$ACCEPTANCE_POSTGRES_USER" ]]; then
    echo "Acceptance service login must not be the bootstrap/admin login: $service_login" >&2
    exit 2
  fi
done

if [[ ! "$ACCEPTANCE_RUN_ID" =~ ^accept_[A-Za-z0-9_-]+$ ]]; then
  echo "ACCEPTANCE_RUN_ID must start with accept_ and contain only safe characters" >&2
  exit 2
fi
if [[ "$ACCEPTANCE_REDIS_NAMESPACE" != "$ACCEPTANCE_RUN_ID" ]]; then
  echo "ACCEPTANCE_REDIS_NAMESPACE must equal ACCEPTANCE_RUN_ID for acceptance isolation" >&2
  exit 2
fi

COMPOSE=(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE")
"${COMPOSE[@]}" config --quiet

running_services="$("${COMPOSE[@]}" ps --services --filter status=running)"
for service_name in postgres redis api frontend; do
  if ! grep -qx "$service_name" <<<"$running_services"; then
    echo "Required service is not running: $service_name" >&2
    exit 1
  fi
done
for service_name in outbox worker-a worker-b reaper; do
  if grep -qx "$service_name" <<<"$running_services"; then
    echo "Preflight must run before Outbox/Worker start: $service_name" >&2
    exit 1
  fi
done

task_counts="$("${COMPOSE[@]}" exec -T postgres psql \
  -U "$ACCEPTANCE_ADMIN_USER" -d "$ACCEPTANCE_POSTGRES_DB" -Atc \
  "SELECT (CASE WHEN to_regclass('public.tasks') IS NULL THEN 0 ELSE (SELECT count(*) FROM tasks) END)::text || ':' || (CASE WHEN to_regclass('public.outbox_events') IS NULL THEN 0 ELSE (SELECT count(*) FROM outbox_events) END)::text;")"
if [[ "$task_counts" != "0:0" && "$ACCEPTANCE_ALLOW_EXISTING_DATA" != "1" ]]; then
  echo "Acceptance database is not empty: tasks/outbox=$task_counts" >&2
  echo "Set ACCEPTANCE_ALLOW_EXISTING_DATA=1 only for an explicitly retained local run." >&2
  exit 1
fi
if [[ "$task_counts" != "0:0" ]]; then
  echo "acceptance-preflight: retained local data=$task_counts"
fi

if [[ "$ACCEPTANCE_REQUIRE_RLS" == "1" ]]; then
  service_login_status="PASS"
  check_service_login() {
    local login_name="$1"
    local managed_role="$2"
    local allowed_extra_role="${3:-}"
    local result
    if [[ ! "$login_name" =~ ^[A-Za-z_][A-Za-z0-9_]*$ || ! "$managed_role" =~ ^[A-Za-z_][A-Za-z0-9_]*$ || ( -n "$allowed_extra_role" && ! "$allowed_extra_role" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ) ]]; then
      echo "Acceptance service role name is unsafe: $login_name/$managed_role/$allowed_extra_role" >&2
      service_login_status="FAIL"
      return
    fi
    local allowed_roles="'$managed_role'"
    if [[ -n "$allowed_extra_role" ]]; then
      allowed_roles+=" , '$allowed_extra_role'"
    fi
    result="$("${COMPOSE[@]}" exec -T postgres psql \
      -U "$ACCEPTANCE_ADMIN_USER" -d "$ACCEPTANCE_POSTGRES_DB" -Atc \
      "SELECT CASE WHEN EXISTS (
        SELECT 1
        FROM pg_roles login_role
        JOIN pg_auth_members membership ON membership.member = login_role.oid
        JOIN pg_roles managed_role ON managed_role.oid = membership.roleid
        WHERE login_role.rolname = '$login_name'
          AND login_role.rolcanlogin
          AND NOT login_role.rolsuper
          AND NOT login_role.rolbypassrls
          AND managed_role.rolname = '$managed_role'
      ) AND NOT EXISTS (
        SELECT 1
        FROM pg_auth_members extra_members
        JOIN pg_roles extra_login_role ON extra_login_role.oid = extra_members.member
        JOIN pg_roles extra_role ON extra_role.oid = extra_members.roleid
        WHERE extra_members.member = extra_login_role.oid
          AND extra_login_role.rolname = '$login_name'
          AND extra_role.rolname IN ('infinity_api', 'infinity_worker', 'infinity_outbox', 'infinity_trust_issuer', 'infinity_reaper')
          AND extra_role.rolname NOT IN ($allowed_roles)
      ) THEN 'PASS' ELSE 'FAIL' END;")"
    if [[ "$result" != "PASS" ]]; then
      echo "Acceptance service login check failed: $login_name -> $managed_role" >&2
      service_login_status="FAIL"
    fi
  }
  check_service_login "$ACCEPTANCE_TRUST_ISSUER_DB_USER" infinity_trust_issuer
  check_service_login "$ACCEPTANCE_OUTBOX_DB_USER" infinity_outbox
  check_service_login "$ACCEPTANCE_WORKER_A_DB_USER" infinity_worker
  check_service_login "$ACCEPTANCE_WORKER_B_DB_USER" infinity_worker
  check_service_login "$ACCEPTANCE_WORKER_GATEWAY_DB_USER" infinity_worker
  check_service_login "$ACCEPTANCE_REAPER_DB_USER" infinity_reaper

  # This check intentionally runs before Outbox/Workers start. The RLS role
  # script is an operator migration, not an application startup side effect.
  # A clean database must prove that both least-privilege roles exist and
  # that every protected table has FORCE RLS and an explicit policy.
  if [[ "$service_login_status" != "PASS" ]]; then
    rls_status="FAIL:service_logins"
  else
    rls_status="$("${COMPOSE[@]}" exec -T postgres psql \
    -U "$ACCEPTANCE_ADMIN_USER" -d "$ACCEPTANCE_POSTGRES_DB" -v ON_ERROR_STOP=1 -Atc \
    "WITH required_tables(table_name) AS (VALUES
      ('projects'), ('project_members'), ('task_specs'), ('method_sources'),
      ('dataset_snapshots'), ('tasks'), ('task_attempts'), ('task_events'),
      ('outbox_events'), ('artifacts'), ('idempotency_keys'), ('project_resources'),
      ('session_resource_links'), ('provider_profiles'), ('provider_secrets'),
      ('worker_enrollments'), ('worker_enrollment_tokens')),
    role_check AS (
      SELECT count(*) = 5 AS ok,
             COALESCE(bool_and(NOT rolsuper AND NOT rolbypassrls AND NOT rolcreaterole AND NOT rolcreatedb), false) AS safe
      FROM pg_roles
      WHERE rolname IN ('infinity_api', 'infinity_worker', 'infinity_outbox', 'infinity_trust_issuer', 'infinity_reaper')
        AND rolbypassrls = false
    ),
    table_check AS (
      SELECT count(*) = (SELECT count(*) FROM required_tables) AS ok
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN required_tables r ON r.table_name = c.relname
      WHERE n.nspname = 'public' AND c.relrowsecurity AND c.relforcerowsecurity
    ),
    policy_check AS (
      SELECT count(DISTINCT p.tablename) = (SELECT count(*) FROM required_tables) AS ok
      FROM pg_policies p
      JOIN required_tables r ON r.table_name = p.tablename
      WHERE p.schemaname = 'public'
    ),
    trigger_check AS (
      SELECT count(*) = 3 AS ok
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND ((c.relname = 'tasks' AND t.tgname IN ('tasks_worker_update_guard', 'tasks_worker_lifecycle_guard'))
          OR (c.relname = 'artifacts' AND t.tgname = 'artifacts_worker_path_guard'))
        AND NOT t.tgisinternal
    )
    SELECT CASE
      WHEN NOT (SELECT ok FROM role_check) THEN 'FAIL:roles'
      WHEN NOT (SELECT safe FROM role_check) THEN 'FAIL:role_attributes'
      WHEN NOT (SELECT ok FROM table_check) THEN 'FAIL:rls_flags'
      WHEN NOT (SELECT ok FROM policy_check) THEN 'FAIL:policies'
      WHEN NOT (SELECT ok FROM trigger_check) THEN 'FAIL:triggers'
      ELSE 'PASS'
    END;")"
  fi
  if [[ "$rls_status" != "PASS" ]]; then
    echo "Acceptance RLS preflight failed: $rls_status" >&2
    echo "Apply scripts/rls_roles.sql as a database administrator, then rerun preflight." >&2
    exit 1
  fi
else
  rls_status="SKIPPED"
fi

task_stream="${ACCEPTANCE_REDIS_NAMESPACE}:stream:tasks:execute"
event_stream="${ACCEPTANCE_REDIS_NAMESPACE}:stream:task-events"
task_stream_length="$("${COMPOSE[@]}" exec -T redis redis-cli --user api -a "$ACCEPTANCE_REDIS_PASSWORD" --raw XLEN "$task_stream" 2>/dev/null || true)"
event_stream_length="$("${COMPOSE[@]}" exec -T redis redis-cli --user api -a "$ACCEPTANCE_REDIS_PASSWORD" --raw XLEN "$event_stream" 2>/dev/null || true)"
if [[ ("${task_stream_length:-0}" != "0" || "${event_stream_length:-0}" != "0") && "$ACCEPTANCE_ALLOW_EXISTING_DATA" != "1" ]]; then
  echo "Acceptance Redis streams are not empty: task=$task_stream_length event=$event_stream_length" >&2
  exit 1
fi
if [[ "${task_stream_length:-0}" != "0" || "${event_stream_length:-0}" != "0" ]]; then
  echo "acceptance-preflight: retained Redis streams task=$task_stream_length event=$event_stream_length"
fi

WORKSPACE_DIR="$PROJECT_ROOT/workspace/$ACCEPTANCE_RUN_ID"
for relative_dir in api/task-inputs api/task-outputs api/resources worker-a worker-b; do
  target_dir="$WORKSPACE_DIR/$relative_dir"
  if [[ -d "$target_dir" ]] && find "$target_dir" -mindepth 1 -print -quit | grep -q .; then
    echo "Acceptance workspace is not empty: $relative_dir" >&2
    exit 1
  fi
done

echo "acceptance-preflight: PASS"
echo "run_id=$ACCEPTANCE_RUN_ID"
echo "database_tasks=${task_counts%%:*}"
echo "database_outbox=${task_counts##*:}"
echo "rls=$rls_status"
echo "redis_task_stream_length=$task_stream_length"
echo "redis_event_stream_length=$event_stream_length"
echo "workers=stopped"
echo "frontend_proxy=same-origin unless API_PROXY_TARGET is explicitly configured"
