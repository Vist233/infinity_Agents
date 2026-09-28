# Historical Cloudflare Edge configuration

This directory is retained for rollback and audit purposes only. The
`cloudflare-deploy` branch now delivers a static frontend with local Task and
Papers runtimes; it does not deploy Cloudflare Workers for the web product or
the ImageJudge page.

The Wrangler configuration and source are intentionally preserved so an
authorized migration can inspect or recover the former Edge API. The default
`deploy` npm script has been removed. Do not run `wrangler deploy`, change
production routes, migrate remote D1, or alter Worker secrets as part of the
static-frontend change.

The historical code can still be type-checked and tested locally when needed:

```sh
npm run check
npm test
```

Those checks do not publish a Worker and do not prove that the retired Edge API
is part of the current product.
