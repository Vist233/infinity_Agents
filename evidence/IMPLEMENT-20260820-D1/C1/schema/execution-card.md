# C1 Execution Card — Canonical D1 Schema and Browser Isolation

## Delivered

- Added `cloudflare-worker/migrations-infinity/0014_d1_worker_runtime.sql`.
- Added a singleton `worker_pool_policy` for exactly
  `public-default/infinity-public`.
- Added canonical D1 `workers`, `worker_sessions_runtime`, `task_attempts`,
  `outbox_events`, `artifact_uploads`, and `artifact_upload_parts` tables.
- Added frozen TaskSpec `goal` and prompt-template fields, public execution-pool
  fields, task lease-token storage, cancellation timestamp, and artifact release
  metadata.
- Migrated active compatibility registrations, sessions, offers, and tasks to
  the public pool. The old trust value is not copied into the canonical
  `workers` table and is not part of the new protocol.
- Updated browser task creation to write Task, idempotency, task event, and
  outbox event in one D1 batch. Conditional inserts prevent an invalid
  confirmation from creating orphan idempotency/event rows.
- TaskSpec creation now persists the goal and fixed prompt template version.
- Browser task reads and artifact downloads retain owner predicates; a
  cross-user task-detail test now proves a task is not exposed to another user.
- Existing published artifacts are marked `release_state='published'` during
  migration so the new browser download predicate does not hide valid history.

## Not yet claimed

Worker v2 endpoints, Redis Relay, D1 CAS claim implementation, R2 multipart
finalization, Docker consumer conversion, and real Case 2/3 remain C2–C5 work.
The old Python PostgreSQL chain is intentionally still present until that
replacement is proven and removed in C4.

## Safety

Only local schema/source/tests changed. No remote D1 migration, R2 object,
zhangbot Redis change, Docker restart, deployment, GHCR push, or GitHub push was
performed.
