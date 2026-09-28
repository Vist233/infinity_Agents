#!/usr/bin/env bash
# Destructive local reset: drop the configured PostgreSQL database and remove
# the local object/work roots. PostgreSQL itself is never stopped or removed.
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
WORKER_WORK_ROOT="${WORKER_WORK_ROOT:-$REPO_ROOT/local-worker-work}"
POSTGRES_DB="${POSTGRES_DB:-infinity_local}"
POSTGRES_USER="${POSTGRES_USER:-infinity}"
PG_HOST="${PG_HOST:-127.0.0.1}"
PG_PORT="${PG_PORT:-5432}"

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

validate_root() {
  local raw_root="$1"
  local label="$2"
  local kind="$3"
  require_absolute "$raw_root" "$label"
  reject_symlink_components "$raw_root"
  if [ ! -d "$raw_root" ] || [ -L "$raw_root" ]; then
    echo "ERROR: $label is not a real directory: $raw_root" >&2
    exit 1
  fi
  local root_real
  root_real="$(cd "$raw_root" && pwd -P)"
  reject_dangerous_root "$raw_root" "$root_real"
  require_root_marker "$root_real" "$kind"
  printf '%s\n' "$root_real"
}

DATA_REAL="$(validate_root "$LOCAL_DATA_ROOT" "LOCAL_DATA_ROOT" "data")"
WORK_REAL="$(validate_root "$WORKER_WORK_ROOT" "WORKER_WORK_ROOT" "worker")"
if [ "$DATA_REAL" = "$WORK_REAL" ] || [[ "$DATA_REAL/" == "$WORK_REAL/"* ]] || [[ "$WORK_REAL/" == "$DATA_REAL/"* ]]; then
  echo "ERROR: local data/work roots must be separate, non-nested directories" >&2
  exit 1
fi

echo "This will DROP database $POSTGRES_DB and DELETE:"
echo "  $DATA_REAL"
echo "  $WORK_REAL"
read -r -p "Continue? [y/N] " confirm
if [ "$confirm" != "y" ] && [ "$confirm" != "Y" ]; then
  echo "Aborted."
  exit 0
fi

if command -v dropdb >/dev/null 2>&1; then
  if [ -n "${POSTGRES_PASSWORD:-}" ]; then
    PGPASSWORD="$POSTGRES_PASSWORD" dropdb --if-exists -h "$PG_HOST" -p "$PG_PORT" -U "$POSTGRES_USER" "$POSTGRES_DB"
  else
    dropdb --if-exists -d "postgresql://${POSTGRES_USER}@${PG_HOST}:${PG_PORT}/${POSTGRES_DB}"
  fi
else
  echo "WARNING: dropdb is not installed; database was not removed" >&2
fi
rm -rf -- "$DATA_REAL" "$WORK_REAL"
echo "Local PostgreSQL database (if dropdb was available) and filesystem data removed."
