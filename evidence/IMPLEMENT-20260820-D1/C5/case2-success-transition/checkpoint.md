# CHECKPOINT IMPLEMENT-20260820-D1 / C5 / case2-success-transition

- baseline commit: `972f5ee`
- branch: `cloudflare-deploy`
- status: Case 2 `PASS`; Case 3 `DEFERRED_BY_OWNER`; Cloudflare release still `PARTIAL`
- Case 2: real Task `3666d0f1-4581-42e3-b81c-bf195288daa5`, Attempt
  `940b483b-a8e6-43ef-a5a5-0598c3872005`, Worker
  `public-worker-75f39f88-f921-4929-9c8d-a9f0c1b57145`, Artifact
  `6cc37651-2bee-4803-a81c-04b6cfbd76fd`, 1,234,445 bytes, SHA-256
  `1885153939abd104471a20e3d332285f86d39c2c8ef1efef5b9a00d5fb5f780c`
- scientific evidence: 94 sequences and parseable 94-tip Newick; ZIP/manifest/hash/cleanup passed
- Case 3: not run by explicit user instruction; this is accepted scope risk, not a pass
- current Worker: local v2 container remains online; D1 poll/heartbeat 200
- Redis: Relay hints remain 503; ACL/recovery/Outbox replay not passed
- C6: local deterministic gates pass; online authenticated browser verification remains open
- C7: final read-only review, same-candidate regression, named Tunnel/rollback record remain open
- tests: frontend 44, Edge 55, focused Python 6, full Python 330 passed/45 skipped; builds/checks pass
- next exact action: perform C5R only with Redis ACL authorization; otherwise proceed with independent C6 and keep C5R blocked
- post-Cloudflare: after genuine C7 completion, follow
  `docs/POST_CLOUDFLARE_MAIN_LOCAL_POSTGRESQL_PLAN_2026-08-20.md`; do not modify main earlier
- external systems modified: none in this card
