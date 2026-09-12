#!/usr/bin/env bash
# Start the local Infinity Agents stack.
# PostgreSQL + Redis via Docker, then run migrations.
# API and Frontend are started manually on the host.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

ENV_FILE=".env.local"

# 1. Create a safe, self-contained local configuration on first run.  The
# generated values are URL-safe so the DSNs in the example file stay valid.
if [ ! -f "$ENV_FILE" ]; then
  echo "==> .env.local not found. Creating local configuration ..."
  cp .env.local.example "$ENV_FILE"
  PG_PASSWORD="$(python3 -c 'import secrets; print(secrets.token_urlsafe(24))')"
  REDIS_LOCAL_PASSWORD="$(python3 -c 'import secrets; print(secrets.token_urlsafe(24))')"
  # Use the familiar defaults when available, otherwise choose unoccupied
  # loopback ports. This avoids a local PostgreSQL/Redis installation making
  # a first-run setup fail before it has even started.
  choose_port() {
    python3 - "$1" "$2" <<'PY'
import socket
import sys

for candidate in range(int(sys.argv[1]), int(sys.argv[2]) + 1):
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.bind(("127.0.0.1", candidate))
        print(candidate)
        raise SystemExit(0)
    except OSError:
        pass
    finally:
        sock.close()
raise SystemExit("no free local port found")
PY
  }
  LOCAL_PG_PORT="$(choose_port 5432 5442)"
  LOCAL_REDIS_PORT="$(choose_port 6379 6389)"
  python3 - "$ENV_FILE" "$PG_PASSWORD" "$REDIS_LOCAL_PASSWORD" "$LOCAL_PG_PORT" "$LOCAL_REDIS_PORT" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
pg_password, redis_password, pg_port, redis_port = sys.argv[2:]
text = path.read_text(encoding="utf-8")
text = text.replace("replace-with-a-strong-password", pg_password)
text = text.replace("replace-with-a-strong-redis-password", redis_password)
text = text.replace("PG_PORT=5432", f"PG_PORT={pg_port}")
text = text.replace("REDIS_PORT=6379", f"REDIS_PORT={redis_port}")
text = text.replace("localhost:5432/", f"localhost:{pg_port}/")
text = text.replace("localhost:6379/", f"localhost:{redis_port}/")
path.write_text(text, encoding="utf-8")
PY
  echo "    Generated local PostgreSQL and Redis passwords in $ENV_FILE."
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
export REDIS_URL="${REDIS_URL:-redis://:${REDIS_PASSWORD}@localhost:${REDIS_PORT:-6379}/0}"
export LOCAL_RUNTIME_DATABASE_URL="$DATABASE_URL"
export LOCAL_REDIS_URL="$REDIS_URL"
export LOCAL_OBJECT_ROOT="${LOCAL_OBJECT_ROOT:-./local-data/objects}"
# Persist the aliases so a separately launched local-runtime control plane
# sees the same generated credentials and selected ports.
python3 - "$ENV_FILE" "$LOCAL_RUNTIME_DATABASE_URL" "$LOCAL_REDIS_URL" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
database_url, redis_url = sys.argv[2:]
lines = path.read_text(encoding="utf-8").splitlines()
replacements = {
    "LOCAL_RUNTIME_DATABASE_URL=": f"LOCAL_RUNTIME_DATABASE_URL={database_url}",
    "LOCAL_REDIS_URL=": f"LOCAL_REDIS_URL={redis_url}",
}
for index, line in enumerate(lines):
    for prefix, replacement in replacements.items():
        if line.startswith(prefix):
            lines[index] = replacement
path.write_text("\n".join(lines) + "\n", encoding="utf-8")
PY
python3 -m backend.db_migrate
python3 - <<'PY'
import asyncio
import os
import asyncpg
import redis

async def check_postgres():
    connection = await asyncpg.connect(os.environ["LOCAL_RUNTIME_DATABASE_URL"])
    await connection.close()

asyncio.run(check_postgres())
assert redis.Redis.from_url(os.environ["LOCAL_REDIS_URL"]).ping()
print("    Local runtime aliases: connected")
echo "    Migrations complete."

# 6. Create storage directories
for dir in "$ARTIFACT_STORAGE_ROOT" "$ARTIFACT_DOWNLOAD_ROOT" "$METHOD_SOURCE_UPLOAD_ROOT" "$DATASET_UPLOAD_ROOT" "$LOCAL_OBJECT_ROOT"; do
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
echo "   source $ENV_FILE && python3 -m backend.code_agent.worker.consumer local-worker"
echo ""
echo " Health check:"
echo "   curl http://localhost:${API_PORT:-8008}/health"
echo ""
