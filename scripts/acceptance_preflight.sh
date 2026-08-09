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
: "${ACCEPTANCE_REDIS_PASSWORD:?ACCEPTANCE_REDIS_PASSWORD is required}"
: "${ACCEPTANCE_REDIS_NAMESPACE:?ACCEPTANCE_REDIS_NAMESPACE is required}"

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
for service_name in outbox worker-a worker-b; do
  if grep -qx "$service_name" <<<"$running_services"; then
    echo "Preflight must run before Outbox/Worker start: $service_name" >&2
    exit 1
  fi
done

task_counts="$("${COMPOSE[@]}" exec -T postgres psql \
  -U "$ACCEPTANCE_POSTGRES_USER" -d "$ACCEPTANCE_POSTGRES_DB" -Atc \
  "SELECT (CASE WHEN to_regclass('public.tasks') IS NULL THEN 0 ELSE (SELECT count(*) FROM tasks) END)::text || ':' || (CASE WHEN to_regclass('public.outbox_events') IS NULL THEN 0 ELSE (SELECT count(*) FROM outbox_events) END)::text;")"
if [[ "$task_counts" != "0:0" ]]; then
  echo "Acceptance database is not empty: tasks/outbox=$task_counts" >&2
  exit 1
fi

task_stream="${ACCEPTANCE_REDIS_NAMESPACE}:stream:tasks:execute"
event_stream="${ACCEPTANCE_REDIS_NAMESPACE}:stream:task-events"
task_stream_length="$("${COMPOSE[@]}" exec -T redis redis-cli --user api -a "$ACCEPTANCE_REDIS_PASSWORD" --raw XLEN "$task_stream" 2>/dev/null || true)"
event_stream_length="$("${COMPOSE[@]}" exec -T redis redis-cli --user api -a "$ACCEPTANCE_REDIS_PASSWORD" --raw XLEN "$event_stream" 2>/dev/null || true)"
if [[ "${task_stream_length:-0}" != "0" || "${event_stream_length:-0}" != "0" ]]; then
  echo "Acceptance Redis streams are not empty: task=$task_stream_length event=$event_stream_length" >&2
  exit 1
fi

WORKSPACE_DIR="$PROJECT_ROOT/workspace/$ACCEPTANCE_RUN_ID"
for relative_dir in task-inputs task-outputs; do
  target_dir="$WORKSPACE_DIR/$relative_dir"
  if [[ -d "$target_dir" ]] && find "$target_dir" -mindepth 1 -print -quit | grep -q .; then
    echo "Acceptance workspace is not empty: $relative_dir" >&2
    exit 1
  fi
done

echo "acceptance-preflight: PASS"
echo "run_id=$ACCEPTANCE_RUN_ID"
echo "database_tasks=0"
echo "database_outbox=0"
echo "redis_task_stream_length=0"
echo "redis_event_stream_length=0"
echo "workers=stopped"
