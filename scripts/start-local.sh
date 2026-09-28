#!/usr/bin/env bash
# Start the local Infinity Agents processes against an operator-managed
# PostgreSQL service. This script only starts the local application processes.
set -euo pipefail

if command -v pyenv >/dev/null 2>&1; then
  eval "$(pyenv init - bash)"
  pyenv shell Agent
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
cd "$REPO_ROOT"
ENV_FILE="${ENV_FILE:-.env.local}"

if [ ! -f "$ENV_FILE" ]; then
  echo "==> .env.local not found. Copying from .env.local.example ..."
  cp .env.local.example "$ENV_FILE"
  echo "Edit $ENV_FILE if the PostgreSQL connection or local paths differ, then re-run this script."
  exit 1
fi

set -a
# shellcheck disable=SC1091
source "$ENV_FILE"
set +a

export PG_HOST="${PG_HOST:-127.0.0.1}"
export PG_PORT="${PG_PORT:-5432}"
export POSTGRES_DB="${POSTGRES_DB:-infinity_local}"
export POSTGRES_USER="${POSTGRES_USER:-infinity}"
export DATABASE_URL="${DATABASE_URL:-postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD:-}@${PG_HOST}:${PG_PORT}/${POSTGRES_DB}}"
export LOCAL_RUNTIME_DATABASE_URL="${LOCAL_RUNTIME_DATABASE_URL:-$DATABASE_URL}"
export LOCAL_DATA_ROOT="${LOCAL_DATA_ROOT:-$REPO_ROOT/local-data}"
export WORKER_WORK_ROOT="${WORKER_WORK_ROOT:-$REPO_ROOT/local-worker-work}"
export LOCAL_OBJECT_ROOT="${LOCAL_OBJECT_ROOT:-$LOCAL_DATA_ROOT/objects}"
export ARTIFACT_STORAGE_ROOT="${ARTIFACT_STORAGE_ROOT:-$LOCAL_DATA_ROOT/task-outputs}"
export ARTIFACT_DOWNLOAD_ROOT="${ARTIFACT_DOWNLOAD_ROOT:-$LOCAL_DATA_ROOT/task-outputs}"
export METHOD_SOURCE_UPLOAD_ROOT="${METHOD_SOURCE_UPLOAD_ROOT:-$LOCAL_DATA_ROOT/method-sources}"
export DATASET_UPLOAD_ROOT="${DATASET_UPLOAD_ROOT:-$LOCAL_DATA_ROOT/datasets}"
export RESOURCE_STORAGE_ROOT="${RESOURCE_STORAGE_ROOT:-$LOCAL_DATA_ROOT/resources}"
export API_HOST="${API_HOST:-127.0.0.1}"
export API_PORT="${API_PORT:-8008}"
export WORKER_CONTROL_PLANE_URL="${WORKER_CONTROL_PLANE_URL:-http://${API_HOST}:${API_PORT}}"
export API_PROXY_TARGET="${API_PROXY_TARGET:-http://${API_HOST}:${API_PORT}}"

