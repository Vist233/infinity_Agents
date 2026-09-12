# D12/D14 authorized live-gate follow-up — 2026-09-13

Status: BLOCKED BY OBSERVED D1/Cloudflare WRITE UNAVAILABILITY. This follow-up
did not produce a successful Claude/Artifact result and must not be counted as
a passing production gate.

## Scoped Task and duplicate control

After the earlier three-lease failure, a distinct evaluated match was selected
through the authenticated Data Collection page. The match was
`bd74d122-d7fe-4479-90fd-c1bbc12d262f` for the already profiled public paper
and the shadow UCI collection `175fc3e5-06f0-4338-bde8-0eb7051ee5e6`.
The browser create action was performed once. It materialized exactly one
deterministic Task:

`discovery-task-bd74d122-d7fe-4479-90fd-c1bbc12d262f`

D1 showed one Attempt, `10d1e7f9-7a3e-410b-a182-cba93dda797c`, claimed by the
public Worker-2 identity. No second Task, retry button action, or manual D1
status write was performed.

## Observed failure boundary

The initial Task requests reached the control plane: accept returned 201 and
the frozen spec/method/dataset reads returned 200. A bounded host-side summary
of Worker-2 logs returned only endpoint/status counts; it showed three 500
responses for renew and subsequent 401 responses for heartbeat. D1 remained
readable, and the exact lease-recovery candidate query returned this one
expired Task, with no open artifact-finalize fence.

The Task remained `running` with its Attempt `claimed`, no Artifact, and no
events after `task_claimed`; its recorded lease expiry was
`1789228373`. This is a stranded expired row caused by the unavailable write
path, not evidence of a completed run.

Worker-2 was then recreated only after the Attempt lease had expired. Both
Worker containers were verified `running`, restart count 0, and on the same
local r3 image digest
`sha256:1ac359bfc2a9336d9ee82dbe37b0115b666e6ebd5f9f8ac28674a52c4c2e5227`.
Worker-1 and the separate Discovery Processor were not recreated. Post-repair
aggregate status counts showed `/connect` returning 503 for both Workers,
which is consistent with a D1 write-side availability/quota problem; no
specific Cloudflare quota error was exposed, so the precise provider cause is
not asserted here.

## Edge hardening and offline verification

The Edge was updated to contain the tested narrow hardening:

- session touch and task-renew batches return bounded 503 responses instead of
  uncaught 500s when D1 is temporarily unavailable;
- lease recovery isolates a failed candidate batch and leaves it fenced for the
  next scheduler tick instead of aborting the entire scheduled handler;
- no fencing condition, status transition, idempotency key, or manual D1 write
  was weakened.

The deployment dry-run passed and the Edge deployed as Version
`9d898d5d-9753-4e14-bf0f-1fb25c829127`. Local regressions passed: Worker v2
8 tests, lease recovery 3 tests, and the TypeScript check. The tests cover
bounded 503 responses for session touch, reconnect, lease renewal, and failure
recording, plus an unavailable recovery batch.
The complete offline Edge suite then passed 31 files / 190 tests; the relevant
Python Worker, consumer, LLM, and security suites passed 34 tests.

## Root-cause diagnosis from bounded local and Windows evidence

At `2026-09-12T16:42:52Z`, a status-only Windows recheck found both Workers
running on the expected local r3 image ID
`sha256:1ac359bfc2a9336d9ee82dbe37b0115b666e6ebd5f9f8ac28674a52c4c2e5227`,
with restart count 0. A bounded `docker logs --since 4h` aggregation returned
396 `WORKER_SESSION_UNAVAILABLE` connect retries for Worker-1 and 161 for
Worker-2. It returned zero occurrences of `WORKER_AUTH_INVALID`,
`WORKER_SESSION_INVALID`, `WORKER_SESSION_MISMATCH`,
`WORKER_ALREADY_CONNECTED`, `WORKER_POOL_UNAVAILABLE`, or
`TASK_RENEW_UNAVAILABLE`. No raw log line, credential, or response body was
exported.

The evidence supports a D1 write-side/control-plane availability failure, not
a bad Worker credential or identity binding:

1. The same identities passed connect/accept/spec/input before the outage.
2. The current Edge returns `WORKER_SESSION_UNAVAILABLE` only when the
   session/reconnect `env.DB.batch` cannot complete; its authentication
   failures use separate `WORKER_AUTH_*` or session-binding codes.
3. D1 reads remained available while the write batches failed. The earlier
   renew 500s were uncaught batch failures, and the later heartbeat 401s are
   the expected expired-session consequence once refresh could no longer
   extend the lease.

No provider error or explicit quota response was captured. Therefore “daily
quota exhausted” remains a plausible explanation, but is not proven; the
precise classification is D1 write-side unavailability with auth failure not
supported by the bounded evidence.

## Minimal scoped rerun after write availability returns

1. Perform read-only health/status checks and verify both r3 Workers are still
   running with restart count 0. Do not click Create Task again.
2. Let the normal scheduler reconcile
   `discovery-task-bd74d122-d7fe-4479-90fd-c1bbc12d262f`. Wait until its
   expired Attempt is either requeued or the Task is terminal. Do not create a
   new Task while this row still owns an active or unreconciled Attempt.
3. If it is requeued, allow that existing Task to run. Capture: accept `201`,
   spec/method/dataset `200`, recurring heartbeat/renew `200`, a Claude
   terminal event, Artifact start/parts/complete success, and a succeeded D1
   Task with exactly one published Artifact.
4. Download that Artifact through the authenticated UI and compare the local
   byte count and SHA-256 with D1 metadata. Only this closes the
   Claude/Artifact gate. If the Task terminally fails, retain it and stop
   before creating another duplicate or same-match Task.
5. After the Artifact gate passes, snapshot configuration, run exactly two
   temporary Literature Watcher rounds, run the authorized Kimi JSON profile
   without exposing the existing secret, then restore
   `DISCOVERY_LITERATURE_ENABLED=false`, Processor model settings, and service
   state. Verify the restored flags and health before recording the final
   result.

## Remaining gates and stop state

The D1 write path was not retried through hand-authored SQL. Literature
Watcher rounds were not run, `DISCOVERY_LITERATURE_ENABLED` remains `false`,
and no Processor model flag or secret was changed. The live Kimi JSON profile
was not run. The current task and all prior test rows were retained; no
destructive cleanup was performed.

After D1/Cloudflare write availability returns, the next action is a
read-only status check followed by normal scheduler recovery. The existing
Task must reach a terminal/requeued state before any additional Task creation;
the same match must never be clicked again.
