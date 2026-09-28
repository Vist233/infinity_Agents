#!/usr/bin/env bash
# Stop the local API, frontend, and single Worker. PostgreSQL and local data
# are external to this process manager and remain running/preserved.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
cd "$REPO_ROOT"
ENV_FILE="${ENV_FILE:-.env.local}"
if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: $ENV_FILE not found" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
source "$ENV_FILE"
set +a

LOCAL_DATA_ROOT="${LOCAL_DATA_ROOT:-$REPO_ROOT/local-data}"

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

require_root_marker() {
  local root_real="$1"
  local kind="$2"
  local marker="$root_real/.infinity-agents-root"
  local expected
  expected="$(printf 'infinity-agents-root-v1\npath=%s\nkind=%s' "$root_real" "$kind")"
  if [ -L "$marker" ] || [ ! -f "$marker" ]; then
    echo "ERROR: local root marker is missing or unsafe: $marker" >&2
    exit 1
  fi
  if [ "$(cat "$marker")" != "$expected" ]; then
    echo "ERROR: local root marker does not belong to this installation: $root_real" >&2
    exit 1
  fi
}

require_absolute "$LOCAL_DATA_ROOT" "LOCAL_DATA_ROOT"
reject_symlink_components "$LOCAL_DATA_ROOT"
if [ ! -d "$LOCAL_DATA_ROOT" ] || [ -L "$LOCAL_DATA_ROOT" ]; then
  echo "ERROR: local data root is not a real directory: $LOCAL_DATA_ROOT" >&2
  exit 1
fi
DATA_REAL="$(cd "$LOCAL_DATA_ROOT" && pwd -P)"
reject_dangerous_root "$LOCAL_DATA_ROOT" "$DATA_REAL"
require_root_marker "$DATA_REAL" "data"

PID_DIR="$DATA_REAL/.runtime/pids"
if [ -L "$DATA_REAL/.runtime" ] || [ -L "$PID_DIR" ]; then
  echo "ERROR: refusing a symlinked local runtime directory: $PID_DIR" >&2
  exit 1
fi

process_identity_matches() {
  local name="$1"
  local pid="$2"
  local started_at="$3"
  local actual_started_at
  local actual_command
  actual_started_at="$(ps -p "$pid" -o lstart= 2>/dev/null | sed 's/^ *//;s/ *$//')"
  [ -n "$actual_started_at" ] && [ "$started_at" = "$actual_started_at" ] || return 1
  actual_command="$(ps -p "$pid" -o command= 2>/dev/null | sed 's/^ *//;s/ *$//')"
  case "$name:$actual_command" in
    api:*backend.app:app*) return 0 ;;
    frontend:*npm\ run\ dev*) return 0 ;;
    worker:*backend.code_agent.worker.consumer_v2*) return 0 ;;
    *) return 1 ;;
  esac
}

stop_process() {
  local name="$1"
  local pid_file="$PID_DIR/$name.pid"
  reject_symlink_components "$pid_file"
  if [ ! -f "$pid_file" ]; then
    return 0
  fi
  if [ -L "$pid_file" ]; then
    echo "WARNING: refusing symlinked $name PID file: $pid_file" >&2
    return 0
  fi
  local pid
  local started_at
  pid="$(sed -n '1p' "$pid_file")"
  started_at="$(sed -n '2p' "$pid_file")"
  if ! [[ "$pid" =~ ^[0-9]+$ ]] || [ "$pid" -lt 2 ] || [ -z "$started_at" ]; then
    echo "WARNING: refusing malformed $name PID file: $pid_file" >&2
    return 0
  fi
  if ! process_identity_matches "$name" "$pid" "$started_at"; then
    if ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$pid_file"
      return 0
    fi
    echo "WARNING: refusing to stop unverified $name PID $pid; PID file was not created for the expected process" >&2
    return 0
  fi

  echo "==> Stopping $name (PID $pid) ..."
  kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 1 20); do
    if ! kill -0 "$pid" 2>/dev/null; then
      break
    fi
    sleep 0.25
  done
  if kill -0 "$pid" 2>/dev/null && process_identity_matches "$name" "$pid" "$started_at"; then
    kill -KILL "$pid" 2>/dev/null || true
  fi
  rm -f "$pid_file"
}

# Stop the Worker before the API so it cannot claim new work during shutdown.
stop_process worker
stop_process frontend
stop_process api
echo "Local processes stopped. PostgreSQL and local data were preserved."
