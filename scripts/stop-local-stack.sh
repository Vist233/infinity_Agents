#!/usr/bin/env bash
# Stop host-side local processes. PostgreSQL and Redis data are preserved.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

for name in worker frontend api; do
  pid_file="local-data/pids/${name}.pid"
  if [[ -f "$pid_file" ]]; then
    pid="$(cat "$pid_file")"
    if kill -0 "$pid" 2>/dev/null; then
      echo "==> Stopping ${name} (pid ${pid}) ..."
      kill "$pid" || true
    fi
    rm -f "$pid_file"
  fi
done

bash scripts/stop-local.sh
