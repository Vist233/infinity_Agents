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
