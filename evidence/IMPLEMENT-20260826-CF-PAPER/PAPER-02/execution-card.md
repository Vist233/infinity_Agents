# PAPER-02 execution card

- Scope: add the forward-only `chat_events` D1 ledger and legacy `chat_messages` backfill, with repository reads/validation and fake-D1/schema coverage.
- Baseline branch: `cloudflare-deploy`
- Baseline commit: `61adfab9d18e457b076ce8918afc9124124c3273`
- One intended outcome: make chronological conversation events available without changing chat-loop writers yet, while preserving legacy text history and making invalid/oversized event inputs fail closed.
- Allowed modification surface: new `cloudflare-worker/migrations-infinity/0017_chat_events.sql`, `cloudflare-worker/src/db.ts`, `cloudflare-worker/test/fake-d1.ts`, D1 schema tests, focused chat-event tests, and this card's evidence directory.
- Authorization: local code/tests/evidence only. No remote D1 migration, R2 write, Processor registration, deployment, or external system change.
- Unrelated/intended existing changes: PAPER-01's reviewed `jwt.ts`/JWT test and prior evidence, plus the two untracked Paper contract documents, are retained and not modified by this card.
