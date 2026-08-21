#!/usr/bin/env bash
# Stop the local infrastructure (PostgreSQL + Redis).
# Data in named volumes is preserved.
#
# Stop API/Frontend/Workers manually (Ctrl+C in their terminals) before
# running this script.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

ENV_FILE=".env.local"
if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: $ENV_FILE not found"
  exit 1
fi

echo "==> Stopping PostgreSQL + Redis (data preserved) ..."
docker compose -f docker-compose.infra.yml --env-file "$ENV_FILE" down
echo "    Done. Restart with: bash scripts/start-local.sh"
