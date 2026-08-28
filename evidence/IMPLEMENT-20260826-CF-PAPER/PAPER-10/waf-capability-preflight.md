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
