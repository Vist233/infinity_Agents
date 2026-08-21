#!/usr/bin/env bash
# DESTROY all local data (PostgreSQL + Redis volumes).
# This is irreversible. Use only for a clean reset.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

ENV_FILE=".env.local"
if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: $ENV_FILE not found"
  exit 1
fi

read -r -p "This will DELETE all PostgreSQL and Redis data. Continue? [y/N] " confirm
if [ "$confirm" != "y" ] && [ "$confirm" != "Y" ]; then
  echo "Aborted."
  exit 0
fi

echo "==> Destroying infrastructure + volumes ..."
docker compose -f docker-compose.infra.yml --env-file "$ENV_FILE" down -v
echo "    Done. All data removed."
