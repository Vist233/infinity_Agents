# D14 — Final regression and archive

Date: 2026-09-12 (Asia/Shanghai)
Status: BLOCKED — the evaluated-match Artifact gate remains open; a
controlled r6 public-data Task later passed the Claude/Artifact/download gate

Latest state: the v4 canonicalizer repair is pushed as `3570170`; targeted
artifact/runtime checks passed 36 tests and the full Python suite passed 389
tests with 45 skipped. The uniquely tagged r7 image was verified locally, but
private image transfer to the Windows host is pending explicit authorization.
The Workers remain on r6 and no new live Task is authorized before deployment
proof.

All post-audit local code regressions, frontend checks, Worker dry-run checks,
and the 15-test Playwright suite passed. Remote migrations 0025-0027 are
applied, the final listing is clean, the pre-follow-up Edge version was
`9941f714-eee6-46bc-8163-968107d8874f`, and post-deploy health was HTTP 200 with all
readiness bindings configured, and the isolated Windows Processor is running
with restart count 0 and the recorded digest. An authenticated live public-
fixture shadow reached dataset profiling and an evaluated 100% match with hard
gate `pass`; the initial BERT paper shadow exposed a pre-remediation Paper
Processor runtime rejection that is now propagated to the Discovery catalog by
89668c7. The safe-failure runtime 62e5b7f was activated on zhangbot as release
344a93d, and a fresh public ResNet equivalent completed successfully end to
end.

The authorized live run then created exactly one Task for the selected match.
Task Center visibility and deterministic idempotency passed, and a Redis-only
outage showed Relay 503/D1 fallback with recovery to 200. The selected Task
was claimed three times but all three leases expired before a Claude terminal
event or Artifact; it ended `failed` with maximum attempts reached. A separate
existing published Task download/hash control passed, but it does not close the
selected Task's Artifact gate. `DISCOVERY_LITERATURE_ENABLED=false` remains in
force and the live Kimi call was not run. See
`gated-live-run-20260912.md` and `FINAL/remaining-gates.md` for exact evidence.

The 2026-09-13 follow-up selected one distinct match exactly once after the
scanner/lease hardening. The Task reached the accept/spec/input boundary, but
renew and session writes became unavailable; after the expired lease, both
repaired Workers returned connect 503s. After the user-confirmed availability
reset, normal scheduler recovery ran the existing Task through three fenced
Attempts; it terminally failed with the sanitized
`agent_completion.json contains credential-like content` error and no
Artifact. No retry click, duplicate Task, or manual D1 state write was made.
The r4 scanner-validation Task was then selected once for a third distinct
match; it renewed normally for about 46 minutes but failed at the same
completion-metadata boundary with no Artifact. Its payload was cleaned before
retention. The bounded records are in
`gated-live-followup-20260913.md` and
`artifact-scanner-repair-20260913.md`. The second scanner repair was
synchronized to `infinity-agents-worker:2026.09.13-r5-compat`, digest
`sha256:0a9c5ad4eecab27fd5f9ccedd85f5b81992a821796134409e01714041e588ce2`,
and exercised once by a fourth distinct Task
`discovery-task-fd2bad8e-a28e-473a-93fb-4bd0bd207790`. It terminally failed at
the same completion-metadata boundary with no Artifact; the exact payload was
cleaned before retention. The Edge hardening deployed as
`9d898d5d-9753-4e14-bf0f-1fb25c829127`. No further Task is created under the
stop rule.
Literature and live Kimi remain open. After the compatible-r5 failure, the v3
diagnostic image `infinity-agents-worker:2026.09.13-r6-diagnostics` (digest
`sha256:ae0b3e18a61f1d0ba1de56204f18d5a359b45021cf232cb889316735b6bbfc27`)
was deployed to both Windows Workers, which remained running with restart
count 0. One fresh scoped public-data Task
`b73a3306-590d-442f-a76e-55f0008a9a86` succeeded with sole Attempt
`5352cdfb-4efa-4948-91b7-9e2642655631` and exactly one published Artifact.
D1 recorded 9,625 bytes and SHA-256
`7c2e955b6e6a18abd4fce48fa82b0edcd339eef2be9a19b6665ae44401db5ece`; an
authenticated UI download independently matched both values. This closes the
controlled public-data Claude/Artifact/download gate, but it does not replace
the failed evaluated-match Task. No further Task, retry, or flag change was
made.

The later offline-only auth/Discovery resilience pass is recorded in
`auth-discovery-hardening-20260913.md`. It passed the TypeScript check, the
full Edge suite (32 files / 199 tests), and the relevant Python suite (34
tests), but was not live-deployed while the D1 write gate remained blocked.
