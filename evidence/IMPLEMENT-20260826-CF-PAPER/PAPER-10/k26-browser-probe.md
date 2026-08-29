# PAPER-10 Kimi K2.6 browser probe and rollback

- Recorded at: `2026-08-29T05:20:58Z`
- Branch: `cloudflare-deploy`
- Local baseline: `29ff8cbe4b6014fa86af848b1ca9f50081b78189`
- Remote baseline before this evidence amendment:
  `b6d411a086f12e60abbf62bf95689e7634cd6b0b`
- Worktree before this subphase: clean.
- Scope: one authenticated-browser text-probe attempt and its required
  rollback only. No paper tooling, image analysis, D1 migration, R2 object,
  WAF, Processor, or Redis/Relay/Cloudflared operation was started.

## Probe result

The existing Chrome tab was rediscovered from `openTabs()` using the expected
URL `https://infinity.zhangyvjing.com/` and title `Infinity Agents`. Two claims
of that same current tab were refused because it was still owned by the source
browser session. No alternate tab/session was created, and no page content,
credential, cookie, storage, or provider response was inspected.

Provider status: `NOT_VERIFIED`

Candidate model: `Kimi K2.6`

Redacted error: `BLOCKED_AUTHENTICATED_BROWSER_TAB_OWNERSHIP`
Provider HTTP status/model response: not obtained because the text request was
never sent.

This is not a provider success and is not being counted as a live acceptance.

## Read-only deployment confirmation

- `npx wrangler deployments list --name infinity-agents-edge --json`: exit `0`;
  candidate `93983647-e6f6-4497-a128-2dfd478d15f5` was at 100% before rollback.

## Required rollback

- Rollback command: `npx wrangler versions deploy d287b02d-a94c-4caa-b473-70f2368f4999@100 --name infinity-agents-edge --yes --message "Rollback Kimi K2.6 provider after browser probe could not be completed"`
- Exit: `0`; Cloudflare reported
  `d287b02d-a94c-4caa-b473-70f2368f4999` at 100%.
- Read-only deployment readback: exit `0`; the newest deployment contained the
  exact rollback version at 100%.
- Read-only public health check: HTTP `200`; readiness response remained
  non-secret and reported D1, resource bucket, and Paper Processor as
  configured.

The only Cloudflare write in this subphase was Worker traffic rollback. D1
migrations `0017`-`0021` were not rerun. No R2 object, WAF rule, Edge secret,
zhangbot token/release/service, or existing Redis/Relay/Cloudflared change was
made.

## Checkpoint

Status: `BLOCKED_AUTHENTICATED_BROWSER_TAB_OWNERSHIP`

The exact next action is for the source browser session to release the existing
authenticated tab. Then rediscover and claim that same current tab and run one
harmless text-only probe against the approved Kimi candidate; do not start
paper tooling or image analysis until the text result is a clean success.
`deployment.txt` is absent and PAPER-10 remains not PASS.

## Evidence gate

- Scoped `git diff --check`: exit `0`.
- Scoped no-secret detector: raw no-match exit `1`; normalized gate exit `0`.
