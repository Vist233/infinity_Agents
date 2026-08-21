#!/usr/bin/env bash
# Start the local Infinity Agents stack.
# PostgreSQL + Redis via Docker, then run migrations.
# API and Frontend are started manually on the host.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

ENV_FILE=".env.local"

# 1. Check .env.local exists
if [ ! -f "$ENV_FILE" ]; then
  echo "==> .env.local not found. Copying from .env.local.example ..."
  cp .env.local.example "$ENV_FILE"
  echo ""
  echo "   EDIT $ENV_FILE to set passwords, then re-run this script."
  echo ""
  exit 1
fi

# 2. Source environment
set -a
# shellcheck disable=SC1091
source "$ENV_FILE"
set +a

# 3. Start infrastructure
echo "==> Starting PostgreSQL + Redis ..."
docker compose -f docker-compose.infra.yml --env-file "$ENV_FILE" up -d

# 4. Wait for health checks
echo "==> Waiting for services to be healthy ..."
for i in $(seq 1 60); do
  pg_status=$(docker compose -f docker-compose.infra.yml ps --format json postgres 2>/dev/null | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print((d[0] if isinstance(d,list) else d).get('Health','unknown'))" 2>/dev/null || echo "checking")
  redis_status=$(docker compose -f docker-compose.infra.yml ps --format json redis 2>/dev/null | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print((d[0] if isinstance(d,list) else d).get('Health','unknown'))" 2>/dev/null || echo "checking")
  if [ "$pg_status" = "healthy" ] && [ "$redis_status" = "healthy" ]; then
    echo "    PostgreSQL: healthy"
    echo "    Redis:      healthy"
    break
  fi
  if [ "$i" -eq 60 ]; then
    echo "    WARNING: services did not become healthy within 60s"
    echo "    pg=$pg_status  redis=$redis_status"
    docker compose -f docker-compose.infra.yml ps
    exit 1
  fi
  sleep 1
done

# 5. Run migrations
echo "==> Running database migrations ..."
export DATABASE_URL="${DATABASE_URL:-postgresql://${POSTGRES_USER:-infinity}:${POSTGRES_PASSWORD}@localhost:${PG_PORT:-5432}/${POSTGRES_DB:-infinity_local}}"
python3 -m backend.db_migrate
echo "    Migrations complete."

# 6. Create storage directories
for dir in "$ARTIFACT_STORAGE_ROOT" "$ARTIFACT_DOWNLOAD_ROOT" "$METHOD_SOURCE_UPLOAD_ROOT" "$DATASET_UPLOAD_ROOT"; do
  mkdir -p "$dir" 2>/dev/null || true
done

# 7. Print next steps
echo ""
echo "========================================="
echo " Infrastructure ready!"
echo "========================================="
echo ""
echo " Start the API:"
echo "   source $ENV_FILE && uvicorn backend.app:app --host 0.0.0.0 --port ${API_PORT:-8008} --reload"
echo ""
echo " Start the Frontend (in another terminal):"
echo "   cd frontend && npm run dev"
echo ""
echo " Register a Worker (after API is running):"
echo "   bash scripts/enroll-worker.sh"
echo ""
echo " Start a Worker:"
echo "   source $ENV_FILE && python3 -m backend.code_agent.worker.consumer_v2 \"\$WORKER_1_ID\""
echo ""
echo " Health check:"
echo "   curl http://localhost:${API_PORT:-8008}/health"
echo ""
