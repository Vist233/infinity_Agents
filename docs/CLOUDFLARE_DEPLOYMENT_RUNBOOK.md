# Frontend and ImageJudge compatibility delivery

Approved migration: 2026-10-03. Tasks, papers and chat run in the native local
PostgreSQL runtime. Cloudflare hosts static entry points and the existing
ImageJudge desktop compatibility APIs. GitHub Release assets are unchanged.

## Build and publish

```sh
cd frontend
CLOUDFLARE_EXPORT=1 npm run build
cd ../cloudflare-worker
npm run check
npm test -- --run test/frontend-edge.test.ts
# Only after explicit authorization to deploy:
npx wrangler deploy --config wrangler.frontend.json --keep-vars
```

The active configuration is `wrangler.frontend.json`, with
`src/frontend-edge.ts` as the entry point and an empty cron list. The original
`wrangler.jsonc` / `src/index.ts` retain the historical backend for rollback;
do not use them for a normal release. No default npm deployment script or CI
workflow is enabled.

The main domain serves new assets. ImageJudge `/image-judge/desktop/*`,
`/image-judge/auth/*`, `/image-judge/api/*`, `/image-judge/healthz`, and the old
`/auth/login`, `/auth/callback`, `/auth/logout` remain compatible. The old
`/api/*` namespace returns 410 with `LOCAL_RUNTIME_REQUIRED`, including cloud
Worker/processor protocols. External agents still configured to call the old
control plane must be stopped or redirected by their operators; rejecting
requests at Edge does not prove those external processes have stopped.

D1, R2, KV, Durable Objects and secrets remain attached for retention and
compatibility. `--keep-vars` retains live variables not listed in the file.
Do not delete shared `zhang-auth` or cloud data during this cutover.

## Verification and rollback

Verify `/health` reports `frontend-imagejudge-compatibility`, old cloud APIs
return 410, ImageJudge health responds 200, and the deployed schedule list is
empty. Browser-check all three front-end entry points and Release links.

Previous version: `2328d714-18a1-4044-b0d4-02b7c791324b`.
A private local Infinity D1 export was retained before cutover; its content
must not be committed or published. R2 data remains in place.

Rollback requires explicitly authorized rollback of the old Worker version
and restoration of `* * * * *` scheduling. Restoring a code version alone must
not be assumed to restore trigger configuration. Preserve the new deployment
ID and the old configuration in the deployment report.

An independent static Pages copy remains at
https://infinity-frontend-98x.pages.dev/.
