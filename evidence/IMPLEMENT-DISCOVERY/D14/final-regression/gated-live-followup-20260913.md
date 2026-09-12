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
7 tests, lease recovery 3 tests, and the TypeScript check. The new tests cover
bounded 503 responses and an unavailable recovery batch.

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
