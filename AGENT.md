# AGENT.md

## Runtime
- Always use `pyenv shell Agent`.
- Backend default: `http://127.0.0.1:8008`
- Frontend default: `http://127.0.0.1:3000`

### Quick start
```bash
pyenv shell Agent
python -m uvicorn backend.app:app --host 127.0.0.1 --port 8008 --reload
cd frontend && npm run dev -- --hostname 127.0.0.1 --port 3000
```

## PaperAgent model policy
- Chat model env: `PAPER_AGENT_CHAT_MODEL` (default: `kimi-k2.5`)
- Workflow model env: `PAPER_AGENT_WORKFLOW_MODEL` (default: `kimi-k2.5`)
- Disable chat thinking by default (required for stable tool-calls on `kimi-k2.5`):
  - `PAPER_AGENT_CHAT_DISABLE_THINKING=1`

## Streaming protocol (WebSocket `/ws/chat`)
Client payload supports:
- `session_id: string`
- `messages: [{ role, content }]`
- `retry_attempt?: number` (default `0`)
- `client_request_id?: string`

Server events:
- `status`:
  - `thinking`
  - `tool_running`
  - `responding`
  - `retrying`
- `tool_call`
- `chunk`
- `done`
- `error`

## First-chunk retry policy
- Enabled by default: 8s timeout, retry once.
- Env switches:
  - `ENABLE_WS_STATUS_EVENTS` (default `true`)
  - `ENABLE_FIRST_CHUNK_RETRY` (default `true`)
  - `FIRST_CHUNK_TIMEOUT_SECONDS` (default `8`)

Rules:
- Retry only when no `chunk` and no `tool_call` within timeout.
- `retry_attempt=0` writes user message.
- `retry_attempt>0` must not write duplicate user message.
- Only final successful attempt writes assistant message.

## Session isolation (PaperAgent)
- New sessions are sandboxed.
- Files are scoped to session path under `papers/sessions/{session_id}`.
- Session-scoped file API:
  - `/api/sessions/{session_id}/files/{file_path}`
- Legacy API `/api/files/{file_path}` remains for legacy sessions only.

## Frontend UX requirements
- Show tool banners when `tool_call` arrives.
- Show live streaming status text from `status` events.
- Show chunk counter while streaming.
- If `status` events are missing, fallback to local "thinking" timer.

## Manual acceptance checklist
- Send a normal prompt and confirm:
  - `status` updates every ~1s
  - `chunk` counter increases
  - final `done` arrives
- Send a tool prompt and confirm:
  - tool banner appears (`正在调用: <tool>`)
  - content still streams
- Retry behavior:
  - with small timeout, observe `retrying` phase
  - ensure only one user message persisted for that turn

## Git workflow
```bash
git add -A
git commit -m "Full workspace commit"
git push origin agent-dev
```
