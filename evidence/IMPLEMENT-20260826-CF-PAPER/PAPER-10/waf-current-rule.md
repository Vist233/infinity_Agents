# PAPER-10 active fixed-endpoint BIC-only WAF rule

Date: 2026-08-29
Branch: `cloudflare-deploy`

## Read-only capability preflight

- The scoped WAF token file metadata passed the required `0600` check. Its
  contents were never printed, hashed, copied, placed in an argument, or
  written to evidence.
- Authenticated Rulesets read capability returned HTTP `200` and showed four
  existing non-custom rulesets. The custom firewall entrypoint was absent
  before creation. No existing rule was edited or replaced.
- The target zone is the previously verified `zhangyvjing.com` zone; the
  fixed Processor source IPv4 is `39.105.204.121`.

## Authorized additive write and immediate readback

- The zone-level custom ruleset creation exited `0` and returned HTTP `200`.
- New custom entrypoint ID: `65e15547ea3144feb70791fc155d1df0`.
- New rule ID: `5695e7eb000c4f49b77a616cff1411ae`.
- Immediate readback exited `0` and returned HTTP `200`.
- Readback validation: `PASS`; `success=true`, phase
  `http_request_firewall_custom`, kind `zone`, one rule, enabled, and
  logging enabled.
- Readback action: `skip` with exactly `products=["bic"]`.
- Readback expression, reproduced without wildcard expansion:

  ```text
  (ip.src eq 39.105.204.121 and http.host eq "infinity.zhangyvjing.com" and ((http.request.method eq "POST" and http.request.uri.path in {"/api/paper-processor/connect" "/api/paper-processor/poll" "/api/paper-processor/control"}) or (http.request.method eq "PUT" and http.request.uri.path eq "/api/paper-processor/object")))
  ```

- The rule is limited to the four fixed method/path pairs: POST `connect`,
  POST `poll`, POST `control`, and PUT `object`. It does not match dynamic
  attempt/object paths, non-Processor paths, other source IPs, or other
  methods. No whole-host, IP Access Allow, wildcard, or other skipped product
  was created.

## Current external boundary and rollback

- This is the only active external change in the current Paper Processor
  release attempt. No Edge shared secret, Processor token, zhangbot release or
  service, D1 migration, R2 object, Redis, Relay, or Cloudflared write has yet
  occurred in this attempt.
- If a subsequent release or live-acceptance step fails, delete rule
  `5695e7eb000c4f49b77a616cff1411ae`, delete empty entrypoint
  `65e15547ea3144feb70791fc155d1df0`, and read back absence before revoking
  the newly created secret/token and removing the Processor release. Preserve
  D1 migrations and existing Redis/Relay/Cloudflared services.

## Post-failure rollback (2026-08-29)

- The rule and entrypoint listed above were deleted after the failed token
  handoff. Rule deletion returned HTTP `200`; entrypoint deletion returned
  successful HTTP `204`, and a read-only readback returned HTTP `404`.
- The active-rule section above is historical for that attempt. No WAF rule is
  active after this rollback; a later retry must create a new exact rule and
  read it back before any capability handoff.

## 2026-08-29 post-rollback WAF precondition

- Secure read-only token verification returned HTTP `200` with active status;
  target-zone Rulesets read returned HTTP `200` with the four pre-existing
  non-custom rulesets; and the fixed custom entrypoint read returned HTTP
  `404`/API error `10003`.
- No WAF rule is active at this baseline. The next authorized WAF write must
  create a fresh zone-level custom rule matching only source
  `39.105.204.121`, host `infinity.zhangyvjing.com`, POST `connect`/`poll`/
  `control`, and PUT `object`, with action `skip` and `products=["bic"]`, then
  read back exact expression, method/path scope, enabled/logged state, and
  product list before any secret/token handoff.

## 2026-08-29 retry exact WAF rule and readback

- The first create request in this retry was rejected before creating an
  entrypoint: HTTP `400`, API error `20127` (invalid expression). The
  immediate post-attempt entrypoint read remained HTTP `404`/error `10003`.
  No partial rule or entrypoint was present. The retry changed only the
  non-secret expression formatting to the documented inline-set form with
  spaces inside the set; it did not widen the source, host, method, or path
  contract.
- The corrected additive zone-level create returned HTTP `200`/curl exit `0`.
  New entrypoint ID: `6a212d8fb2444135a6b2511e7d8ad8d0`; new rule ID:
  `a7f6a28a87624da28d595a11eeb5d92b`.
