# C4 Execution Card — D1/Relay HTTPS Docker Worker

## Objective

Replace the production Worker data plane with one Docker consumer that receives
advisory Redis Relay hints, uses the Cloudflare Worker v2 HTTPS API for all
authoritative D1/R2 operations, runs the single Goal-Driven Claude Code
runtime, uploads one final Artifact, and clears the attempt directory.

## Delivered

- Added `backend/code_agent/worker/control_plane.py` with persistent credential,
  session, protocol, input streaming, lease, and R2 multipart clients.
- Added `backend/code_agent/worker/consumer_v2.py` and
  `backend/code_agent/worker/executor_v2.py`.
- Updated `backend/Dockerfile.worker` to copy only the v2 runtime surface and
  install only `httpx`; the entrypoint is `consumer_v2`.
- Updated both Worker Compose files and env templates to require D1 control
  plane, HTTPS Relay, persistent credential, and explicit Claude provider
  configuration. They no longer inject PostgreSQL, raw Redis, or RLS settings.
- Removed the active Cloudflare browser trust/private-pool implementation from
  `tasks.ts`; canonical Worker registration remains server-bound to the single
  D1 public pool and supports arbitrary Worker count.
- Updated the current ADR, continuation plan, and Windows onboarding document
  so Cloudflare D1 is explicitly the only SQL fact source.

## Boundary

The image contains no PostgreSQL driver, Redis Python client, Docker CLI,
Docker socket, verifier, old consumer, old executor, or reaper. Historical
PostgreSQL files and tests remain outside the production image only until C5
real D1 acceptance proves which historical files can be deleted safely.

## Not claimed

No remote D1 migration, R2 operation, zhangbot SSH/deployment, GHCR push,
Cloudflare deploy, or real Claude Case 2/3 run was performed in C4.
