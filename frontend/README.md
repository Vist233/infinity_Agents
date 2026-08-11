# Infinity Agents Frontend

Next.js 16 + React 19 UI served at `https://infinity.zhangyvjing.com` as
static assets by the companion Cloudflare Worker. It is not replaced by an
inline Worker page.

## Authentication and chat

The PaperAgent UI calls the same-origin session API:

- `GET /auth/login` starts first-party Zhang Auth login.
- `GET /api/sessions` loads the authenticated user's recent activities.
- `POST /api/sessions` creates a conversation.
- `GET /api/sessions/:id/messages` loads conversation history.
- `PATCH /api/sessions/:id/title` and `DELETE /api/sessions/:id` manage a
  conversation.
- `POST /api/chat` returns the authenticated Agent response as an SSE stream.

The Worker owns OIDC, the opaque session cookie, the Infinity D1 session data,
and the upstream model key. The browser never receives provider secrets.

## ImageJudge download page

`/image-judge` is the public product page for the desktop ImageJudge client.
It explains the reference-guided visual classification workflow and links to
the latest GitHub Release. The release workflow on `main` publishes a Windows
archive containing `ImageJudge.exe` and a Linux `.deb` package; the page itself
remains part of the `cloudflare-deploy` branch and is served by the Infinity
Edge Worker.

## Commands

```bash
npm run dev
npm run lint
npm run typecheck
npm run test:unit
npm run test:e2e
npm run build
```

`CLOUDFLARE_EXPORT=1 npm run build` produces `out/` for the Cloudflare Worker.
The ordinary `npm run build` keeps Next's server mode for local/acceptance use.

## Test Strategy

- Unit tests: `Vitest` + `Testing Library`
- E2E tests: `Playwright` (Chromium)

E2E tests run against `npm run dev` with request mocking for backend routes.
