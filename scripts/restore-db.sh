#!/usr/bin/env bash
# Restore PostgreSQL from a backup file.
#
# Usage:
#   bash scripts/restore-db.sh backups/pg-20260822_120000.sql.gz
#
# IMPORTANT: Stop the API before restoring to avoid connection conflicts.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

if [ $# -lt 1 ]; then
  echo "Usage: $0 <backup-file.sql.gz>"
  echo ""
  echo "Available backups:"
  ls -lh backups/pg-*.sql.gz 2>/dev/null || echo "  (none)"
  exit 1
fi

BACKUP_FILE="$1"
if [ ! -f "$BACKUP_FILE" ]; then
  echo "ERROR: $BACKUP_FILE not found"
  exit 1
fi

ENV_FILE=".env.local"
if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: $ENV_FILE not found"
  exit 1
fi

set -a
# shellcheck disable=SC1091
source "$ENV_FILE"
set +a

echo "==> Restoring PostgreSQL from $BACKUP_FILE ..."
echo "    (Make sure the API is stopped before restoring)"
echo ""

gunzip -c "$BACKUP_FILE" | docker compose -f docker-compose.infra.yml --env-file "$ENV_FILE" \
  exec -T postgres psql -U "${POSTGRES_USER:-infinity}" -d "${POSTGRES_DB:-infinity_local}" \
  --single-transaction

echo ""
echo "    Done. Restart the API to pick up restored data."
