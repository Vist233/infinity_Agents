# CHECKPOINT IMPLEMENT-20260826-CF-PAPER / PAPER-FIX-06

- status: `COMPLETE` for PAPER-FIX-06 only; this does not mark PAPER-10 or the overall Paper Workspace complete.
- baseline/current commit: baseline `f755d99d6f9997b4035e886b36ca840ab19ba097`; the local review commit containing this card is created after evidence staging and is reported in the final handoff.
- one completed outcome: fresh and cached `search_paper` records now pass through one normalization boundary; canonical arXiv records with absent availability are explicitly materializable, while PMID-only PubMed records remain abstract-only and cannot be turned into PMCID refs.
- modified files: `cloudflare-worker/src/tools.ts`; `cloudflare-worker/test/tools.test.ts`; the governing Design and Execution Plan; and this evidence directory.
- focused tests and exit codes: test-first focused Edge run exit `1` as expected; final tools/chat focused run 28/28 exit `0`.
- mandatory Edge suite result: `npm run check` exit `0`; complete Edge suite 26 files / 152 tests exit `0`.
- affected checks: Processor pytest 12/12 exit `0`; frontend typecheck exit `0`; lint exit `0`; unit 16 files / 78 tests exit `0`; E2E 15/15 exit `0` after the retained local-listener EPERM environment retry.
- real D1/R2/browser evidence: not authorized/not run for this card. No browser claim was made. The reported F5 production symptom is documented as an input fact, not re-run here.
- failed or skipped required checks: the first sandbox E2E attempt failed before test execution with `EPERM` on local port 3000; the permitted local rerun passed. No required check remains failed.
- D1/R2/Redis/external systems modified: none. No deployment, migration, Cloudflare rule/secret, Processor/zhangbot, browser-session, provider, or Git push operation ran.
- secret scan result: changed-scope raw no-match scan normalized to `PASS`; `git diff --check` exit `0`. No secret value was read or emitted.
- rollback commit/operation: revert the local review commit if needed. Preserve existing D1/R2 resources, chat events, continuations, leases, Processor state, and production configuration.
- remaining risks and non-goals: this card does not prove live production behavior, model/provider entitlement, Paper Processor processing, PDF/page/image acceptance, or PAPER-10 release. A fresh upstream record is still subject to the existing canonical-ref and session/ownership gates.
- next exact card/action: prepare a versioned PAPER-10 release containing PAPER-FIX-06, then repeat the authenticated F5 path and verify fresh arXiv search -> durable resource/continuation -> Processor readiness -> page text/image reads and ownership negatives. Do not claim overall completion until PAPER-10 passes.