- Immediate readback returned HTTP `200`/curl exit `0`. The independent
  value-free semantic validator returned `PASS`: `success=true`, kind `zone`,
  phase `http_request_firewall_custom`, exactly one enabled/logged rule,
  action `skip`, action parameters exactly `products=["bic"]`, no wildcard,
  and the exact expression:

  ```text
  (ip.src eq 39.105.204.121 and http.host eq "infinity.zhangyvjing.com" and ((http.request.method eq "POST" and http.request.uri.path in { "/api/paper-processor/connect" "/api/paper-processor/poll" "/api/paper-processor/control" }) or (http.request.method eq "PUT" and http.request.uri.path eq "/api/paper-processor/object")))
  ```

- This rule is now the only active Paper-release WAF change. It does not
  except non-zhangbot IPs, non-Processor paths, other methods, dynamic paths,
  or other security products. The next permitted operation is the Edge
  shared-secret write and corrected one-time zhangbot token handoff; D1
  migrations remain untouched.

## 2026-08-29 paired capability handoff

- After the exact WAF readback, the authorized Edge shared-secret write and
  name-only readback both exited `0`; the value was not read back. The same
  one-time stdin stream produced a zhangbot token file with mode `600`, one
  line, one key, and 64-hex shape; independent post-read exited `0`.
- The exact WAF entrypoint/rule above remains active. No Processor release,
  service, R2 object, D1 migration, or Edge code deployment has followed.
  If release or acceptance fails, delete rule `a7f6a28a87624da28d595a11eeb5d92b`
  and entrypoint `6a212d8fb2444135a6b2511e7d8ad8d0`, read back 404, then revoke
  the new Edge secret, remove the zhangbot token, and remove only the new
  release/service. Preserve D1/R2 metadata and existing host services.

## 2026-08-29 archive-precondition rollback

- The current-HEAD archive precondition failed before transfer because the
  available local package was named for a later evidence state than the HEAD
  computed by the transfer wrapper. The active rule above was therefore
  removed before revoking other capability material.
- Rule deletion returned HTTP `200`/curl exit `0`; empty-entrypoint deletion
  returned HTTP `204`/curl exit `0`; final entrypoint readback returned HTTP
  `404`/curl exit `0`. Edge secret deletion was then retried with Wrangler's
  supported confirmation input after the unsupported `--yes` option returned
  exit `1`; name-only readback showed the binding absent. zhangbot token and
  staging were removed.
- No WAF rule is active now. A future retry must create a fresh rule only after
  packaging and validating an archive named for the exact current HEAD.

## 2026-08-29 post-rollback fresh capability preflight

- The mode-`0600` WAF token remains available and was used only through a
  secure stdin header channel. Token content was not printed, hashed, copied,
  or recorded. Rulesets read returned HTTP `200`; the fixed custom entrypoint
  returned HTTP `404`/error `10003` and no custom rule is active.
- The current exact source/wheel archives and all read-only Cloudflare and
  zhangbot preflight checks passed. No WAF write has occurred in this new
  attempt. The next permitted operation is one fresh exact four-pair
  BIC-only rule create followed immediately by value-free semantic readback.

## 2026-08-29 exact rule recreate and semantic readback

- Entrypoint `4eee604bde8646adbe441d3b1f8f5660`; rule
  `08b7fc2ef8814ba2ba5250f528a27774`.
- Create body validation exited `0`; create curl exited `0` with HTTP `200`.
  Immediate readback curl exited `0` with HTTP `200`, and the semantic
  validator exited `0`.
- Readback is exactly one enabled/logged zone custom rule in phase
  `http_request_firewall_custom`, action `skip`, `products=["bic"]`, with no
  phase skip and this exact fixed expression:

  `(ip.src eq 39.105.204.121 and http.host eq "infinity.zhangyvjing.com" and ((http.request.method eq "POST" and http.request.uri.path in { "/api/paper-processor/connect" "/api/paper-processor/poll" "/api/paper-processor/control" }) or (http.request.method eq "PUT" and http.request.uri.path eq "/api/paper-processor/object")))`

- The rule contains no wildcard or broader path/source match and skips no
  product besides BIC. The WAF token value was not printed, hashed, copied,
  or recorded. This rule is the only new external change so far; its
  entrypoint and rule IDs are the rollback handles.

## 2026-08-29 Processor install hash-check rollback

- The WAF rule/readback was valid, but the following Processor install stopped
  before venv creation at an absolute-path source aggregate mismatch. The
  source bytes, lock hash, and unit hash were not changed; the check used the
  wrong path representation.
