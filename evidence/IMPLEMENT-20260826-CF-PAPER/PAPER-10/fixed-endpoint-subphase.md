# PAPER-10 fixed internal endpoint protocol subphase

- Started: 2026-08-28
- Branch: `cloudflare-deploy`
- Baseline commit: `5ca83c60c6247e3271a639544c4233a791ef7860`
- Baseline state: clean worktree; `origin/cloudflare-deploy` read-only verified
  at the same commit.
- Card: PAPER-10 — replace dynamic Processor URL paths with fixed internal
  endpoints that remain expressible on Cloudflare Free.

## Single objective

Move every Processor operation whose URL currently contains an attempt or
object identifier onto fixed paths carrying a strictly validated JSON
operation envelope or fixed upload envelope. Keep the public browser/API
protocol unchanged. The resulting Cloudflare exception must need only the
fixed host, zhangbot source IPv4 `39.105.204.121`, HTTP method, and a finite
path set; it must skip only BIC and must not broaden any other security
control.

## Allowed scope

- Paper Processor client and Edge Processor routing/validation only.
- Fixed-endpoint positive/negative tests, delivery contract, design,
  execution-plan, runbook, and PAPER-10 evidence.
- Preserve D1/R2/Redis/Relay/Cloudflared contracts and all public browser/API
  routes. No external Cloudflare or zhangbot write is authorized in this
  subphase.

## Required safety properties

- The Worker validates operation allowlists, request shape, Processor source
  IP/ID/bootstrap secret, session, lease, fencing epoch, attempt/resource
  ownership, and object kind before any D1/R2 mutation.
- Clients cannot choose a URL path, R2 key, attempt/resource outside the
  server-side operation mapping, or an operation not in the allowlist.
- The old dynamic Processor paths are removed from the client and are not
  retained as compatibility routes that bypass the fixed-endpoint gate.
- Fixed paths are internal Processor paths only; public browser/API routes are
  unaffected.

## Rollback boundary

If a local gate fails, revert only this uncommitted subphase. If a future
external rollout occurs after a separate authorization, restore the prior
reviewed Edge/Processor versions and revoke only newly issued Processor
capabilities; preserve D1/R2 metadata and leave Redis/Relay/Cloudflared
untouched.

## Local verification outcome

- Focused Edge fixed-route/contract tests: 23/23, exit code 0.
- Processor runtime/ingestion tests: 12/12, exit code 0.
- Full Edge check/test: TypeScript check exit code 0; 128/128 tests, exit
  code 0.
- Frontend typecheck, lint, and unit: all exit code 0; 50/50 unit tests.
- Frontend E2E: 13/13, exit code 0 after the permitted local-server retry;
  the sandbox-only bind attempt failed with `EPERM` before assertions.
- `git diff --check`: exit code 0. Changed-scope secret scan: raw no-match
  exit code 1, normalized gate exit code 0.

The local protocol gate passes. PAPER-10 remains
`BLOCKED_PROCESSOR_EDGE_ACCESS` / `WAITING_MINIMUM_WAF_CAPABILITY` because no
Cloudflare zone rule was created or read back in this subphase. No Cloudflare,
zhangbot, D1/R2 object, Redis, Relay, or Cloudflared write occurred.
