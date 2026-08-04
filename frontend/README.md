# Infinity Agents Frontend

Next.js 16 + React 19 UI served at `https://infinity.zhangyvjing.com` as
static assets by the companion Cloudflare Worker. It is not replaced by an
inline Worker page.

## Authentication and chat

The UI calls same-origin endpoints only:

- `GET /login` starts first-party ZhangYvJing OIDC login.
- `GET /v1/models` determines whether the browser has an Infinity session.
- `POST /v1/chat/completions` streams a chat response for an authenticated
  session; a `401` is presented as a login prompt in the UI.

The Worker owns OIDC, the session cookie, and the upstream model key. The
browser never receives either secret.

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

`npm run build` produces `out/`. The Worker configuration serves that directory
through its `assets` binding when deployed.

## Test Strategy

- Unit tests: `Vitest` + `Testing Library`
- E2E tests: `Playwright` (Chromium)

E2E tests run against `npm run dev` with request mocking for backend routes.
