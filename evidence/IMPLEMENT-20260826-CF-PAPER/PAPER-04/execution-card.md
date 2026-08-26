# PAPER-04 execution card

- Branch: `cloudflare-deploy`
- Baseline commit: `61adfab9d18e457b076ce8918afc9124124c3273`
- Card: PAPER-04 — Tool timeline API and frontend restoration
- Objective: expose only bounded, correlated tool/status SSE events; return a safe collapsed timeline from authorized session history; hydrate and render it in the browser without exposing R2 keys, local paths, secrets, or unbounded payloads.
- Allowed changes: Edge session-history/SSE protocol, `frontend/lib/ws/chat-stream.ts`, `frontend/hooks/use-chat-controller.ts`, related chat state/message presentation, focused frontend/Edge tests, and PAPER-04 evidence.
- Excluded: paper-resource schema/object routes, dedicated processor, source admission, PDF extraction, deployment, remote D1/R2/Redis/Processor writes, and unrelated refactors.
- Pre-existing worktree state: PAPER-01 through PAPER-03 local product changes and evidence are retained; the two user-provided design/plan documents remain untracked and untouched. No unrelated edits are included in this card.
- External authorization: not granted; no external system mutation is permitted.

## Acceptance checklist

- [ ] Safe correlated `tool_call`, `tool_result`, and processing-status SSE payloads are emitted and parsed.
- [ ] Session history returns bounded, collapsed event summaries after ownership validation.
- [ ] Frontend hydrates durable timeline state on reload and displays expandable tool rows.
- [ ] Legacy text-only history remains readable and is labeled.
- [ ] Negative paths cover malformed SSE, foreign-session history, and bounded long payloads.
- [ ] Focused tests, frontend checks, mandatory Edge checks, and required E2E/browser checks pass.
