# Remaining authorization-gated production checks

Date: 2026-09-12 (Asia/Shanghai)

Disposition: CONDITIONAL PASS. The implementation, local regressions, remote
rollout, Processor validation, and real Paper/Data shadow path are evidenced.
The checks below intentionally remain unrun because they create external
Task/Attempt/Artifact state, invoke existing Workers, stop infrastructure, or
enable an external model/provider.

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

## Gates still open

1. **One real Task materialization.** With explicit authorization, select one
   preflight match and record before/after counts. Verify the deterministic
   `discovery-task-${match_id}` identity, idempotency key, owner, frozen Method
   and Dataset resources, one durable `task_queued` event, Task Center
   visibility, and no second Task after a retry/double trigger. Keep the other
   five rows disabled.
2. **Existing Worker v2 execution.** Verify the existing protocol-v2 Worker
   claims the selected Task, receives the correct Method and Dataset R2 inputs,
   and emits the durable claim/terminal event sequence. A live Claude Code run
   is required for this gate; the current active Worker sessions and leases
   are only readiness evidence, not an execution result.
3. **Artifact integrity and download.** Verify the selected Task reaches
   `succeeded`, an Artifact is published only after the successful Attempt,
   the recorded hash matches the downloaded bytes, and the authenticated Task
   Center download works. Any test Task/Attempt/Artifact cleanup needs explicit
   confirmation before deletion.
4. **Redis failure and poll fallback.** During the selected Task's queued or
   claimable window, perform a controlled Relay/Redis outage test, then restore
   it. Verify D1 polling remains authoritative, the Worker resumes or claims
   exactly once, there is no duplicate Task or Attempt, and the outbox/event
   state converges after recovery. Do not stop existing Worker v2 containers.
5. **Literature watcher.** After explicit authorization, enable the watcher
   for two real scheduled rounds and capture lease, quota, retry, dedupe, and
   no-duplicate evidence. It is currently disabled by
   `DISCOVERY_LITERATURE_ENABLED=false`; the live literature-watch state query
   had no rows at the final preflight.
6. **Live model provider path.** The optional Kimi `kimi-k2.6` JSON profile
   call remains unrun. It requires an authorized secret/configuration change
   (`DISCOVERY_USE_MODEL=true` plus a valid `MOONSHOT_API_KEY`) and must capture
   only bounded status/family diagnostics, never the key or provider payload.

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

The failed BERT paper, its terminal resource, and the shadow collection are
retained for traceability. They were not deleted because deletion is a
destructive operation requiring confirmation at action time.

## Evidence already supporting the conditional pass

- D12 real Paper/Data shadow: `D12/real-production-case/`.
- D13 deployment, health, D1, R2, Processor, and live shadow: `D13/deploy/`.
- D14 regression and test output: `D14/final-regression/`.
- Current final summary, known limitations, and rollback: this directory.
