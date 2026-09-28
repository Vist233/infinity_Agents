# Infinity Agents Frontend

Next.js 16 + React 19 UI. The cloud build is a static browser shell with three
entry points: Task Center, Papers, and ImageJudge/Trait Agent.

Task execution and paper data stay in the local application. A static cloud
page does not assume it can call a user's `localhost`: HTTPS mixed-content,
Local Network Access, CORS, credential-cookie, and CSRF rules make that an
explicit deployment contract rather than a reliable default. Without an
explicit HTTPS API origin, the Task Center and Papers pages show instructions
for opening the local runtime.

With no override, the notice opens `http://localhost:3000/task-center/`; set
`NEXT_PUBLIC_LOCAL_APP_URL` when the local UI uses another address.

## Local runtime APIs

The local application provides the authenticated task and paper APIs used by
the corresponding workspaces. The old Paper Chat/SSE UI is not a public entry.

`NEXT_PUBLIC_API_BASE` may point at an explicitly provisioned API origin. In a
static build, it must be HTTPS; otherwise browser API calls are disabled and
the page remains an entry-point notice.

For the local Next.js development server, `/api/*` and `/auth/*` proxy to the
FastAPI runtime on `http://localhost:8008` by default. Set `API_PROXY_TARGET`
when the local backend uses another address.

## ImageJudge/Trait Agent download page

`/image-judge` is the public product page for the desktop ImageJudge client.
It explains the reference-guided visual classification workflow and links to
the existing GitHub Release assets. The current release provides the Windows
ZIP and Linux amd64 DEB; it does not provide a macOS asset. The web page does
not package a local desktop build.

## Commands

```bash
npm run dev
npm run lint
npm run typecheck
npm run test:unit
npm run test:e2e
npm run build
```

`CLOUDFLARE_EXPORT=1 npm run build` produces the static `out/` browser shell.
The ordinary `npm run build` keeps Next's server mode for local/acceptance use.

## Test Strategy

- Unit tests: `Vitest` + `Testing Library`
- E2E tests: `Playwright` (Chromium)

E2E tests run against `npm run dev` with request mocking for backend routes.
