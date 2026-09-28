# Cloudflare frontend delivery (Worker deployment disabled)

The `cloudflare-deploy` branch now delivers a static frontend only. It does
not deploy `infinity-agents-edge`, the historical ImageJudge API Worker, D1,
R2, KV, Durable Objects, routes, or secrets. No online resource is deleted or
modified by this repository change.

## Static build

```sh
cd frontend
npm ci
CLOUDFLARE_EXPORT=1 npm run build
```

The result is `frontend/out/`. Publish that directory only through an
authorized static hosting process. The static build contains the three
product areas—Task Center, Papers, and ImageJudge/Trait Agent—and does not
assume that an HTTPS page can call a user's `localhost` API. Task and paper
pages show the local-runtime entry notice unless an explicit HTTPS API origin
is configured.

## Disabled deployment paths

- `cloudflare-worker/` and `image-judge/apps/worker/` are historical rollback
  material; their default `deploy` npm scripts are removed.
- `wrangler.jsonc` files remain for audit/recovery only and are not an active
  release target.
- Do not run `wrangler deploy`, remote D1 migrations, secret changes, DNS or
  route changes for this frontend-only task.

## Verification

```sh
cd frontend
npm run lint
npm run typecheck
npm run test:unit
npm run build
CLOUDFLARE_EXPORT=1 npm run build
```

The current ImageJudge page links to the existing GitHub Release assets:
Windows `ImageJudge-windows-x64.zip` and Linux
`ImageJudge_0.2.0_amd64.deb`. There is no macOS asset in that release, so the
page links macOS users to the Release page instead of a 404 direct URL.