require_absolute() {
  case "$1" in
    /*) ;;
    *) echo "ERROR: $2 must be an absolute path: $1" >&2; exit 1 ;;
  esac
}

reject_symlink_components() {
  local path_value="$1"
  local current="/"
  local remainder="${path_value#/}"
  local component
  IFS='/' read -r -a path_parts <<<"$remainder"
  for component in "${path_parts[@]}"; do
    [ -z "$component" ] && continue
    case "$component" in
      .|..)
        echo "ERROR: path may not contain . or .. components: $path_value" >&2
        exit 1
        ;;
    esac
    current="${current%/}/$component"
    if [ -L "$current" ]; then
      echo "ERROR: refusing symlink path component: $current" >&2
      exit 1
    fi
  done
}

reject_dangerous_root() {
  local root_value="$1"
  local root_real="$2"
  case "$root_real" in
    /|/Users|/private|/private/tmp|/private/var|/tmp|/var|/home|/usr|/bin|/sbin|/System|/Applications|/Library)
      echo "ERROR: refusing broad/system local root: $root_value" >&2
      exit 1
      ;;
  esac
  case "$REPO_ROOT/" in
    "$root_real/"*)
      echo "ERROR: local root may not be an ancestor of the repository: $root_value" >&2
      exit 1
      ;;
  esac
}

write_root_marker() {
  local root_real="$1"
  local kind="$2"
  local marker="$root_real/.infinity-agents-root"
  local expected
  expected="$(printf 'infinity-agents-root-v1\npath=%s\nkind=%s' "$root_real" "$kind")"
  if [ -L "$marker" ]; then
    echo "ERROR: root marker is a symlink: $marker" >&2
    exit 1
  fi
  if [ -e "$marker" ]; then
    if [ ! -f "$marker" ]; then
      echo "ERROR: root marker is not a regular file: $marker" >&2
      exit 1
    fi
    if [ "$(cat "$marker")" != "$expected" ]; then
      echo "ERROR: root marker does not belong to this local installation: $root_real" >&2
      exit 1
    fi
  else
    {
      printf '%s\n' 'infinity-agents-root-v1'
      printf 'path=%s\n' "$root_real"
      printf 'kind=%s\n' "$kind"
    } >"$marker"
  fi
  chmod 600 "$marker" 2>/dev/null || true
}

validate_existing_root_marker() {
  local root_real="$1"
  local kind="$2"
  local marker="$root_real/.infinity-agents-root"
  local expected
  expected="$(printf 'infinity-agents-root-v1\npath=%s\nkind=%s' "$root_real" "$kind")"
  if [ -L "$marker" ] || [ ! -f "$marker" ]; then
    echo "ERROR: $root_real already exists without a matching startup marker; refusing to adopt it or make it deletable." >&2
    echo "       Move existing data to a new path, or use an explicit reviewed migration procedure before retrying." >&2
    exit 1
  fi
  if [ "$(cat "$marker")" != "$expected" ]; then
    echo "ERROR: existing root marker does not belong to this local installation: $root_real" >&2
    exit 1
  fi
}

inspect_managed_root() {
  local root_value="$1"
  local label="$2"
  local kind="$3"
  require_absolute "$root_value" "$label"
  reject_symlink_components "$root_value"
  ROOT_CREATED=0
  if [ -e "$root_value" ] || [ -L "$root_value" ]; then
    if [ -L "$root_value" ] || [ ! -d "$root_value" ]; then
      echo "ERROR: $label must be a real directory, not a symlink or file: $root_value" >&2
      exit 1
    fi
    ROOT_REAL="$(cd "$root_value" && pwd -P)"
    reject_dangerous_root "$root_value" "$ROOT_REAL"
    validate_existing_root_marker "$ROOT_REAL" "$kind"
  else
    # Keep this root uncreated until every pre-existing managed root has been
    # inspected. A missing root may be marked only after mkdir creates it and
    # an immediate empty-directory check succeeds.
    ROOT_CREATED=1
    ROOT_REAL="$root_value"
  fi
}

create_new_managed_root() {
  local root_value="$1"
  local label="$2"
  local kind="$3"
  if [ "$ROOT_CREATED" -ne 1 ]; then
    return 0
  fi
  mkdir -p "$root_value"
  reject_symlink_components "$root_value"
  if [ ! -d "$root_value" ] || [ -L "$root_value" ]; then
    echo "ERROR: newly created $label is not a real directory: $root_value" >&2
    exit 1
  fi
  ROOT_REAL="$(cd "$root_value" && pwd -P)"
  reject_dangerous_root "$root_value" "$ROOT_REAL"

  local dotglob_was_set=0
  local nullglob_was_set=0
  if shopt -q dotglob; then dotglob_was_set=1; fi
  if shopt -q nullglob; then nullglob_was_set=1; fi
  shopt -s dotglob nullglob
  local entries=("$ROOT_REAL"/*)
  if [ "$dotglob_was_set" -eq 0 ]; then shopt -u dotglob; fi
  if [ "$nullglob_was_set" -eq 0 ]; then shopt -u nullglob; fi
  if [ "${#entries[@]}" -ne 0 ]; then
    echo "ERROR: newly created $label is not empty; refusing to write a startup marker: $ROOT_REAL" >&2
    exit 1
  fi
  write_root_marker "$ROOT_REAL" "$kind"
}

# Reject lexical overlap before creating either root. This also prevents a
# missing root from being created beneath the other managed root.
require_absolute "$LOCAL_DATA_ROOT" "LOCAL_DATA_ROOT"
require_absolute "$WORKER_WORK_ROOT" "WORKER_WORK_ROOT"
if [ "$LOCAL_DATA_ROOT" = "$WORKER_WORK_ROOT" ] || \
  [[ "$LOCAL_DATA_ROOT/" == "$WORKER_WORK_ROOT/"* ]] || \
  [[ "$WORKER_WORK_ROOT/" == "$LOCAL_DATA_ROOT/"* ]]; then
  echo "ERROR: LOCAL_DATA_ROOT and WORKER_WORK_ROOT must be separate, non-nested directories" >&2
  exit 1
fi

inspect_managed_root "$LOCAL_DATA_ROOT" "LOCAL_DATA_ROOT" "data"
DATA_CREATED="$ROOT_CREATED"
DATA_REAL="$ROOT_REAL"
inspect_managed_root "$WORKER_WORK_ROOT" "WORKER_WORK_ROOT" "worker"
WORK_CREATED="$ROOT_CREATED"
WORK_REAL="$ROOT_REAL"

ROOT_CREATED="$DATA_CREATED"
create_new_managed_root "$LOCAL_DATA_ROOT" "LOCAL_DATA_ROOT" "data"
DATA_REAL="$(cd "$LOCAL_DATA_ROOT" && pwd -P)"
ROOT_CREATED="$WORK_CREATED"
create_new_managed_root "$WORKER_WORK_ROOT" "WORKER_WORK_ROOT" "worker"
WORK_REAL="$(cd "$WORKER_WORK_ROOT" && pwd -P)"

if [ "$DATA_REAL" = "$WORK_REAL" ] || [[ "$DATA_REAL/" == "$WORK_REAL/"* ]] || [[ "$WORK_REAL/" == "$DATA_REAL/"* ]]; then
  echo "ERROR: LOCAL_DATA_ROOT and WORKER_WORK_ROOT must be separate, non-nested directories" >&2
  exit 1
fi
reject_dangerous_root "$LOCAL_DATA_ROOT" "$DATA_REAL"
reject_dangerous_root "$WORKER_WORK_ROOT" "$WORK_REAL"
if [ ! -w "$DATA_REAL" ] || [ ! -w "$WORK_REAL" ]; then
  echo "ERROR: local data/work roots are not writable by the current user" >&2
  exit 1
fi

for path_value in "$LOCAL_OBJECT_ROOT" \
  "$ARTIFACT_STORAGE_ROOT" "$ARTIFACT_DOWNLOAD_ROOT" "$METHOD_SOURCE_UPLOAD_ROOT" \
  "$DATASET_UPLOAD_ROOT" "$RESOURCE_STORAGE_ROOT"; do
  require_absolute "$path_value" "local storage path"
  reject_symlink_components "$path_value"
  mkdir -p "$path_value"
done

for required_command in pg_isready psql python; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    echo "ERROR: required command not found: $required_command" >&2
    exit 1
  fi
done

echo "==> Checking native PostgreSQL at $PG_HOST:$PG_PORT ..."
if [ -n "${POSTGRES_PASSWORD:-}" ]; then
  PGPASSWORD="$POSTGRES_PASSWORD" pg_isready -h "$PG_HOST" -p "$PG_PORT" -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null
  PGPASSWORD="$POSTGRES_PASSWORD" psql -h "$PG_HOST" -p "$PG_PORT" -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atqc "SELECT current_setting('server_version')" >/dev/null
else
  pg_isready -d "$DATABASE_URL" >/dev/null
  psql "$DATABASE_URL" -Atqc "SELECT current_setting('server_version')" >/dev/null
fi
echo "    PostgreSQL is ready."

echo "==> Running PostgreSQL migrations ..."
python -m backend.db_migrate

if ! command -v claude >/dev/null 2>&1 && [ -z "${CLAUDE_CLI_PATH:-}" ]; then
  echo "ERROR: Claude Code CLI is not on PATH; the Worker cannot run tasks" >&2
  exit 1
fi
if [ "${START_FRONTEND:-1}" != "0" ] && ! command -v npm >/dev/null 2>&1; then
  echo "WARNING: npm is not installed; frontend will not be started" >&2
fi

RUNTIME_DIR="$LOCAL_DATA_ROOT/.runtime"
PID_DIR="$RUNTIME_DIR/pids"
LOG_DIR="$RUNTIME_DIR/logs"
mkdir -p "$PID_DIR" "$LOG_DIR"
if [ "$(uname -s 2>/dev/null || true)" != "Windows_NT" ]; then
  chmod 700 "$RUNTIME_DIR" "$PID_DIR" "$LOG_DIR" 2>/dev/null || true
fi

start_process() {
  local name="$1"
  local directory="$2"
  shift 2
  local pid_file="$PID_DIR/$name.pid"
  local log_file="$LOG_DIR/$name.log"
  local old_pid=""
  local old_started_at=""
  if [ -f "$pid_file" ]; then
    old_pid="$(sed -n '1p' "$pid_file")"
    old_started_at="$(sed -n '2p' "$pid_file")"
  fi
  if [[ "$old_pid" =~ ^[0-9]+$ ]] && kill -0 "$old_pid" 2>/dev/null; then
    local actual_started_at
    actual_started_at="$(ps -p "$old_pid" -o lstart= 2>/dev/null | sed 's/^ *//;s/ *$//')"
    local actual_command
    actual_command="$(ps -p "$old_pid" -o command= 2>/dev/null | sed 's/^ *//;s/ *$//')"
    if [ -n "$old_started_at" ] && [ "$old_started_at" = "$actual_started_at" ]; then
      case "$name:$actual_command" in
        api:*backend.app:app*)
          echo "    $name already running (PID $old_pid)"
          return 0
          ;;
        frontend:*npm\ run\ dev*)
          echo "    $name already running (PID $old_pid)"
          return 0
          ;;
        worker:*backend.code_agent.worker.consumer_v2*)
          echo "    $name already running (PID $old_pid)"
          return 0
          ;;
      esac
    fi
    echo "WARNING: ignoring an unverified $name PID file (PID $old_pid)" >&2
    rm -f "$pid_file"
  fi
  (
    cd "$directory"
    exec "$@"
  ) >>"$log_file" 2>&1 &
  local pid=$!
  local started_at=""
  for _ in $(seq 1 20); do
    started_at="$(ps -p "$pid" -o lstart= 2>/dev/null | sed 's/^ *//;s/ *$//')"
    [ -n "$started_at" ] && break
    sleep 0.05
  done
  if [[ ! "$pid" =~ ^[0-9]+$ ]] || [ -z "$started_at" ]; then
    echo "ERROR: could not record process identity for $name" >&2
    kill -TERM "$pid" 2>/dev/null || true
    return 1
  fi
  printf '%s\n%s\n' "$pid" "$started_at" >"$pid_file"
  chmod 600 "$pid_file" 2>/dev/null || true
  echo "    started $name (PID $pid); log: $log_file"
}

