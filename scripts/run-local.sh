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
STOP_REQUEST="local-data/pids/.stop-requested"
rm -f "$STOP_REQUEST"

if command -v lsof >/dev/null 2>&1; then
  for port in "${API_PORT:-8008}" 3000; do
    if lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | grep -q .; then
      echo "ERROR: local port ${port} is already in use; stop the existing stack first." >&2
      exit 1
    fi
  done
fi

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

stop_tree() {
  local pid="$1"
  local child
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do
    stop_tree "$child"
  done
  kill "$pid" 2>/dev/null || true
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
echo "Stop: press Ctrl-C or run bash scripts/stop-local-stack.sh in another terminal."

# Keep this command attached to the stack. Some shells (and service managers)
# reap background children when the launching shell exits, which would make a
# successful-looking one-shot script leave no API/frontend/Worker behind.
cleanup() {
  for name in worker frontend api; do
    pid_file="local-data/pids/${name}.pid"
    if [[ -f "$pid_file" ]]; then
      pid="$(cat "$pid_file")"
      stop_tree "$pid"
      rm -f "$pid_file"
    fi
  done
}
trap cleanup EXIT INT TERM

while true; do
  if [[ -f "$STOP_REQUEST" ]]; then
    exit 0
  fi
  for name in api frontend worker; do
    pid_file="local-data/pids/${name}.pid"
    if [[ ! -f "$pid_file" ]] || ! kill -0 "$(cat "$pid_file")" 2>/dev/null; then
      echo "ERROR: ${name} exited; see local-data/logs/${name}.log" >&2
      exit 1
    fi
  done
  sleep 2
done
