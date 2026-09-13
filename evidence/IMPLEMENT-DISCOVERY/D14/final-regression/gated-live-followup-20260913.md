# D12/D14 authorized live-gate follow-up — 2026-09-13

Status: BLOCKED — this follow-up did not produce a successful Claude/Artifact
result and must not be counted as a passing production gate. The earlier D1
write-side outage later recovered enough for normal scheduler activity, but
the one existing Task then terminally failed after three fenced Attempts and
still has no Artifact.

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

An additional offline-only hardening pass after this live observation added
auth role-projection/migration/refresh write-failure containment and tightened
the Discovery evidence, task-read, immutable-source, and deletion boundaries.
The updated full Edge suite passed 32 files / 199 tests, `npm run check`
passed, and the same Python artifact/security subset passed 34 tests. These
changes are recorded in
`auth-discovery-hardening-20260913.md`; they were not live-deployed or used to
claim that the stranded Task completed.

A fresh status-only Windows inspection then confirmed the pinned isolated
Processor and both Worker containers were running with restart count 0; the
image IDs, local-tag resolution, no-Docker-Hub boundary, and HTTPS-only
Processor architecture are recorded in
`windows-processor-status-20260913.md`.

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

## Availability recheck after the reset boundary

On 2026-09-13 at approximately `2026-09-12T18:24-18:29Z`, the public Edge
health endpoint returned `200`, and a remote primary D1 `SELECT 1` returned
`d1_read=1` with `rows_written=0`. A precise read of the existing Task still
returned `status=running`, `attempt_count=1`, the same expired Attempt
`10d1e7f9-7a3e-410b-a182-cba93dda797c`, and `result_artifact_id=null`. The
authenticated Task Center continued to render backend `HTTP 500`.

A final status-only 30-minute Windows aggregation returned 323
`WORKER_SESSION_UNAVAILABLE` retries for Worker-1 and 318 for Worker-2, with
zero `WORKER_AUTH_INVALID`, `WORKER_SESSION_INVALID`,
`WORKER_SESSION_MISMATCH`, `WORKER_ALREADY_CONNECTED`, or
`WORKER_POOL_UNAVAILABLE` labels. No Task creation, scheduler SQL, or flag
change was attempted. This confirms that a successful read probe alone did
not restore the write-side gate; the task rerun remains deferred.

## Post-reset bounded recovery and terminal Task outcome

After the user confirmed that the availability window had reset, one bounded
status-only observation of the Workers' normal control-plane traffic showed a
successful `/connect` 2xx response, recurring heartbeat 2xx responses, and
renew 2xx responses, with zero `WORKER_AUTH_INVALID`,
`WORKER_SESSION_INVALID`, `WORKER_SESSION_MISMATCH`,
`WORKER_ALREADY_CONNECTED`, or `WORKER_POOL_UNAVAILABLE` labels. This was the
write-recovery decision point; no hand-authored D1 status SQL was used.

The normal scheduler then processed the existing Task; no new Task was
created and the authenticated UI retry action was not clicked. The Task
reached its configured maximum of three Attempts and terminally failed:

- first Attempt: `10d1e7f9-7a3e-410b-a182-cba93dda797c`;
- second Attempt: `b21649d0-7752-427b-8f00-052903212540`;
- third Attempt: `6fd6f9e9-5c86-4be0-bdd8-937b7b99aac3`;
- terminal event: `task_failed`, error code `worker_execution_failed`;
- authenticated Task Center error: `agent_completion.json contains
  credential-like content`;
- final state: failed, 3/3 Attempts, no available Artifact.

The Task Center recorded the terminal failure at approximately
`2026-09-13 08:06:37` Asia/Shanghai. This is a sanitized status/error
observation only; it does not establish whether the scanner report was a
false positive or a real credential finding. No retry, duplicate Task,
Watcher round, Kimi call, flag change, or destructive cleanup followed it.

The offline repair and its evidence boundary are recorded in
`artifact-scanner-repair-20260913.md`. It preserves rejection of real
credential-shaped values and only admits explicit non-secret completion
metadata placeholders. A later controlled public-data Task on the diagnostic
image published one Artifact and passed the authenticated download/hash check;
the evaluated-match result remains a separate blocked gate.

## Second scanner-validation Task

After the first scanner repair was pushed and the Windows Workers were
refreshed to the local r4 image, one additional distinct evaluated match was
selected exactly once: `4a2a16cd-2f7a-4397-b06b-1a7733bac017`. It materialized
`discovery-task-4a2a16cd-2f7a-4397-b06b-1a7733bac017` with one Attempt,
`3f23b26e-9d11-4cf0-8b28-330d0bfcf4ba`. The Attempt was claimed at
`2026-09-13 08:39:20` Asia/Shanghai, renewed normally for about 46 minutes,
and then ended at approximately `09:26:01` with `task_failed` /
`worker_execution_failed`. The authenticated Task Center displayed the
sanitized error `agent_completion.json contains credential-like content`;
D1 and the UI showed no Artifact. No retry button, duplicate Task, or manual
status write was used.

The r4 Worker cleaned the failed Attempt tree, so its exact completion payload
is not retained. A local regression reproduces a specific false-positive
mechanism in the pre-second-repair path: JSON-escaped quotes around a safe
placeholder in a free-form summary are scanned as raw bytes rather than as
decoded metadata. The second repair parses `agent_completion.json`, checks
credential-labelled fields separately, scans decoded string values, rejects
duplicate keys, and applies the same rule in the uploaded archive validator.
Real credential-shaped values remain rejected. The second repair is offline
only at this point and has not been deployed or used to claim a live pass.

