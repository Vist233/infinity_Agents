# CHECKPOINT IMPLEMENT-20260820-D1 / C6 / authenticated-browser-blocked-20260820

- baseline candidate: `cloudflare-deploy@3c6cbae` before this evidence-only card; latest re-verification candidate: `cloudflare-deploy@2232f0b6aa499901c3bf1e31f136f9cdb6b1e428`.
- deterministic gates: **PASS** — frontend 44 unit tests, typecheck, lint, build; 11 local controlled Playwright tests; Edge 55 unit tests and TypeScript check; Python/Worker 330 passed with 45 skipped.
- static route boundary: Worker v1 has only the intentional `410 LEGACY_WORKER_PROTOCOL_DISABLED` compatibility route; no production caller was found. The static `preview` shell is an Assets export mechanism for dynamic Task URLs, not a preview Task API or data source.
- browser target: an existing authenticated Case 2 Task Center tab at real Task ID `3666d0f1-4581-42e3-b81c-bf195288daa5`.
- browser result: **NOT PASSED**. The Chrome extension/native-host diagnostics report installed/enabled/correct, but two bounded fresh browser-control attempts timed out while claiming or accessing visible page state. No live UI assertion, task creation, Artifact page download, signed-out state, or responsive layout assertion is claimed.
- unresolved C6 gate: complete the required checks in a working authenticated browser session without calling preview Task, Worker v1, or old PostgreSQL routes.
- Case 3 remains `DEFERRED_BY_OWNER`, not PASS.
- next card: C5R is now passed in `../C5R/redis-acl-recovery-20260820/`. Complete this live-browser gate after restoring browser control; named Tunnel remains pending Cloudflare Zone DNS Edit authorization. C7 remains blocked by C6 and named Tunnel.