echo "==> Starting the local API ..."
start_process api "$REPO_ROOT" python -m uvicorn backend.app:app --host "$API_HOST" --port "$API_PORT"

if command -v curl >/dev/null 2>&1; then
  for _ in $(seq 1 30); do
    if curl -fsS "http://${API_HOST}:${API_PORT}/health" >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
fi

if [ "${START_FRONTEND:-1}" != "0" ] && command -v npm >/dev/null 2>&1; then
  if [ -d "$REPO_ROOT/frontend/node_modules" ]; then
    echo "==> Starting the local frontend ..."
    start_process frontend "$REPO_ROOT/frontend" npm run dev -- --hostname "${FRONTEND_HOST:-127.0.0.1}" --port "${FRONTEND_PORT:-3000}"
  else
    echo "    Frontend dependencies are not installed; run npm install in frontend, then restart."
  fi
fi

WORKER_ID="${WORKER_1_ID:-${WORKER_ID:-}}"
WORKER_CREDENTIAL_VALUE="${WORKER_1_CREDENTIAL:-${WORKER_CREDENTIAL:-}}"
if [ -n "$WORKER_ID" ] && [ -n "$WORKER_CREDENTIAL_VALUE" ]; then
  echo "==> Starting the single local Worker ..."
  start_process worker "$REPO_ROOT" env WORKER_CREDENTIAL="$WORKER_CREDENTIAL_VALUE" python -m backend.code_agent.worker.consumer_v2 "$WORKER_ID"
else
  echo "    Worker not started: enroll one with bash scripts/enroll-worker.sh and set WORKER_1_ID/WORKER_1_CREDENTIAL."
fi

echo ""
echo "Local Infinity Agents is running on loopback."
echo "  API:       http://${API_HOST}:${API_PORT}"
echo "  Health:    http://${API_HOST}:${API_PORT}/health"
echo "  Data root: $DATA_REAL"
echo "  Work root: $WORK_REAL"
echo "  Logs:      $LOG_DIR"
echo "Stop processes with: bash scripts/stop-local.sh"
