# D12/D14 authorized live-gate run — 2026-09-12

Status: CONDITIONAL PASS. The run produced durable evidence for one real Task
materialization and the Redis poll-fallback path. The selected Task reached its
maximum of three leased Attempts without a Claude terminal event or Artifact,
so successful Worker execution remains open. Literature ingestion and the live
Kimi call were not changed or run because their production configuration
mutations were not authorized in this execution context.

## Scope and identity

The selected read-only preflight match was
`c34f251b-dfbd-4fae-985d-3ff6c0ea6342` for paper
`f26a1816-34c0-4f0a-939a-b4504d544977` and collection
`eee1539e-3db6-4117-922b-2c8088131a3a`. The authenticated owner was
`27d99fa3-618e-4bf8-b721-f13d8acd1a70`.

The browser-created Task was exactly
`discovery-task-c34f251b-dfbd-4fae-985d-3ff6c0ea6342`, with project
`73786100-765e-4bbc-a8c8-6ee7ac4af5a3`. D1 contained exactly one Task for the
idempotency key
`discovery:c34f251b-dfbd-4fae-985d-3ff6c0ea6342:paper-profile-v1:dataset-profile-v1`
and one `task_idempotency` row. The request hash was
`01ad0633dea00c23cc5206a17e068db7cd00e224acb88569603d178f018bdad4`.
The frozen project inputs were the Discovery Method resource (3,813 bytes,
SHA-256 `920afbabca2b9bbd8843780403666db4e2d363196c37496f9e650913f95c96f9`)
and the `winequality-red.csv` Dataset resource (84,199 bytes, SHA-256
`4a402cf041b025d4566d954c3b9ba8635a3a8a01e039005d97d6a710278cf05e`).

## Task Center and D1 event sequence

The authenticated Task Center rendered the Task and its live status. The
authoritative D1 event sequence was:

| UTC time | event | durable identity |
| --- | --- | --- |
| 2026-09-12T10:25:17Z | `task_queued` | one Discovery Task |
| 2026-09-12T10:25:19Z | `task_claimed` | Attempt `80ef58f6-8ff8-41b8-b8f7-06e2d1a68447`, Worker `public-worker-16dab622-4e3b-4212-bb09-0ed738c45314`, epoch 1 |
| 2026-09-12T10:32:03Z | `task_queued` | epoch 1 lease expired |
| 2026-09-12T10:32:05Z | `task_claimed` | Attempt `75761bef-f33c-4235-91c6-a6f8b216f121`, Worker `public-worker-adbde17e-29c4-4511-abc8-e9faad10e524`, epoch 2 |
| 2026-09-12T10:38:02Z | `task_queued` | epoch 2 lease expired |
| 2026-09-12T10:38:04Z | `task_claimed` | Attempt `dab73849-9f0d-4000-ae4f-a347caffadac`, Worker `public-worker-16dab622-4e3b-4212-bb09-0ed738c45314`, epoch 3 |
| 2026-09-12T10:46:04Z | `task_failed` | epoch 3 lease expired; maximum attempts reached |

Final D1 state: `tasks.status=failed`, `attempt_count=3`, `max_attempts=3`,
`result_artifact_id=null`, and `error_message="Worker lease expired; maximum
attempts reached"`. The selected Task had no row in `artifacts`. This is a
real failure result, not a successful Claude/Artifact run; no second Task was
created and no manual D1 status was written.

The Worker sessions remained live during the controlled test and the third
Attempt lease was renewed while the Task was active. However, the executor did
not emit a `task_running`, terminal success/failure, or Artifact event before
the lease expired. The cause is not inferred from these rows; the next run
must capture Worker-side executor logs or use a repaired Worker image before
claiming the Claude gate.

## Redis outage and D1 fallback

The exact user-scoped service boundary was confirmed first:
`infinity-redis.service` is the loopback Redis process and
`infinity-redis-relay.service` is the separate HTTPS Relay process on
127.0.0.1:8090. Only `infinity-redis.service` was stopped; Worker v2, the
Relay, Paper Processor, and Discovery Processor were not stopped or restarted.

During the outage, Relay `/health` returned HTTP 503 with
`REDIS_UNAVAILABLE`, and authenticated `/v1/hints` reads returned 503 from
2026-09-12 18:42:31 through 18:43:24 +08:00. D1 remained authoritative: at
2026-09-12T10:42:57Z the same Task still had `attempt_count=3`, the same active
Attempt, and a renewed lease; both public Worker sessions had recent live
heartbeats. There was no duplicate Task or Attempt.

The same Redis unit was started again. Relay health returned HTTP 200 and the
Relay logs returned repeated `/v1/hints` HTTP 200 responses. The post-recovery
Task remained the single failed Task described above; no duplicate was
materialized.

## Artifact download control

The selected Discovery Task had no Artifact, so its requested hash/download
acceptance could not pass. As a separate read-only control, an existing
published result from Task `3666d0f1-4581-42e3-b81c-bf195288daa5` was downloaded
through the authenticated Task Center. D1 recorded Artifact
`6cc37651-2bee-4803-a81c-04b6cfbd76fd` as published, 1,234,445 bytes, with
SHA-256
`1885153939abd104471a20e3d332285f86d39c2c8ef1efef5b9a00d5fb5f780c`.
The downloaded `/Users/zhangyvjing/Downloads/result (2).zip` was exactly
1,234,445 bytes and recomputed to that same SHA-256. Its archive listing had
nine files including `manifest.json`, `agent_completion.json`, and the report.
This verifies the existing download path only; it is not substituted for the
failed selected Task.

## Intentionally unrun gates

- Baseline Literature Watcher state had no rows, quota rows, failure rows, or
  system-created literature papers. `DISCOVERY_LITERATURE_ENABLED` remains
  `false`; a temporary local config edit was reverted before any deploy, so no
  watcher state or catalog row changed.
- The live Moonshot/Kimi JSON call was not run. No Processor secret, model flag,
  or remote environment was changed.
- Failed BERT/Paper Processor rows, shadow collections, and any test artifacts
  were retained. No destructive cleanup was performed.

The remaining successful Claude/Artifact run, two real Literature Watcher
rounds, and live Kimi JSON profile call require explicit action authorization
and a follow-up Worker-side diagnosis.
