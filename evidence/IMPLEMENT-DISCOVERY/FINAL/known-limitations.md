Known limitations and deliberate gates:

1. Auto Task execution is disabled (`DISCOVERY_AUTO_EXECUTE=false`) after four
   explicitly selected Discovery Tasks and one scoped diagnostic Task were
   materialized. The Task Center/idempotency
   and Redis recovery checks passed, but three real Worker Claims/Attempts
   expired before a Claude terminal event or Artifact; successful Worker
   execution and selected-Task Artifact/download acceptance remain open. A
   second distinct scoped Task was later selected once for the repaired Worker
   path. Its first Attempt could not be finalized while the D1 write path was
   unavailable; after availability returned, the normal scheduler ran the
   existing Task through three Attempts and it terminally failed with no
   Artifact. The later scoped r6 public-data diagnostic Task completed with one
   published Artifact and an authenticated download whose size and SHA-256
   matched D1, but it does not replace the failed evaluated-match Task.
2. Literature watcher is implemented but disabled
   (`DISCOVERY_LITERATURE_ENABLED=false`); two live cron rounds were not run.
3. The production paper profile smoke used the deterministic compiler. The
   optional Moonshot JSON path is contract-tested but no live provider call was
   enabled in this rollout.
4. The first public ZIP trial exposed that UCI's semicolon-delimited CSV was
   parsed as one column by the old Processor image. Commit 008b905 fixed
   delimiter detection; a fresh CSV upload was then reprocessed and passed.
   The earlier diagnostic row remains rejected and was not hand-edited.
5. The production browser E2E smoke used public test inputs and an authenticated
   browser session. Full Playwright tests use deterministic route fixtures; the
   real Cloudflare path is covered by the separate production smoke evidence.
6. The first live BERT shadow reached `finalizing` after download, extraction,
   and object publication, but the pre-remediation Processor returned the
   generic `PAPER_PROCESSOR_RUNTIME_ERROR`; its exact remote response was not
   recoverable without violating the safe logging boundary. The lifecycle
   Worker fix now propagates future terminal resource failures to the Discovery
   catalog, and the remediation release adds bounded stage/family diagnostics.
   A fresh public ResNet equivalent completed successfully on that release.
   The historical failed paper and successful shadow collection remain in the
   authenticated test account until deletion is explicitly confirmed.
7. During the 2026-09-13 follow-up, D1 reads remained available but the
   control-plane write path initially returned bounded 503s to both repaired
   Worker connects after the second Task's lease expired. The exact
   Cloudflare provider/quota cause was not asserted from redacted status-only
   evidence. After the user-confirmed availability reset, normal scheduler
   recovery ran that existing Task through three Attempts; it terminally
   failed with the sanitized `agent_completion.json contains credential-like
   content` error and no Artifact. No manual D1 status write was made.
8. A subsequent offline-only hardening pass covers browser auth and Discovery
   persistence behavior during write failures and passed local regressions, but
   it was not live-deployed or validated against the selected Task. See
   `D14/final-regression/auth-discovery-hardening-20260913.md`.
9. The first post-reset scanner repair was exercised by one distinct r4 live
   Task, which again failed at `agent_completion.json` with no Artifact. Its
   payload was cleaned before retention; whether either live match contained a
   real credential or an ambiguity in free-form metadata is therefore
   unproven. A second repair now parses the JSON before scanning decoded
   strings, rejects duplicate keys, and preserves true credential-shaped
   rejection. It was synchronized to the compatible r5 image and exercised by
   one final distinct live Task, which again failed with no Artifact. The exact
   payload remains unavailable. A subsequent v3 diagnostic r6 image passed one
   controlled public-data Task with a single Artifact and matching download;
   no further Task is created under the stop rule. See
   `D14/final-regression/artifact-scanner-repair-20260913.md`.
10. The v4 completion-metadata canonicalizer is pushed as `3570170` and has
    passed 389 Python tests (45 skipped), including targeted archive/runtime
    coverage. A uniquely tagged r7 image was built and verified locally, but
    its private image transfer to the Windows host is pending explicit
    authorization. The deployed Workers therefore remain on r6, no new live
    Task was created, and the evaluated-match gate remains open.
