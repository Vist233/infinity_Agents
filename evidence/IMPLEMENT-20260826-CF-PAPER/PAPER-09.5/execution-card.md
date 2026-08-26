# PAPER-09.5 execution card

- Branch: `cloudflare-deploy`
- Card: PAPER-09.5 — contract closure, Processor delivery definition, and backup
- Baseline commit: `61adfab9d18e457b076ce8918afc9124124c3273`
- Baseline remote ref before backup: `origin/cloudflare-deploy` = `61adfab9d18e457b076ce8918afc9124124c3273`
- Scope: PubMed source truthfulness, inactive `approved_url` rejection, versioned dedicated Processor delivery contract/runbook, local gates, review, and source-control backup.
- Out of scope: remote D1/R2/Processor/Redis/Secret operations, deployment, and live Cloudflare acceptance (PAPER-10).

## Completed outcome

- PubMed search results remain the honest `pubmed:<PMID>` reference and carry `availability.kind=abstract_only` with `PUBMED_PMC_NOT_RESOLVED`. Materialization returns `paper_pubmed_full_text_unavailable` and creates no D1 resource. Only a separately controlled `pubmed:PMC<PMCID>` path is eligible.
- The public resource API rejects `approved_url` at its entry point with `PAPER_APPROVED_URL_DISABLED`, before session/resource/link creation.
- `backend/paper_processor/delivery.v1.json` and `docs/PAPER_PROCESSOR_CLOUDFLARE_MANAGED_RUNBOOK.md` define the approved runtime class, immutable image input, non-secret environment names, secret boundaries, singleton/lease, health/restart, redacted logging, and rollback. The absent runtime profile and image digest are explicit blockers, not invented external configuration.

## Review and authorization

- [x] Positive and negative focused tests were added before implementation.
- [x] Mandatory Edge, Processor Python, frontend typecheck/lint/unit/E2E, diff, and secret gates passed.
- [x] Independent checklist review found no blocking local defect and confirmed C7 D1/R2/Redis/Worker-v2 boundaries remain unchanged.
- [x] Owner explicitly authorized one reviewable backup commit pushed only to the existing `origin/cloudflare-deploy` ref.
- [ ] Cloudflare external release authorization: intentionally not granted and not performed.
