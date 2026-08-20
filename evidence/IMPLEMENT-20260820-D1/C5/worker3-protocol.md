# C5 Worker 3 protocol evidence — 2026-08-20

The existing server-issued public Worker 3 credential was used without printing the credential or
the returned session secret.

## Successful checks

- `POST /api/worker/v2/connect`
  - pool: `public-default`
  - namespace: `infinity-public`
  - protocol: `2`
  - runtime: `goal-driven-claude-code`
  - persistent credential: `true`
- Reusing the same `instance_id` returned a renewed session with epoch `2`.
- `POST /api/worker/v2/poll` returned `task_count: 0`, `next_poll_seconds: 5`, and no error.

## Negative check

Opening a second active instance with the same persistent credential was rejected by the server.
The first diagnostic poll initially showed `WORKER_SESSION_INVALID` because the diagnostic script
continued after that expected `WORKER_ALREADY_CONNECTED` response and used an empty session ID.
The script was corrected to stop on connect errors; the same-instance retry then passed.

## Not claimed by this card

No task was claimed and no D1 task row was manually changed. Real Case 2/3 still require an
accessible Docker Worker host and a queued task created through the authenticated Task Center/API.
