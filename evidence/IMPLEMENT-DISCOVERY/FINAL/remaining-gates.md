# Remaining authorization-gated production checks

Date: 2026-09-12 (Asia/Shanghai)

Disposition: BLOCKED. The implementation, local regressions, remote rollout,
Processor validation, and real Paper/Data shadow path are evidenced, but the
required live execution gates are still open.
The authorized live-gate run is recorded in
`D14/final-regression/gated-live-run-20260912.md`: one real Task was
materialized exactly once, the Redis fallback passed, but all three Worker
Attempts expired without a Claude terminal event or Artifact. Literature and
live-model configuration changes were not executed.

Follow-up status (2026-09-13): a second, distinct match was selected exactly
once after the Worker scanner/lease fixes. Its Task first encountered the D1
write-side outage; after the user-confirmed availability reset, normal
scheduler recovery ran the existing Task through three Attempts and it
terminally failed with a sanitized `agent_completion.json contains
credential-like content` error and no Artifact. The bounded details are in
`D14/final-regression/gated-live-followup-20260913.md`; this is a blocker, not
a passing Claude/Artifact result. The retained evidence does not contain the
failed completion payload, so the exact matching field/value is not asserted.
The narrow offline repair is recorded in
`D14/final-regression/artifact-scanner-repair-20260913.md` and still needs one
fresh scoped live Task for validation.

The first post-repair Worker image was then exercised once with a third,
distinct evaluated match. Its Attempt renewed normally for about 46 minutes
but ended with the same sanitized completion-metadata error and no Artifact.
The exact payload was cleaned before retention. A second scanner repair is now
complete locally, but it has not been deployed or validated live.

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

1. **Task materialization: PASS with three distinct scoped runs.** The browser
   created one deterministic Task for each selected match, each exactly once
   with its own idempotency row. No duplicate Task was created for any match.
   The first Task recorded three fenced lease expiries; the second reached its
   configured three-Attempt limit after D1 write recovery and terminally
   failed without an Artifact; the third was the r4 scanner-validation Task
   and terminally failed without an Artifact. See both D14 live-gate records.
2. **Existing Worker v2 execution: OPEN/BLOCKED.** The repaired r3 Workers
   reached the second Task's accept/spec/input boundary, but the control plane
   returned renew 500s, then session 401s, and finally connect 503s after a
   narrow Worker-2 recreate. After the write path recovered, the existing Task
   was retried by normal scheduler fencing but ended with the sanitized
   credential-like-content failure and no Artifact. The r4 scanner-validation
   Task also reached the completion-metadata boundary and failed with no
   Artifact. The Edge now maps transient batches to bounded 503s and isolates
   recovery candidates; a successful Claude/Artifact run still requires a
   clean terminal execution after the second scanner repair is deployed.
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
5. **Literature watcher: OPEN/UNRUN.** It remains disabled by
   `DISCOVERY_LITERATURE_ENABLED=false`; no watcher rows or catalog writes were
   made. The authorized rounds were deferred when the D1 write path became
   unavailable, and must be run only after the flag can be restored safely.
6. **Live model provider path: OPEN/UNRUN.** The authorized live Kimi
   `kimi-k2.6` JSON profile call was deferred because the production gate was
   already blocked. No secret, model flag, or remote Processor environment was
   changed.

## Safe execution and rollback notes

Before any gated run, snapshot the read-only preflight, current Edge version
`9d898d5d-9753-4e14-bf0f-1fb25c829127`, current flags, Worker v2 session
health, current Worker image/digest, and Processor digest
`sha256:2bb2a1c1171e28e646006d185a2fc9bab3fb190b3aa1b0778e04194087147496`.
The current local Worker image is r4 with digest
`sha256:9aa76ec21071427671311a5dc8a4bb3e9992336d4e6c0e9eca64c5efacb64b6a`.
Use a disposable selected match/fixture only after the user authorizes the
external effects. Keep `DISCOVERY_AUTO_EXECUTE=false` and
`DISCOVERY_LITERATURE_ENABLED=false` as the immediate stop control; if a live
run regresses, disable both flags first, roll back the Edge version, and
revert only the isolated Discovery Processor release. Retain the additive D1
migrations and leave existing Worker v2, Task Center, and Redis services
untouched.

The failed BERT paper, its terminal resource, the shadow collection, and all
three selected Task/Attempt sets are retained for traceability. They were not deleted
because deletion is a destructive operation requiring confirmation at action
time.

## Evidence already supporting the conditional pass

- D12 real Paper/Data shadow: `D12/real-production-case/`.
- D13 deployment, health, D1, R2, Processor, and live shadow: `D13/deploy/`.
- D14 regression, gated live run, and test output: `D14/final-regression/`.
- Current final summary, known limitations, and rollback: this directory.

## Offline follow-on hardening (not a live pass)

After the D1 write-side outage was reproduced, a local-only pass contained
browser auth role-projection, token-migration, refresh, and invalid-session
cleanup writes, and reinforced the deterministic Paper evidence and immutable
Dataset source gates. It also added regression coverage for all live Task
states blocking collection deletion and for hiding review-paper matches.
`npm run check` and the full Edge suite (32 files / 199 tests) passed; the
relevant Python artifact/security subset passed 34 tests. The code was not
live-deployed during this blocked state, so these checks do not close the
Claude/Artifact, Literature Watcher, or live-model gates.
The pinned Windows Processor/Worker status check separately passed with zero
restart counts; see `D14/final-regression/windows-processor-status-20260913.md`.
The r4 Worker image was the image used by the third scanner-validation Task;
the second repair requires a new synchronized image before another live Task.
