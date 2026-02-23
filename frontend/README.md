# Infinity Agents Frontend

Next.js 16 + React 19 frontend for PaperAgent / CodeAgent / TraitRecognize.

## Runtime Configuration

Use `NEXT_PUBLIC_API_BASE` to point frontend requests to backend API.

```bash
NEXT_PUBLIC_API_BASE=http://localhost:8008
```

If not provided, frontend falls back to:

- Browser `http(s)` pages: `${window.location.protocol}//${window.location.hostname}:8008`
- Non-HTTP contexts (for example `file://`): `http://localhost:8008`

## Commands

```bash
npm run dev
npm run lint
npm run typecheck
npm run test:unit
npm run test:e2e
npm run build
```

## Test Strategy

- Unit tests: `Vitest` + `Testing Library`
- E2E tests: `Playwright` (Chromium)

E2E tests run against `npm run dev` with request mocking for backend routes.
