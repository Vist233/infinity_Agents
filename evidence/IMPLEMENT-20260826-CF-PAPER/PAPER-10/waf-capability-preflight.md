# PAPER-10 minimum WAF capability preflight

- Started: 2026-08-28
- Branch: `cloudflare-deploy`
- Baseline commit: `01a596619f3bb9ac1506c503e81738d4f5381ff3`
- Remote baseline: `origin/cloudflare-deploy` matched the same commit.
- Baseline worktree: clean.
- Scope: read-only validation of the owner-provided short-lived Cloudflare
  WAF capability token before any API use; no WAF rule, secret, deployment,
  D1/R2, zhangbot, Redis, Relay, or Cloudflared write is in scope until the
  token precondition passes.

## Preflight result

- The metadata-only check verified that the expected token file exists and is
  owned by the current user.
- The file mode was `0644`; the required mode is `0600`.
- The metadata check exited with code `4` for the permission mismatch.
- Token contents were not opened, printed, copied, hashed, passed as a
  command argument, sent to a network request, or written to evidence.
- No Cloudflare API request was made, so account/zone/WAF read capability and
  rule capacity remain unverified. No external system was modified.

## Blocker and required next action

Status: `BLOCKED_WAF_TOKEN_PERMISSIONS`.

The owner must change the short-lived token file to mode `0600` without
revealing its contents, then ask to resume PAPER-10. The next run must repeat
the metadata-only check, verify the exact zone and WAF Rulesets read/write
capability, and stop again if any capability or target does not match. No
Cloudflare rule, secret rotation, Processor deployment, or live acceptance may
begin before those read-only checks pass.

Rollback: none; no external write occurred. The existing GitHub backup and
previous D1 metadata are unchanged.

## 2026-08-28 corrected-token WAF preflight and rollback

- Baseline/current commit: `84edb2cd34919ecb42d3ea7af7f1704c471adc21` on
  `cloudflare-deploy`; the worktree was clean before this evidence update.
- The token file metadata check exited `0`: the file was present, owned by the
  current user, and mode `0600`. Its value was never printed, logged, copied,
  hashed, or written to the repository/evidence.
- Secure read-only Cloudflare requests used the token only through an
  Authorization header supplied on stdin. Token verification exited `0` with
  HTTP `200` and status `active`. The account and zone convenience reads each
  exited `0` with HTTP `403`, API error `9109` (`Unauthorized to access
  requested resource`); this least-privilege token does not expose those
  broader reads. The authenticated target rulesets read exited `0` with HTTP
  `200`, `success=true`, and four pre-existing non-custom rulesets. The
  `http_request_firewall_custom` entrypoint read exited `0` with HTTP `404`
  and API error `10003`, proving that no custom entrypoint/rule order existed
  to overwrite. The configured zone/account identity remains the previously
  verified target recorded in this card; the WAF-scoped token's rulesets path
  accepted that exact zone ID.
- After the read-only gate, the exact additive zone entrypoint write exited
  `0` with HTTP `200`. The created entrypoint ID was
  `823074a217994347a3af06ee6e6f4a28` and the created rule ID was
  `8ee926f7fcf34736bbe565b2adbe0396`. The immediate readback exited `0` with
  HTTP `200` and validated the exact fixed source IP, host, three POST paths,
  one PUT path, `action=skip`, `products=["bic"]`, `logging.enabled=true`,
  `enabled=true`, and no other action-parameter scope. No wildcard, IP
  Access Allow, whole-host match, or other skipped product was used.
- The subsequent immutable artifact preflight found a hard mismatch before
  any Secret, Processor, Edge, D1, R2, or zhangbot deployment write:
  current Processor source aggregate
  `510715c4a3e8605181219508d38bd8747b1fff28a7c676fb64d15fd1ed57d15e`
  differs from the checked-in delivery-definition value
  `ce76a75997ebff53c10a1baf2beb2631b66c8fb5a6740b469ba8bf04bf381813`.
  The dependency-lock hash and service-unit hash still match their pinned
  values. The release was therefore not safe to install from this artifact.
- Per capability-first rollback, a readback before deletion confirmed the
  entrypoint contained exactly the newly created marker rule. Rule deletion
  exited `0` with HTTP `200`; the following readback exited `0` with HTTP
  `200`, zero rules, and no marker. Entrypoint deletion exited `0` with HTTP
  `204`. The wrapper command's exit code was `45` only because its local
  assertion incorrectly accepted `200` but not the successful `204`; this was
  not an API failure. An independent final read-only entrypoint read exited
  `0` with HTTP `404`/error `10003`, and a ruleset list exited `0` with HTTP
  `200`, four original rulesets, and no custom firewall entrypoint.

## Stop decision

Status: `BLOCKED_PROCESSOR_ARTIFACT_HASH_MISMATCH`.

No Secret/token, Processor release/service, Edge deployment, D1 migration,
R2 object, Redis, Relay, or Cloudflared change was performed. The WAF rule and
entrypoint created in this subphase were fully removed and verified absent.
`deployment.txt` remains intentionally absent and no PASS checkpoint is
asserted. The next exact action is to reconcile the checked-in source
aggregate hash with the current fixed-endpoint release definition in a local
reviewed change, rerun all local gates and an immutable preflight, then repeat
the WAF/production sequence only after the hashes match. Do not rerun D1
migrations `0017`–`0021`.
