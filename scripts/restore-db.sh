#!/usr/bin/env bash
# Restore a matched PostgreSQL dump and local object archive.
set -euo pipefail
umask 077

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
cd "$REPO_ROOT"
if [ $# -lt 2 ]; then
  echo "Usage: $0 <backup.sql.gz> <objects.tar.gz>" >&2
  exit 1
fi
DB_BACKUP="$1"
OBJECT_BACKUP="$2"
if [ ! -f "$DB_BACKUP" ] || [ ! -f "$OBJECT_BACKUP" ]; then
  echo "ERROR: both backup files must exist" >&2
  exit 1
fi

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
DATA_REAL="$(require_marked_data_root "$LOCAL_DATA_ROOT")"
OBJECT_REAL="$(require_marked_object_root "$DATA_REAL" "$LOCAL_OBJECT_ROOT")"
if [ -e "$OBJECT_REAL" ] || [ -L "$OBJECT_REAL" ]; then
  if [ -L "$OBJECT_REAL" ] || [ ! -d "$OBJECT_REAL" ]; then
    echo "ERROR: local object root is not a real directory: $OBJECT_REAL" >&2
    exit 1
  fi
  reject_tree_symlinks "$OBJECT_REAL"
fi

# Validate the complete gzip stream before asking PostgreSQL to execute any
# reset SQL.  The object archive is fully listed and type-checked below for
# the same reason.
if ! gzip -t "$DB_BACKUP"; then
  echo "ERROR: PostgreSQL backup is not a complete gzip stream" >&2
  exit 1
fi
validate_archive_members "$OBJECT_BACKUP" "objects"
echo "Restore is destructive. Stop API and Worker before continuing."
read -r -p "Restore PostgreSQL and replace the local object root? [y/N] " confirm
if [ "$confirm" != "y" ] && [ "$confirm" != "Y" ]; then
  echo "Aborted."
  exit 0
fi

STAGING_ROOT=""
OLD_ROOT_HOLDER=""
RESTORE_COMMITTED=0
cleanup_restore_paths() {
  if [ -n "$STAGING_ROOT" ] && [ -d "$STAGING_ROOT" ]; then
    rm -rf -- "$STAGING_ROOT"
  fi
  if [ -n "$OLD_ROOT_HOLDER" ] && [ -d "$OLD_ROOT_HOLDER" ]; then
    if [ "$RESTORE_COMMITTED" -eq 1 ]; then
      rm -rf -- "$OLD_ROOT_HOLDER"
    elif [ -z "$(ls -A "$OLD_ROOT_HOLDER" 2>/dev/null || true)" ]; then
      rmdir "$OLD_ROOT_HOLDER" 2>/dev/null || true
    else
      echo "WARNING: preserving the previous object root at $OLD_ROOT_HOLDER after an incomplete restore" >&2
    fi
  fi
}
trap cleanup_restore_paths EXIT

STAGING_ROOT="$(extract_object_archive "$OBJECT_BACKUP" "$DATA_REAL")"
STAGED_OBJECT="$STAGING_ROOT/objects"
DB_SQL_STAGING="$STAGING_ROOT/restore.sql"

emit_database_reset_sql() {
  # Reset application schemas in the same transaction as the dump.  With
  # ON_ERROR_STOP, any SQL error rolls the database back and prevents the
  # object-directory replacement below.
  printf '%s\n' \
    'DO $$' \
    'DECLARE schema_name text;' \
    'BEGIN' \
    "  FOR schema_name IN SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname <> 'information_schema'" \
    '  LOOP' \
    "    EXECUTE format('DROP SCHEMA %I CASCADE', schema_name);" \
    '  END LOOP;' \
    'END $$;' \
    'CREATE SCHEMA public;'
}

prepare_database_sql() {
  # Decompress into the controlled staging directory before touching
  # PostgreSQL.  This turns a late gzip/CRC error into a pre-restore failure
  # instead of feeding a partial SQL stream to psql.
  if ! {
    emit_database_reset_sql
    gunzip -c "$DB_BACKUP"
  } >"$DB_SQL_STAGING"; then
    rm -f -- "$DB_SQL_STAGING"
    echo "ERROR: PostgreSQL backup could not be fully decompressed" >&2
    return 1
  fi
}

restore_database() {
  if [ -n "$DATABASE_URL" ]; then
    psql -X -v ON_ERROR_STOP=1 --single-transaction -d "$DATABASE_URL" <"$DB_SQL_STAGING"
    return
  fi

  : "${POSTGRES_DB:=infinity_local}"
  : "${POSTGRES_USER:=infinity}"
  : "${PG_HOST:=127.0.0.1}"
  : "${PG_PORT:=5432}"
  if [ -n "${POSTGRES_PASSWORD:-}" ]; then
    PGPASSWORD="$POSTGRES_PASSWORD" psql -X -v ON_ERROR_STOP=1 --single-transaction -h "$PG_HOST" -p "$PG_PORT" -U "$POSTGRES_USER" -d "$POSTGRES_DB" <"$DB_SQL_STAGING"
  else
    psql -X -v ON_ERROR_STOP=1 --single-transaction -h "$PG_HOST" -p "$PG_PORT" -U "$POSTGRES_USER" -d "$POSTGRES_DB" <"$DB_SQL_STAGING"
  fi
}

prepare_database_sql
echo "==> Restoring PostgreSQL ..."
restore_database

OLD_ROOT_HOLDER="$(mktemp -d "$DATA_REAL/.restore-old-objects.XXXXXX")"
chmod 700 "$OLD_ROOT_HOLDER" 2>/dev/null || true
if [ -e "$OBJECT_REAL" ] || [ -L "$OBJECT_REAL" ]; then
  if [ -L "$OBJECT_REAL" ] || [ ! -d "$OBJECT_REAL" ]; then
    echo "ERROR: local object root changed into an unsafe path during restore" >&2
    exit 1
  fi
  reject_tree_symlinks "$OBJECT_REAL"
  mv -- "$OBJECT_REAL" "$OLD_ROOT_HOLDER/objects"
fi
if ! mv -- "$STAGED_OBJECT" "$OBJECT_REAL"; then
  if [ -e "$OLD_ROOT_HOLDER/objects" ]; then
    if ! mv -- "$OLD_ROOT_HOLDER/objects" "$OBJECT_REAL"; then
      echo "ERROR: could not roll back the previous object root; it was preserved at $OLD_ROOT_HOLDER/objects" >&2
    fi
  fi
  echo "ERROR: could not replace the local object root; old data was retained when possible" >&2
  exit 1
fi
RESTORE_COMMITTED=1
rm -rf -- "$STAGING_ROOT"
STAGING_ROOT=""
rm -rf -- "$OLD_ROOT_HOLDER"
OLD_ROOT_HOLDER=""
echo "Restore complete. Verify the task and artifact counts before restarting."
