# Remaining authorization-gated production checks

Date: 2026-09-12 (Asia/Shanghai)

Disposition: CONDITIONAL PASS. The implementation, local regressions, remote
rollout, Processor validation, and real Paper/Data shadow path are evidenced.
The authorized live-gate run is recorded in
`D14/final-regression/gated-live-run-20260912.md`: one real Task was
materialized exactly once, the Redis fallback passed, but all three Worker
Attempts expired without a Claude terminal event or Artifact. Literature and
live-model configuration changes were not executed.

## Read-only production preflight

At the final preflight, all six rows below were `evaluated`, had hard gate
`pass`, coverage `1`, execution confidence `100`, a ready collection, and
`created_task_id=null`. The query was read-only; no D1 row was edited.

| match | paper | collection |
| --- | --- | --- |
| `c34f251b-dfbd-4fae-985d-3ff6c0ea6342` | `f26a1816-34c0-4f0a-939a-b4504d544977` | `eee1539e-3db6-4117-922b-2c8088131a3a` |
| `bd74d122-d7fe-4479-90fd-c1bbc12d262f` | `f26a1816-34c0-4f0a-939a-b4504d544977` | `175fc3e5-06f0-4338-bde8-0eb7051ee5e6` |
| `fd2bad8e-a28e-473a-93fb-4bd0bd207790` | `acc2c811-2e6a-42c4-8358-16ecd387c62e` | `eee1539e-3db6-4117-922b-2c8088131a3a` |
| `767b6975-a88f-45bd-bdc0-754fed57ebb6` | `acc2c811-2e6a-42c4-8358-16ecd387c62e` | `175fc3e5-06f0-4338-bde8-0eb7051ee5e6` |
| `4a2a16cd-2f7a-4397-b06b-1a7733bac017` | `91422e01-f892-4573-89cb-8d5a8e25bdbd` | `eee1539e-3db6-4117-922b-2c8088131a3a` |
| `3064ea56-066f-43b1-b650-e7130376c128` | `91422e01-f892-4573-89cb-8d5a8e25bdbd` | `175fc3e5-06f0-4338-bde8-0eb7051ee5e6` |

All rows belong to the authenticated test user
`27d99fa3-618e-4bf8-b721-f13d8acd1a70`. Because the current implementation's
scheduled retry uses the global `DISCOVERY_AUTO_EXECUTE` switch, setting that
switch to `true` would make all six eligible rows candidates. A safe one-row
test therefore requires an explicit match selection and a scoped one-shot or
operator allowlist; it must not be simulated by hand-editing D1.

## Gated-run results and gates still open

1. **Task materialization: PASS.** The browser created exactly one deterministic
   `discovery-task-${match_id}` Task, one idempotency row, one queued event, and
   the Task Center rendered it. Three fenced retries were recorded; no second
   Task was created. See `D14/final-regression/gated-live-run-20260912.md`.
2. **Existing Worker v2 execution: OPEN/FAILED RUN.** The protocol-v2 Workers
   claimed all three Attempts and leases renewed while active, but no Claude
   terminal event or Artifact was produced before the maximum-attempt failure.
   Capture Worker-side executor diagnostics or repair the Worker image before
   rerunning; do not create a second Task without explicit authorization.
3. **Artifact integrity and download: OPEN for the selected Task.** Its
   Artifact query was empty. An existing published Task's download and SHA-256
   control passed, but that control is not substituted for the selected Task.
   Any test Task/Attempt/Artifact cleanup needs explicit confirmation before
   deletion.
4. **Redis failure and poll fallback: PASS.** Only the confirmed user-scoped
   `infinity-redis.service` was stopped briefly. Relay hints/health failed
   closed with 503, D1/Worker leases continued, the same single Task remained
   fenced, and Redis/Relay recovered to 200. Existing Worker v2 containers were
   not stopped. See the D14 gated-run record.
5. **Literature watcher: OPEN/UNRUN.** It is currently disabled by
   `DISCOVERY_LITERATURE_ENABLED=false`; the baseline state query had no rows.
   A temporary local enablement was reverted before deployment because the
   production configuration mutation was not authorized in this context. Two
   real cron rounds still require direct authorization.
6. **Live model provider path: OPEN/UNRUN.** The optional Kimi `kimi-k2.6`
   JSON profile call was not attempted. No secret, model flag, or remote
   environment was changed. It requires a separately authorized configuration
   change and bounded status/family-only diagnostics.

## Safe execution and rollback notes

Before any gated run, snapshot the read-only preflight, current Edge version
`9941f714-eee6-46bc-8163-968107d8874f`, current flags, Worker v2 session
health, and Processor digest
`sha256:2bb2a1c1171e28e646006d185a2fc9bab3fb190b3aa1b0778e04194087147496`.
Use a disposable selected match/fixture only after the user authorizes the
external effects. Keep `DISCOVERY_AUTO_EXECUTE=false` and
`DISCOVERY_LITERATURE_ENABLED=false` as the immediate stop control; if a live
run regresses, disable both flags first, roll back the Edge version, and
revert only the isolated Discovery Processor release. Retain the additive D1
migrations and leave existing Worker v2, Task Center, and Redis services
untouched.

The failed BERT paper, its terminal resource, the shadow collection, and the
failed selected Task/Attempts are retained for traceability. They were not
deleted because deletion is a destructive operation requiring confirmation at
action time.

## Evidence already supporting the conditional pass

- D12 real Paper/Data shadow: `D12/real-production-case/`.
- D13 deployment, health, D1, R2, Processor, and live shadow: `D13/deploy/`.
- D14 regression, gated live run, and test output: `D14/final-regression/`.
- Current final summary, known limitations, and rollback: this directory.
