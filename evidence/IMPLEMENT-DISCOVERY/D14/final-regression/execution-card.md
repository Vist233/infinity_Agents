# D14 — Final regression and archive

Date: 2026-09-12 (Asia/Shanghai)
Status: CONDITIONAL PASS — rollout complete with intentional gates

All post-audit local code regressions, frontend checks, Worker dry-run checks,
and the 15-test Playwright suite passed. Remote migrations 0025-0027 are
applied, the final listing is clean, the current Edge version is
`9941f714-eee6-46bc-8163-968107d8874f`, post-deploy health is HTTP 200 with all
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
