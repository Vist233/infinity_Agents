# CHECKPOINT IMPLEMENT-20260820-D1 / C6 / authenticated-browser-pass-20260821

- baseline candidate: `cloudflare-deploy@63d8a0f` before this evidence-only card.
- result: **PASS**. A newly created Chrome tab reused the real authenticated user session and loaded
  the production Task Center, Analysis, ImageJudge and Case 2 Task detail.
- previous timeout root cause: the pre-existing Infinity tab was still owned by a stale prior
  browser-control session. A new controller could discover that tab but could not claim it, producing
  the repeated 30-second timeout. Opening a new tab succeeded immediately; this was not an Infinity
  API, authentication, page-load or Chrome-extension failure.
- product assertions: navigation contains only Analysis, Task Center and ImageJudge; Task Center
  retains direct creation, task history and Worker management; the authenticated account footer is
  present; the real Case 2 detail shows one succeeded Attempt, published Artifact and canonical events.
- Artifact assertion: Chrome downloaded `result.zip`; the scoped local copy was 1,234,445 bytes,
  passed ZIP integrity testing and matched SHA-256
  `1885153939abd104471a20e3d332285f86d39c2c8ef1efef5b9a00d5fb5f780c`.
- responsive assertion: the production page rendered the mobile workspace-menu control at 390x844.
  The live follow-up drawer click lost the automation kernel, so it is not claimed as live-click proof;
  the deterministic local Playwright suite covers drawer and signed-out interactions and remains 11/11.
- route boundary: source/tests continue to prove direct creation uses `/api/tasks/direct` with
  `agent_confirmation=false`; there is no `/api/tasks/preview` production call; Worker v1 exposes only
  the intentional 410 compatibility response.
- no external state was changed by this card. No Task, Worker, D1/R2 row, Redis key or Tunnel was changed.
- the earlier `authenticated-browser-blocked-20260820` card remains historical failure evidence and is
  superseded by this successful card.
- remaining release gates: complete the named production Relay Tunnel and then C7 final same-candidate
  review/regression. Case 3 remains `DEFERRED_BY_OWNER`, not PASS.
