# C5 remote preflight — 2026-08-20

## Target

- Branch: `cloudflare-deploy`
- D1: `infinity-agents-db` (`9ee9ec94-cb42-40b5-8372-681c7b57c105`)
- R2: `infinity-agents-resources`
- Edge: `infinity.zhangyvjing.com`
- Redis host: `zhangbot`
- Public pool: `public-default / infinity-public`

## Evidence

- `wrangler d1 migrations apply infinity-agents-db --remote` applied
  `0014_d1_worker_runtime.sql` successfully.
- Read-only D1 query confirmed `worker_pool_policy`, `workers`, `worker_sessions_runtime`,
  `task_attempts`, `outbox_events`, `artifact_uploads`, and `artifact_upload_parts`.
- Read-only D1 query confirmed one public policy row and migration record `0014`.
- zhangbot Redis is ACL-protected, bound to `127.0.0.1:6379` and `[::1]:6379`; no public Redis
  listener was added.
- Relay is a user-level systemd service named `infinity-redis-relay.service`, bound to
  `127.0.0.1:8090`; local `/health` and public Tunnel `/health` both returned HTTP 200.
- Edge deployment completed with Cloudflare version
  `cf1bc7d5-7ec9-4c52-a68d-90e4dcb0d3c6`; `/health` returned HTTP 200. The deployed candidate is
  recorded in the aggregate C5 checkpoint and includes the Task Center direct-route repair.
- Unauthenticated `POST /api/worker/v2/connect` was rejected; no credential was printed.

## Boundary

The current public Tunnel is a temporary Quick Tunnel used only for this pre-production run.
It must be replaced with an administrator-owned named Tunnel before a long-lived Windows Worker is
declared production-ready.
