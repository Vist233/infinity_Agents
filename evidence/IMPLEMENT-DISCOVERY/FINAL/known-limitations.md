Known limitations and deliberate gates:

1. Auto Task execution is disabled (`DISCOVERY_AUTO_EXECUTE=false`) after one
   explicitly selected live Task was materialized. The Task Center/idempotency
   and Redis recovery checks passed, but three real Worker Claims/Attempts
   expired before a Claude terminal event or Artifact; successful Worker
   execution and selected-Task Artifact/download acceptance remain open. A
   second distinct scoped Task was later selected once for the repaired Worker
   path, but its first Attempt could not be finalized after the D1 write path
   became unavailable.
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
   control-plane write path returned bounded 503s to both repaired Worker
   connects after the second Task's lease expired. The exact Cloudflare
   provider/quota cause was not asserted from redacted status-only evidence.
   The Edge now isolates transient session/renew/recovery batches, but the
   stranded Task must be reconciled by the normal scheduler after write
   availability returns; no manual D1 status write was made.
