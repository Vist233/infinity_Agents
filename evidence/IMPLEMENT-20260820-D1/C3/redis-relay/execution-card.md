# C3 — HTTPS Redis Relay

## Objective

Make zhangbot Redis an administrator-managed implementation detail. Cloudflare
D1 remains the fact source; the edge Worker sends only fixed outbox events to
the Relay, and a Docker Worker receives only fixed, reconstructible hints.

## Changed surface

- `backend/redis_relay.py`: FastAPI Relay with signed event ingestion and
  bearer-authenticated hint reads.
- `cloudflare-worker/src/outbox-relay.ts`: bounded D1 outbox claim, HMAC
  publish, retry/backoff, and invalid-event quarantine.
- `cloudflare-worker/src/index.ts`: scheduled outbox flush.
- `cloudflare-worker/src/env.ts`: Relay URL/secret configuration.
- `cloudflare-worker/wrangler.jsonc`: one-minute scheduled trigger.
- `requirements.relay.txt` and `backend/Dockerfile.redis-relay`: minimal
  deployment image for zhangbot.

## Security contract

- The Relay derives one fixed stream and one fixed idempotency-key prefix from
  its administrator-provided namespace.
- The request schema rejects extra fields and only permits the public pool
  `public-default`.
- Redis commands, keys, D1 URLs, user data, provider credentials, and raw
  outbox payloads never cross the boundary.
- D1 outbox delivery is signed with `X-Relay-Timestamp` and
  `X-Relay-Signature`; replayed timestamps are rejected.
- Lua `SET NX` + `XADD` makes event publication idempotent.
- Redis failure keeps D1 events pending with bounded exponential retry; invalid
  event shapes are marked failed and are never sent.

## Remote state

No SSH, remote Redis, remote D1, Cloudflare deployment, or Docker host was
modified in C3. Those operations are reserved for the explicitly authorized
real-integration stage.
