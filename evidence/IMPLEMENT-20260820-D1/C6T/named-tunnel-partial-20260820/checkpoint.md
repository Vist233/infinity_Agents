# CHECKPOINT IMPLEMENT-20260820-D1 / C6T / named-tunnel-partial-20260820

> Historical partial checkpoint. Superseded by `../named-tunnel-pass-20260821/checkpoint.md` after
> production DNS, connector, Edge and Docker Worker cutover all passed.

- baseline/current candidate: `cloudflare-deploy@4526300` before this evidence-only commit.
- created named Tunnel: `infinity-redis-relay-prod` / `b2993c42-6074-40b7-9389-7c80ad9789a4`; remote-managed, currently **inactive**.
- ingress version: `1`; only `relay.infinity.zhangyvjing.com -> http://127.0.0.1:8090`, then `http_status:404`.
- credential hygiene: an initial unused Tunnel response included a credential field, so that exact inactive Tunnel was deleted immediately. The replacement was created and inspected only through output-filtered API calls. No credential value is retained in this checkpoint or repository.
- blocker: current Wrangler OAuth is accepted by the Connectivity Tunnel API but Cloudflare DNS API replies `10000 Authentication error`; therefore no CNAME exists and the Quick Tunnel is still the active Relay route.
- zhangbot: Ubuntu 22.04 x86_64, current user `zhangyvjing`; `cloudflared` is not installed. No package, service, token file, or Relay configuration was changed.
- rollback: delete the currently inactive tunnel by its ID in the Cloudflare dashboard/API. Since DNS/Edge/zhangbot were untouched, no live traffic rollback is required.
- required continuation: obtain a Cloudflare API token that has both Account Cloudflare Tunnel Edit and Zone DNS Edit for zhangyvjing.com (or create the CNAME in dashboard); then install cloudflared on zhangbot, place the Tunnel run token in a user-only systemd EnvironmentFile, start/health-check it, change `REDIS_RELAY_URL` only after the named HTTPS health endpoint succeeds, deploy Edge, and retain the Quick Tunnel until rollback is verified.
- C5R remains blocked by separate explicit Redis ACL authorization; C6 authenticated browser remains not passed; C7 cannot begin.