## Final r5 validation Task

After the second repair was pushed, the Workers were synchronized to the
compatible r5 image
`infinity-agents-worker:2026.09.13-r5-compat` with digest
`sha256:0a9c5ad4eecab27fd5f9ccedd85f5b81992a821796134409e01714041e588ce2`.
One remaining evaluated match was selected exactly once through the
authenticated UI: `fd2bad8e-a28e-473a-93fb-4bd0bd207790`. It materialized
`discovery-task-fd2bad8e-a28e-473a-93fb-4bd0bd207790` with Attempt
`6e176f72-043c-44a3-b22c-f5c43d52102d`. The Task was created at
`2026-09-13 10:06:48` Asia/Shanghai and ended at approximately `10:10:57`
with `task_failed` / `worker_execution_failed`, 1/3 Attempts. The UI
displayed the sanitized `agent_completion.json contains credential-like
content` error; D1 showed no Artifact. No retry button, duplicate Task, or
manual status write was used. Both Workers remained running with restart count
0 on the compatible r5 digest after the failure.

The compatible r5 image passed the bounded synthetic safe/credential scanner
check, but the live completion payload was cleaned before retention. Therefore
the live result does not establish whether the remaining error is a true
credential match or an uncovered false-positive form. This is the terminal
scanner-validation outcome; no further Task is created under the stop rule.

## r6 controlled public-data validation

The v3 diagnostic image was transferred to the Windows host and loaded under
the unique tag `infinity-agents-worker:2026.09.13-r6-diagnostics`, digest
`sha256:ae0b3e18a61f1d0ba1de56204f18d5a359b45021cf232cb889316735b6bbfc27`.
Both Workers were recreated without dependencies and verified running with
restart count 0; the Discovery Processor was not changed. A bounded D1
preflight found no active Task, Attempt, active upload, pending outbox row, or
result-table write.

One fresh scoped public-data Task was created exactly once through the
authenticated UI using a minimal method and the public UCI red-wine ZIP:
Task `b73a3306-590d-442f-a76e-55f0008a9a86`, sole Attempt
`5352cdfb-4efa-4948-91b7-9e2642655631`, Worker
`public-worker-16dab622-4e3b-4212-bb09-0ed738c45314`. It was created at
`2026-09-13 11:43:49` Asia/Shanghai and succeeded at `11:45:55`.

D1 and the UI showed exactly one published `result.zip` Artifact. D1 recorded
9,625 bytes and SHA-256
`7c2e955b6e6a18abd4fce48fa82b0edcd339eef2be9a19b6665ae44401db5ece`; the
authenticated UI download independently produced the same size and SHA-256.
No Artifact contents were read or exported. This controlled run closes the
Claude/Artifact/download gate for the public-data path, but does not replace
the failed evaluated-match Task or classify its deleted completion payload.
No retry, duplicate Task, flag change, Literature Watcher round, Kimi call,
or cleanup followed.

## r7 v4 canonicalizer rollout preparation — not deployed

Commit `3570170` is synchronized to `cf-deploy`. The Worker-side
`agent_completion.json` path now uses a strict canonical metadata schema and
the control-plane validator requires the uploaded file to match those
canonical bytes. The targeted artifact/runtime checks passed 36 tests and the
full Python suite passed 389 tests with 45 skipped. The local image
`infinity-agents-worker:2026.09.13-r7-canonical` was built from the verified
r6 base with digest
`sha256:986de061fe184b6c05ddee096a830314cf731cb589d0a45d539bc9388d0b25b8`,
revision `3570170`, and scanner marker `artifact-secret-scan-v4`. Bounded
in-image verification matched the source hashes and passed the safe-versus-
credential synthetic check.

The private image transfer to the Windows staging directory was stopped by
the external safety boundary because explicit authorization for that payload
was required. The r7 image was not loaded remotely, neither Worker was
recreated, and no evaluated-match Task was created. The live deployed image
remains r6; this record does not claim a v4 live pass.

## Stop rule and no further reruns

1. The synchronized r5 validation Task is terminally failed with no Artifact;
   do not click retry, create another Task, or hand-edit D1 status.
2. Keep `DISCOVERY_AUTO_EXECUTE=false` and
   `DISCOVERY_LITERATURE_ENABLED=false`; Literature Watcher and live Kimi
   gates remain deferred.
3. If a future, separately authorized investigation is opened, begin with
   read-only health/status checks and a new evidence boundary. It must not
   reuse any of the four selected match IDs or their Tasks.

## Remaining gates and stop state

The D1 write path was not retried through hand-authored SQL. Literature
Watcher rounds were not run, `DISCOVERY_LITERATURE_ENABLED` remains `false`,
and no Processor model flag or secret was changed. The live Kimi JSON profile
was not run. The current task and all prior test rows were retained; no
destructive cleanup was performed.

The bounded write-recovery observation succeeded, but the existing Task
terminally failed at its three-Attempt limit without an Artifact. The selected
match must not be clicked again and no duplicate Task may be created. The
Claude/Artifact gate, Literature Watcher gate, and live Kimi gate therefore
remain open; `DISCOVERY_AUTO_EXECUTE=false` and
`DISCOVERY_LITERATURE_ENABLED=false` remain the stop controls.
