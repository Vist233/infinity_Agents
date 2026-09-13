Status: BLOCKED — the follow-up D1 write-side outage left required live gates open.

See `FINAL/` for the complete summary, deployment versions/digests, real-case
IDs/hashes, known limitations, and rollback plan.
The authorized live run materialized exactly one Task and exercised the
Redis-only fallback; the Task exhausted three leases without a Claude terminal
event or Artifact. See `gated-live-run-20260912.md` and
`FINAL/remaining-gates.md` for the remaining Worker, selected-Task Artifact,
Literature Watcher, and live-model gates.

Prior production verification commit: 008b905ddf0598d53b3031da2df8f3ae56b08720.
Post-audit local verification commit: 268eae8; lifecycle fix: 89668c7. Remote
migrations 0025-0027 are applied and the final migration listing is clean. The
current Edge deployment before the follow-up was
`9941f714-eee6-46bc-8163-968107d8874f`; the follow-up deployment is recorded
below. Health was HTTP 200
HTTP 200 with all four readiness bindings configured, and the isolated Windows
Processor is running with restart count 0. The 15-test Playwright suite passed
against the local production build, and the authenticated live public-fixture
shadow reached dataset profiling and an evaluated match. The dedicated Paper
Processor safe-failure runtime `62e5b7f` is active on zhangbot as release
`344a93d`; a fresh public ResNet retry reached `profiled`/`ready` with a
succeeded attempt.

Follow-up on 2026-09-13: after the Worker scanner and lease changes, a distinct
evaluated match was selected once and materialized as
`discovery-task-bd74d122-d7fe-4479-90fd-c1bbc12d262f`. Its first Attempt
reached the accept/spec/input boundary but then the D1 write path became
unavailable. After the user-confirmed availability reset, normal scheduler
recovery ran this existing Task through three Attempts; it terminally failed
with the sanitized `agent_completion.json contains credential-like content`
error and no Artifact. Both Windows Workers were rebuilt on the local r3
digest with restart count 0, Worker-2 was recreated only after the initial
lease expired, and the Edge was deployed as
`9d898d5d-9753-4e14-bf0f-1fb25c829127`. Literature and live Kimi gates were
not run, and the existing flags/services remain in their safe state. See
`gated-live-followup-20260913.md`.

After the first scanner repair was pushed and the Windows Workers were
refreshed to r4, one additional distinct evaluated match was selected exactly
once as the scanner-validation Task
`discovery-task-4a2a16cd-2f7a-4397-b06b-1a7733bac017`. Its Attempt renewed for
about 46 minutes and then terminally failed with the sanitized
`agent_completion.json contains credential-like content` error and no
Artifact. The completion payload was cleaned before retention. A second
scanner repair is now offline-verified and has not yet been deployed.

An offline-only follow-on then hardened browser auth and Discovery persistence
boundaries for D1/R2 write failures. `npm run check`, the full Edge suite
(32 files / 199 tests), and the relevant Python artifact/security suite (34
tests) passed. It was not live-deployed and does not alter the blocked gate.
