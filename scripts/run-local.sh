#!/usr/bin/env bash
# Start the complete local developer stack without Cloudflare, SSH, or a
# production credential. PostgreSQL and Redis run in Docker; API, frontend,
# and the local Worker run on this machine.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

bash scripts/start-local.sh

set -a
# shellcheck disable=SC1091
source .env.local
set +a

mkdir -p local-data/logs local-data/pids

start_process() {
  local name="$1"
  shift
  local pid_file="local-data/pids/${name}.pid"
  if [[ -f "$pid_file" ]] && kill -0 "$(cat "$pid_file")" 2>/dev/null; then
    echo "==> ${name} is already running (pid $(cat "$pid_file"))."
    return
  fi
  rm -f "$pid_file"
  echo "==> Starting ${name} ..."
  nohup "$@" >"local-data/logs/${name}.log" 2>&1 &
  echo $! >"$pid_file"
}

start_process api python3 -m uvicorn backend.app:app --host 127.0.0.1 --port "${API_PORT:-8008}"

if [[ ! -d frontend/node_modules ]]; then
  echo "==> Installing frontend dependencies ..."
  (cd frontend && npm ci)
fi
start_process frontend bash -lc "cd '$REPO_ROOT/frontend' && API_PROXY_TARGET=http://127.0.0.1:${API_PORT:-8008} npm run dev"

# The Worker is deliberately local and talks only to the local PostgreSQL and
# Redis services. It remains idle until a task is created in Task Center.
# A model provider is needed only when a queued task is actually executed.
start_process worker python3 -m backend.code_agent.worker.consumer local-worker

echo
echo "Local stack is starting. Open http://localhost:3000 after the frontend is ready."
echo "Logs: local-data/logs/{api,frontend,worker}.log"
echo "Stop: bash scripts/stop-local-stack.sh"
