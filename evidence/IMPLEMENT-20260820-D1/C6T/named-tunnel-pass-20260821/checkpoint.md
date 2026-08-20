# CHECKPOINT IMPLEMENT-20260820-D1 / C6T / named-tunnel-pass-20260821

- baseline code candidate: `cloudflare-deploy@63d8a0f`; this card adds deployment evidence and docs only.
- result: **PASS**. `infinity-redis-relay-prod` is healthy with four Cloudflare connections and serves
  `https://relay.zhangyvjing.com` through remote-managed ingress version 2.
- hostname boundary: the initially planned nested hostname `relay.infinity.zhangyvjing.com` failed
  real TLS validation and was rejected before cutover. The final single-label hostname is covered by
  the zone certificate and passed authoritative DNS, TLS and Relay health checks.
- zhangbot: user-local `cloudflared 2026.8.2` runs as enabled user service
  `infinity-cloudflared.service`; Redis and Relay remain loopback-only. The run token is stored in a
  mode-0600 file and consumed with `--token-file`, not process arguments.
- Edge: `REDIS_RELAY_URL` now points to `https://relay.zhangyvjing.com`; deployment
  `015fccb8-cb0b-49ab-9e2b-dd8f810df2ba`, version
  `67959a41-63f2-41da-a284-56ded203d6c4` at 100%.
- Docker Worker: the replacement `infinity-agent-worker-b-v2` reused the existing persistent
  credential, instance identity and workspace volume, connected 200, read named Relay hints 200 and
  continued D1 poll/heartbeat 200. The stopped old container is retained as a rollback backup.
- cutover safety: the old Quick Tunnel process was stopped only after named Relay, Edge and Worker
  checks passed; subsequent named Relay and Edge health remained ok.
- no Task, Attempt, Artifact, D1/R2 row or Redis data was modified. Case 2 remains PASS; Case 3 remains
  `DEFERRED_BY_OWNER`.
- the earlier `named-tunnel-partial-20260820` card remains historical evidence and is superseded by
  this checkpoint.
- next exact gate: C7 final same-candidate deterministic regression and one read-only architecture,
  authorization, state-machine, Secret, Docker and browser-flow review.
