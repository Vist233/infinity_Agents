#!/usr/bin/env bash
# Backup the local PostgreSQL database to backups/pg-YYYYMMDD_HHMMSS.sql.gz
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

ENV_FILE=".env.local"
if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: $ENV_FILE not found"
  exit 1
fi

set -a
# shellcheck disable=SC1091
source "$ENV_FILE"
set +a

BACKUP_DIR="$REPO_ROOT/backups"
mkdir -p "$BACKUP_DIR"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="$BACKUP_DIR/pg-${TIMESTAMP}.sql.gz"

echo "==> Backing up PostgreSQL to $BACKUP_FILE ..."
docker compose -f docker-compose.infra.yml --env-file "$ENV_FILE" exec -T postgres \
  pg_dump -U "${POSTGRES_USER:-infinity}" "${POSTGRES_DB:-infinity_local}" \
  | gzip > "$BACKUP_FILE"

echo "    Done: $BACKUP_FILE ($(du -h "$BACKUP_FILE" | cut -f1))"
