#!/usr/bin/env bash
set -euo pipefail

# Start the two local Claude Code Workers without copying Redis or provider
# secrets into the repository. The caller should run this from an interactive
# zsh so the provider variables exported by the user's .zshrc are inherited.

if ! lsof -nP -iTCP:16379 -sTCP:LISTEN >/dev/null 2>&1; then
  ssh -o BatchMode=yes -o ConnectTimeout=10 -o ExitOnForwardFailure=yes \
    -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
    -fN -L 16379:127.0.0.1:6379 zhangbot
fi

redis_values="$(ssh -o BatchMode=yes -o ConnectTimeout=10 zhangbot \
  'set -a; . /home/zhangyvjing/.config/infinity-redis/redis.env; printf "%s\\n%s\\n%s\\n%s\\n" "$REDIS_WORKER_A_USERNAME" "$REDIS_WORKER_A_PASSWORD" "$REDIS_WORKER_B_USERNAME" "$REDIS_WORKER_B_PASSWORD"')"

export WORKER_A_REDIS_USERNAME="$(printf '%s\n' "$redis_values" | sed -n '1p')"
export WORKER_A_REDIS_PASSWORD="$(printf '%s\n' "$redis_values" | sed -n '2p')"
export WORKER_B_REDIS_USERNAME="$(printf '%s\n' "$redis_values" | sed -n '3p')"
export WORKER_B_REDIS_PASSWORD="$(printf '%s\n' "$redis_values" | sed -n '4p')"

export WORKER_A_REDIS_URL="$(node -e 'console.log("redis://" + encodeURIComponent(process.env.WORKER_A_REDIS_USERNAME) + ":" + encodeURIComponent(process.env.WORKER_A_REDIS_PASSWORD) + "@host.docker.internal:16379/0")')"
export WORKER_B_REDIS_URL="$(node -e 'console.log("redis://" + encodeURIComponent(process.env.WORKER_B_REDIS_USERNAME) + ":" + encodeURIComponent(process.env.WORKER_B_REDIS_PASSWORD) + "@host.docker.internal:16379/0")')"

docker rm -f infinity-cf-merge-2-worker-a-1 infinity-cf-merge-2-worker-b-1 >/dev/null 2>&1 || true
docker compose -f docker-compose.cloudflare-workers.yml up -d --no-build worker-a worker-b
