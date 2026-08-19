# Execution Card P9 / CARD-01 — real Case 2/3 Worker acceptance

## Scope

This card records the first real end-to-end acceptance of the unified Worker
path in an isolated local stack. It does not publish an image, push GitHub,
deploy Cloudflare, or modify the existing user containers/services.

The stack used its own PostgreSQL 16 database, Redis 7 namespace, API,
Outbox, Reaper, and two credentialed Docker Workers. The two tasks were
submitted through the local authenticated Task API; no task row, Attempt, or
Artifact was manually inserted or promoted.

## Runtime contract exercised

1. The API accepted the frozen execution document and dataset for each Case.
2. Redis dispatched the Task to the shared consumer group.
3. Each Worker authenticated with its persistent enrollment credential and
   claimed one Attempt.
4. The Worker fetched the two frozen inputs, acquired the Attempt-scoped model
   gateway capability, and ran Claude Code inside the Worker image.
5. The platform-owned goal-driven prompt was used by
   `backend/code_agent/worker/claude_runtime.py`; the task-specific goal was
   written into `spec/task_spec.json`, not concatenated into the platform
   prompt by the UI.
6. The Worker performed deterministic output checks, streamed the result
   archive to the API (including multipart upload for the larger result),
   completed the Attempt, and then the Task Center state was promoted.
7. The Worker deleted its task-local input, scratch, and output directories;
   only the durable API-side result archive remained.

## Real task results

| Case | Task ID | Attempt | Worker | Task status | Artifact | Size | SHA-256 |
|---|---|---:|---|---|---|---:|---|
| 2 | `d6673207-8458-4fb1-aba4-a389d6e704b0` | 23 | `public-worker-8fe8f68f-e2ff-47b3-b273-0ca362d968be` | `succeeded` | `artifact-64ff3405-81a6-4cbb-89ed-8a4affe0f0ba.zip` | 895,291 | `18dd42a1191f15b281e7809bf6d549651b7626a45c10d46ecec6b7aaf8acacad` |
| 3 | `d2bc9695-887b-4c7c-96b6-9ecc760e1d8b` | 24 | `public-worker-9c8521e8-476e-4aef-8e3f-dfd231527547` | `succeeded` | `artifact-cdfe2bea-1611-40cc-a44e-505b195ca02f.zip` | 44,719,790 | `bf056bcd642ab3443e39d27926cf9185e8c1d35baa14f223a44d1d917749ecfe` |

The frozen dataset inputs were Case 2: 718,587 bytes,
`99d16c38e664dbac2e122436375294d03d5077569e01c26933ec8d49255abd65`; and
Case 3: 3,951,848 bytes,
`725ba0d8371d4602f4f2c23853d13d3a2e89f61470b8aeea695dcc90776e7573`.

Both result archives passed `unzip -t`. The larger Case 3 upload created one
completed multipart upload with three parts; there were no unfinished uploads,
and no pending outbox event remained.

## Lease, cleanup, and image evidence

- During execution, both leases were renewed repeatedly while Claude Code was
  still running; the final Attempts exited with code `0` and no failure code or
  error message.
- Database counts after completion: `tasks=2`, `artifacts=2`, no non-terminal
  task, and zero unpublished/dead outbox events.
- The two Worker task directories were absent after publication. The API-side
  remote result roots contained exactly one archive for each Task.
- Worker A, Worker B, and Reaper all used image manifest
  `sha256:9ef9ef8e0de79c8b8d4beccd0037d1f87832efdbb44bd298143437febc9d490b`.
- Both Workers reported Claude Code `2.1.226 (Claude Code)` and UID/GID `0`
  for the supervisor process; the Claude child is launched with the image's
  non-root runtime identity (`CLAUDE_RUNTIME_UID/GID=10001`).

## Code cleanup included in this card

- Removed the dead Worker-local lease-renew/reaper compatibility path. Lease
  renewal is task-scoped in the data-plane Worker, while lease recovery is
  owned only by `backend/code_agent/worker/reaper.py`.
- Renamed the executor's misleading `_run_docker_execution` entry to
  `_run_claude_execution` and removed its unused image argument. The Worker
  image is still recorded immutably for Attempt evidence; no nested Docker
  command exists.
- Updated focused tests to exercise the dedicated Reaper and the current
  Claude runtime naming.
- Remaining mentions of deleted runtime files are limited to historical gap
  reports and negative assertions that prove the files stay absent; no active
  production import points to them.

## Tests and exit codes

```text
targeted backend/recovery/runtime/security tests -> 48 passed, 38 skipped, exit 0
previous P9 acceptance backend target set       -> 62 passed, exit 0
zip integrity checks for Case 2 and Case 3     -> exit 0
git diff --check                                -> exit 0
```

The isolated acceptance stack and its ignored local credentials remain
available for the final read-only review. No secret value is included in this
card.
