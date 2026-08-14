# Complete local verification / 2026-08-09

This record covers the local stages after S0. Cloudflare is intentionally out
of scope. Secrets, raw cookies, Provider credentials, and machine-specific
fixture paths are omitted.

## Executed evidence

| Area | Result | Evidence |
|---|---|---|
| L1 / T1 | PASS for local dev OIDC-shaped flow and clean-DB RLS | PKCE login → local authorize → callback → /auth/me returned 200; missing CSRF returned 403; valid CSRF logout returned 303. On an isolated clean database, dedicated NOBYPASSRLS API/Worker roles, forced RLS, no-context denial, Alice/Bob project isolation, Worker task visibility, and the Worker session privilege boundary all passed. The script was not applied to the already-dirty acceptance DB. |
| L2 / T2 | PASS for application Resource boundary and clean-DB RLS | Authenticated upload/snapshot/task inputs use opaque Resource IDs; cross-user access is 404. Path, ZIP traversal, symlink, SSRF, egress-policy, and secret scans are covered by focused tests; composite project references and forced RLS were also installed and exercised in the isolated clean database. |
| L3 / T3–T4 | PASS locally | Analysis and Coding Provider profiles enforce one protocol each, encrypt credentials, return no credential field, and run real local spy capability probes. Both probes reported ready=true; /models 404 was accepted as unsupported discovery. |
| L4–L5 / T5 | PASS locally | Real API flow completed Project → method upload → TaskSpec freeze → dataset upload → snapshot → Task. Reusing the same idempotency key returned the same Task with duplicate=true. |
| L6 / T6 | PASS for protocol/runtime boundary; partial for live Claude Code | Local OpenAI-compatible Analysis spy plus SDK stream produced a valid TaskSpec. Local Anthropic-compatible Coding spy passed count_tokens, Messages, stream, and tool-use checks. No live external Provider call was claimed. |
| L7 / T7 | PASS for local enrollment/ACL; partial for production executor host | One-time Worker token exchanged for a hashed per-Worker credential and was revoked. Redis Worker A could write its own heartbeat key but was denied Worker B’s key. Acceptance Worker has no Docker Socket mount. |
| L8 / T8 | PASS locally | A task was changed in the isolated DB to an expired lease. Reaper produced one attempt_lost, the old Attempt became lost, the Task requeued atomically, and a later controlled attempt succeeded. |
| L9 / T9 / T11 | PASS for controlled local fixtures and ImageJudge | Controlled DESeq2/Biopython/Scanpy fixtures completed through Task → Outbox → Worker → Verifier → Artifact. ImageJudge unit suite: 51 passed, including the 500-input dedupe/unsupported/resume batch. This is not live scientific-model proof. |
| L10 / T10 | PASS for browser build and automated UI contract | Frontend lint exit 0 with 7 existing warnings, typecheck exit 0, 28 unit tests passed, production build passed. Coding page is history/status-only; formal submission is the Analysis confirmation card. |
| T12 | PARTIAL | The local frontend was opened in the application browser: Analysis showed the confirmation card, Task Center showed history/status-only copy, and ImageJudge showed its download/usage surface. A non-developer human walkthrough was not performed. |
| T13 | NOT RUN | A 12-hour / five-task overnight soak requires a scheduled long-running environment and was not falsely claimed in this session. |

## Test totals

- Backend focused regression after the final local changes: 51 passed, 3 skipped.
- ImageJudge unit suite: 51 passed.
- Frontend: 28 passed; lint/typecheck/build passed.
- The repository-wide suite is not reported as green because its unconfigured
  PostgreSQL and external literature tests intentionally require services that
  were not enabled for this local run.

## Remaining release gates

1. Apply and directly test scripts/rls_roles.sql on the target release database
   using dedicated non-owner infinity_api and infinity_worker roles, with request
   transactions setting app.user_id / app.worker_id. The isolated clean-DB
   rehearsal is complete; the existing dirty acceptance DB remains unchanged.
2. Run one real Analysis call and one real pinned Claude Code Coding smoke with
   operator-provided credentials; do not put those credentials in Jobs.
3. Perform the human T12 walkthrough and schedule T13’s five-task overnight
   soak. Until these are done, L10 is not release-complete.
