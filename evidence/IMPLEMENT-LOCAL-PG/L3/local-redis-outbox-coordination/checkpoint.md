# L3 checkpoint

Status: `PASS`

- primary executor: single local agent; repository baseline `72f1c09` (main, L2 head).
- completed card: EXEC-L3-01 local-redis-outbox-coordination.
- current product behavior: `backend/local_runtime/outbox_redis.py` claims
  pending outbox events with `FOR UPDATE SKIP LOCKED` plus owner/lease
  fencing and republishes them to Redis only as rebuildable wake-up hints
  (capped stream `infinity:local:hints`). `create_worker_v2_app` accepts an
  optional `redis_url`, starts/stops the publisher in its lifespan, recovers
  expired claims at startup, and serves `GET /v1/hints` (empty list when
  Redis is unconfigured or down). Workers' authoritative path stays
  PostgreSQL polling (L2); hints only shorten wake-up latency.
- tests run with exit codes: L3 suite 7 passed (exit 0) covering
  publish-as-hints, outage backoff without duplicate attempts, idempotent
  replay after recovery, flush-loses-nothing, Redis secret scan, stale claim
  requeue and hints-endpoint degradation; full local-runtime regression
  (L1+L2+L3+worker contract suites) 31 passed (exit 0); no-DSN run skips
  PG/Redis tests (exit 0); ruff check exit 0.
- failed/skipped tests: none failed; suites skip only when DSN/Redis URL absent.
- DB/Redis/Docker/browser state: isolated PG container `infinity-l1-pg-test`
  (127.0.0.1:25432) reused; isolated Redis `infinity-l3-redis-test`
  (127.0.0.1:26379, redis:7-alpine, `--rm`, requirepass from gitignored
  `.local-test/redis-test.env`, no persistence); Cloudflare production and
  cloudflare-deploy branch untouched; no zhangbot/Tunnel dependency added.
- evidence paths: evidence/IMPLEMENT-LOCAL-PG/L3/local-redis-outbox-coordination/
- known risks: none blocking; the one-command compose (PostgreSQL + Redis +
  API + frontend + Workers) and the deletion of legacy redis_relay/Tunnel
  code arrive with L4/L5.
- rollback point: revert the L3 commit; the module is isolated and the hints
  endpoint degrades to an empty list without Redis.
- next exact card: L4 local frontend/auth/Task Center against this runtime.
- external state touched: none (only localhost Docker).
- secrets/data exposure: none (explicitly generated test password gitignored;
  Redis dump asserted free of credentials, lease tokens and input bytes).