- WAF deletion returned HTTP `200` for the rule and `204` for the entrypoint;
  final entrypoint readback returned HTTP `404`. The Edge secret and zhangbot
  token were then revoked/removed. No WAF rule is active now.

## 2026-08-29 retry preflight after installer-check rollback

- Rulesets read through the mode-`0600` token exited `0`/HTTP `200`; the fixed
  custom entrypoint read exited `0`/HTTP `404`/error `10003`. No WAF rule is
  active and no new WAF write has occurred in this retry.
- The exact current-HEAD archives and the complete read-only Cloudflare and
  zhangbot preflight passed. The next operation is a fresh exact rule
  create/readback; its IDs will be the rollback handles.

## 2026-08-29 transfer command rollback

- A transfer command stopped before remote archive validation with SSH exit
  `255` because safe environment assignments were placed before the host.
  No WAF write occurred in that attempt; the WAF entrypoint remains absent.
- Edge secret and zhangbot token/staging were confirmed absent during recovery.
  Retry uses the corrected SSH ordering only.

## 2026-08-29 latest rollback state

- The latest Processor install guard stopped before installation because
  zhangbot lacks `rg`; after capability-first rollback the fixed entrypoint
  read returned HTTP `404` and no Paper WAF rule is active. The next exact
  rule, if authorized by a fresh passing preflight, must be newly created and
  immediately read back; no prior rule ID is reused.

## 2026-08-29 current preflight state

- Read-only Rulesets access through the mode-`0600` token returned HTTP `200`;
  the current custom fixed-endpoint entrypoint is absent, and the previous
  entrypoint read returned HTTP `404`. No WAF rule is active.
- All local gates and the current immutable artifact preflight pass. The next
  rule must be newly created, match only zhangbot IP `39.105.204.121`, host
  `infinity.zhangyvjing.com`, the three fixed POST paths plus fixed PUT object
  path, and skip only BIC; it must be read back before any capability write.

## 2026-08-29 current exact WAF rule

- The newly created and immediately read-back entrypoint is
  `eec4070b89af476a9e806bbc07458fc0`; its rule is
  `026d95bb13d149f69ee339bb8aba8ace`. HTTP create/readback were both `200`;
  semantic validator exit was `0`.
- Readback proves one enabled/logged zone custom rule, action `skip`, action
  parameters exactly `products=["bic"]`, and the exact fixed expression for
  `39.105.204.121`, `infinity.zhangyvjing.com`, POST connect/poll/control, and
  PUT object. The earlier rejected `version` request created no partial rule.
- This is the only current Paper-release external change. Delete the rule then
  entrypoint using these IDs before rolling back any later capability or release
  step; no D1 migration is to be rerun.

## 2026-08-29 transfer rollback state

- After archive transfer stopped at the malformed SSH host ordering, the new
  rule `026d95bb…` and entrypoint `eec4070b…` were deleted with HTTP `200` and
  `204`. Read-only inventory now shows no custom entrypoint; no WAF rule is
  active. Edge Paper secret and zhangbot token were also removed/absent.
- The next WAF rule must be newly created after a fresh preflight; no deleted
  ID is reused.

## 2026-08-29 retry preflight after transfer rollback

- Rulesets inventory is read-only clean with no custom entrypoint; Edge Paper
  secret and zhangbot token are absent. The exact artifact, active mainland
  Kimi Worker, D1/R2, and zhangbot preflight passed.
- A newly created exact four-path BIC-only rule is required before the next
  capability handoff. The host-first SSH transfer form has been corrected and
  will be used exactly once; no prior WAF ID is reused.

## 2026-08-29 archive-hash rollback state

- The latest host-first transfer stopped at a local archive/source hash input
  mismatch before installation. New WAF rule/entrypoint, Edge Paper secret,
  and zhangbot token/staging were removed and read back absent; no WAF rule is
  active. A newly created rule is required after the next clean preflight.

## 2026-08-29 browser-control blocker final WAF state

- The final exact rule/readback in this attempt used entrypoint
  `7c1feeddaeb744568317625a21557258` and rule
  `7e3458417b984adcb70b24cad72fdb9f`; semantic validation passed for one
  enabled/logged rule with action `skip`, products `["bic"]`, and only
  the fixed zhangbot IP/host and four method/path pairs.
- The rule was deleted before stopping because the mandatory authenticated
  browser acceptance could not be controlled. Rule deletion returned HTTP
  `200`, entrypoint deletion HTTP `204`, final readback/inventory showed
  no custom Processor entrypoint. No WAF exception is active.
