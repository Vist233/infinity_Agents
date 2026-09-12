Known limitations and deliberate gates:

1. Auto Task execution is disabled (`DISCOVERY_AUTO_EXECUTE=false`); therefore
   the real case stops at a persisted evaluated opportunity. No real Worker
   Claim/Claude run/Artifact or recovery test is claimed.
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
6. The live shadow’s fresh BERT paper reached the Paper Processor but that
   external service rejected the resource with
   `PAPER_PROCESSOR_RUNTIME_ERROR`; the Worker now propagates that terminal
   resource failure to the Discovery catalog. The disposable failed paper and
   successful shadow collection remain in the authenticated test account until
   deletion is explicitly confirmed.
