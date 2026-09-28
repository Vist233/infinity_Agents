#!/usr/bin/env bash
# Back up PostgreSQL and the local object directory as a matched pair.
set -euo pipefail
umask 077

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
source "$REPO_ROOT/scripts/local-storage-safety.sh"

DATABASE_URL="${DATABASE_URL:-}"
LOCAL_DATA_ROOT="${LOCAL_DATA_ROOT:-$REPO_ROOT/local-data}"
LOCAL_OBJECT_ROOT="${LOCAL_OBJECT_ROOT:-$LOCAL_DATA_ROOT/objects}"
BACKUP_DIR="${BACKUP_DIR:-$REPO_ROOT/backups}"
DATA_REAL="$(require_marked_data_root "$LOCAL_DATA_ROOT")"
OBJECT_REAL="$(require_marked_object_root "$DATA_REAL" "$LOCAL_OBJECT_ROOT")"
reject_tree_symlinks "$OBJECT_REAL"
BACKUP_REAL="$(ensure_backup_dir "$DATA_REAL" "$BACKUP_DIR")"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
DB_BACKUP="$BACKUP_REAL/pg-${TIMESTAMP}.sql.gz"
OBJECT_BACKUP="$BACKUP_REAL/objects-${TIMESTAMP}.tar.gz"

if ! command -v pg_dump >/dev/null 2>&1; then
  echo "ERROR: pg_dump is not installed" >&2
  exit 1
fi
if [ ! -d "$OBJECT_REAL" ]; then
  echo "ERROR: local object root does not exist: $OBJECT_REAL" >&2
  exit 1
fi

echo "==> Backing up PostgreSQL to $DB_BACKUP ..."
if [ -n "$DATABASE_URL" ]; then
  pg_dump "$DATABASE_URL" | gzip >"$DB_BACKUP"
else
  : "${POSTGRES_DB:=infinity_local}"
  : "${POSTGRES_USER:=infinity}"
  : "${PG_HOST:=127.0.0.1}"
  : "${PG_PORT:=5432}"
  if [ -n "${POSTGRES_PASSWORD:-}" ]; then
    PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -h "$PG_HOST" -p "$PG_PORT" -U "$POSTGRES_USER" "$POSTGRES_DB" | gzip >"$DB_BACKUP"
  else
    pg_dump -h "$PG_HOST" -p "$PG_PORT" -U "$POSTGRES_USER" "$POSTGRES_DB" | gzip >"$DB_BACKUP"
  fi
fi

echo "==> Backing up local objects to $OBJECT_BACKUP ..."
tar -czf "$OBJECT_BACKUP" -C "$DATA_REAL" objects
echo "Done. Restore both files together while API and Worker are stopped."
echo "  PostgreSQL: $DB_BACKUP"
echo "  Objects:    $OBJECT_BACKUP"
