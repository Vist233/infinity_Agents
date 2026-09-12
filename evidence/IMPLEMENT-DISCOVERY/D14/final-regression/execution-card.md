# D14 — Final regression and archive

Date: 2026-09-12 (Asia/Shanghai)
Status: BLOCKED — the follow-up D1 write-side outage left required live gates open

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
repaired Workers returned connect 503s. No Artifact or terminal Task result
was claimed, no duplicate was created, and no manual D1 state write was made.
The bounded record is `gated-live-followup-20260913.md`. The Edge hardening
deployed as `9d898d5d-9753-4e14-bf0f-1fb25c829127`; local Worker v2 and lease
recovery regressions passed. Literature and live Kimi remain open.
