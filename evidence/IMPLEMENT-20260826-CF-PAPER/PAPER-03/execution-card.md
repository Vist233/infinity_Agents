# PAPER-03 execution card

- Scope: cut new chat writes to the durable event ledger and rebuild provider-valid history from complete events.
- Baseline branch: `cloudflare-deploy`
- Baseline commit: `61adfab9d18e457b076ce8918afc9124124c3273`
- One intended outcome: persist user events, assistant tool calls, tool results, final assistant text, terminal failures, and request correlation; make refresh/idempotent replay safe without dual-writing `chat_messages`.
- Allowed modification surface: `cloudflare-worker/src/chat.ts`, `cloudflare-worker/src/db.ts`, `cloudflare-worker/test/chat.test.ts`, `cloudflare-worker/test/fake-d1.ts`, and this card's evidence directory. PAPER-02 migration remains additive and unchanged.
- Authorization: local code/tests/evidence only. No remote D1 migration, R2 write, Processor registration, deployment, or external system change.
- Unrelated/intended existing changes: PAPER-01/PAPER-02 changes, their evidence, and the two untracked Paper contract documents are retained and not treated as new scope.
