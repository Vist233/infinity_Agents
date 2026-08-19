# Execution Card P7 / CARD-01 — real Task ID and retired Worker protocol boundary

## Result

The static task-detail shell no longer treats `preview` as a live Task ID. The
client derives the ID from the browser URL for both `/task-center/tasks/<id>`
and `/code-agent/tasks/<id>`, waits for a real ID before loading details, and
keeps the existing task list and mobile navigation.

Task Center direct creation now uses the single `/api/tasks` contract and sends
`agent_confirmation=false` plus `submission_source=task_center`; it no longer
calls the Cloudflare-only `/api/tasks/direct` route.

The retired Cloudflare `/api/worker/v1/*` D1-only protocol now returns an
explicit `410 LEGACY_WORKER_PROTOCOL_DISABLED`. Its routing and handshake tests
were reduced to boundary tests that prove it does not mutate the fake D1
Task/Worker state.

## Modified files

- `frontend/app/code-agent/tasks/[task_id]/TaskDetailClient.tsx`
- `frontend/app/code-agent/tasks/__tests__/page.test.tsx`
- `frontend/lib/api/tasks.ts`
- `cloudflare-worker/src/index.ts`
- `cloudflare-worker/test/index.test.ts`
- `cloudflare-worker/test/worker-routing.test.ts`
- `cloudflare-worker/test/worker-session.test.ts`
- P6 checkpoint corrections under `evidence/IMPLEMENT-20260820/P6/`

## Boundary

This card does not claim that Cloudflare has been switched to the central
PostgreSQL API. The current edge-to-central authentication contract is still
an explicit blocker: the repository has no approved fixed central endpoint and
no approved service-to-service assertion protocol. Existing D1 task handlers
remain in source for migration/test history and are not removed in this card.

## External systems

PostgreSQL, Redis, Docker, Cloudflare, remote repositories, credentials, and
production databases were not modified.
