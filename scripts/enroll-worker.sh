#!/usr/bin/env bash
# Register a new Worker via the local API and print its credentials.
# The API must be running (started via uvicorn) before calling this script.
#
# Usage:
#   bash scripts/enroll-worker.sh
#   # Copy the output into .env.local:
#   #   WORKER_1_ID=public-worker-xxxx
#   #   WORKER_1_CREDENTIAL=xxxx
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

ENV_FILE=".env.local"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$ENV_FILE"
  set +a
fi

API_URL="${WORKER_CONTROL_PLANE_URL:-http://localhost:${API_PORT:-8008}}"

echo "==> Registering a new Worker at $API_URL ..."
RESPONSE=$(curl -sS -X POST "$API_URL/api/worker-enrollments" \
  -H "Content-Type: application/json" \
  -d '{}' 2>&1) || {
    echo "ERROR: Failed to reach API at $API_URL"
    echo "$RESPONSE"
    echo ""
    echo "Make sure the API is running:"
    echo "  source .env.local && uvicorn backend.app:app --host 0.0.0.0 --port ${API_PORT:-8008}"
    exit 1
  }

# Extract worker_id and credential
WORKER_ID=$(echo "$RESPONSE" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(d.get('worker_id',''))" 2>/dev/null || echo "")
CREDENTIAL=$(echo "$RESPONSE" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(d.get('credential',''))" 2>/dev/null || echo "")

if [ -z "$WORKER_ID" ] || [ -z "$CREDENTIAL" ]; then
  echo "ERROR: Unexpected API response:"
  echo "$RESPONSE"
  exit 1
fi

echo ""
echo "========================================="
echo " Worker enrolled successfully!"
echo "========================================="
echo ""
echo " Add these to .env.local:"
echo ""
echo "   WORKER_1_ID=$WORKER_ID"
echo "   WORKER_1_CREDENTIAL=$CREDENTIAL"
echo ""
echo " Then start the Worker:"
echo ""
echo "   source .env.local && python3 -m backend.code_agent.worker.consumer_v2 \"\$WORKER_1_ID\""
echo ""
