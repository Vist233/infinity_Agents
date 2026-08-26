# PAPER-01 execution card

- Scope: make the Access Token JWT cryptographic header contract explicit.
- Baseline branch: `cloudflare-deploy`
- Baseline commit: `61adfab9d18e457b076ce8918afc9124124c3273`
- One intended outcome: parse the Access Token header before key selection/import, require `alg=ES256` and a non-empty `kid`, and select only the matching EC/P-256 JWK while preserving existing claim checks.
- Allowed modification surface: `cloudflare-worker/src/jwt.ts`, focused JWT tests, and this card's evidence directory.
- Authorization: local code/tests/evidence only. No deployment, remote D1 migration, R2 write, Processor registration, secret rotation, or Cloudflare configuration change.
- Unrelated workspace changes: Paper contract documents and PAPER-00 evidence are pre-existing/intended context and will not be altered.
