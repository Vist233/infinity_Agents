# PAPER-FIX-06 — Fresh paper search availability normalization

- Branch: `cloudflare-deploy`
- Baseline: `f755d99d6f9997b4035e886b36ca840ab19ba097` (`PAPER-FIX-05` local review commit)
- Unique objective: ensure trusted fresh arXiv search records reach the model and the bounded materialization selector with an explicit materializable availability contract, while keeping PMID-only PubMed results abstract-only.
- Allowed scope: `cloudflare-worker/src/tools.ts`, focused Edge tool tests, the Paper Workspace design/execution documents, and this evidence directory.
- Prohibited scope: production deployment, Cloudflare configuration or secrets, remote D1/R2 writes or migrations, Processor/zhangbot/WAF/Redis changes, browser claim, provider changes, and Git push.
- Rollback: revert this local review commit. No schema, resource, continuation, lease, R2 object, Processor state, or external configuration is changed by this card.
