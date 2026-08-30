# PAPER-FIX-05 — Paper intent materialization orchestration

- Branch: `cloudflare-deploy`
- Baseline: `de4e95eb09cbb70d92715ae255a71fa43901e50e` (`PAPER-FIX-04` local review commit)
- Unique objective: prevent a PDF/full-text paper request from completing after only repeated `search_paper`; persist one safe `materialize_paper` call or return an explicit failure.
- Allowed scope: `cloudflare-worker/src/chat.ts`, `cloudflare-worker/src/prompt.ts`, focused Edge tests, Paper Workspace design/execution documentation, and this evidence directory.
- Prohibited scope: production deployment, Cloudflare configuration/secrets/WAF/D1/R2 writes, remote migrations, Processor/zhangbot/Redis changes, browser claim, Kimi/provider changes, and Git push.
- Rollback: revert the local review commit; no schema, resource, lease, R2, Processor, or external configuration change is part of this card.
