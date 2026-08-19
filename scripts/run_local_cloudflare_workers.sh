#!/usr/bin/env bash
set -euo pipefail

# Start one local unified Worker without copying Redis or provider secrets into
# the repository. The caller should run this from an interactive shell so the
# administrator-provided values from the local env file are available.

worker_env_file="${WORKER_ENV_FILE:-worker-b.cloudflare.env}"

if ! lsof -nP -iTCP:16379 -sTCP:LISTEN >/dev/null 2>&1; then
  ssh -o BatchMode=yes -o ConnectTimeout=10 -o ExitOnForwardFailure=yes \
    -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
    -fN -L 16379:127.0.0.1:6379 zhangbot
fi

redis_values="$(ssh -o BatchMode=yes -o ConnectTimeout=10 zhangbot \
  'set -a; . /home/zhangyvjing/.config/infinity-redis/redis.env; printf "%s\\n%s\\n" "$REDIS_WORKER_B_USERNAME" "$REDIS_WORKER_B_PASSWORD"')"

export WORKER_REDIS_USERNAME="$(printf '%s\n' "$redis_values" | sed -n '1p')"
export WORKER_REDIS_PASSWORD="$(printf '%s\n' "$redis_values" | sed -n '2p')"

export WORKER_REDIS_URL="$(node -e 'console.log("redis://" + encodeURIComponent(process.env.WORKER_REDIS_USERNAME) + ":" + encodeURIComponent(process.env.WORKER_REDIS_PASSWORD) + "@host.docker.internal:16379/0")')"
export WORKER_ENV_FILE="$worker_env_file"

docker compose \
  --env-file "$worker_env_file" \
  -f docker-compose.cloudflare-workers.yml \
  up -d worker-b
