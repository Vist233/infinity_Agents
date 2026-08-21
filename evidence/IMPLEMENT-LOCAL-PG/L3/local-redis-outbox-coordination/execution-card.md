# EXEC-L3-01: Local Redis outbox coordination

## Control
- run_id: IMPLEMENT-LOCAL-PG
- primary_executor: single local agent (Lingma)
- stage: L3
- baseline_commit: L2 head (main); see baseline.txt
- current_dirty_files: none outside the allowed scope
- risk: R1 (new isolated module and tests only; no active production path touched)

## Authority
- docs/POST_CLOUDFLARE_MAIN_LOCAL_POSTGRESQL_PLAN_2026-08-20.md §L3
- docs/MAIN_LOCAL_COMPONENT_MAP_2026-08-21.md (invariant 2: Redis may be flushed
  or stopped; it never stores Method/Dataset/Artifact bytes, user content or
  secrets; port row for backend/code_agent/outbox.py)
- Legacy reference (read-only): backend/code_agent/outbox.py, backend/code_agent/redis_client.py

## One outcome
- observable result: durable PostgreSQL outbox events are claimed
  transactionally and republished to Redis only as rebuildable wake-up hints;
  with Redis unreachable the events survive with backoff and no duplicate
  attempt; after recovery the replay is idempotent; a Redis flush loses
  nothing durable; the `/v1/hints` endpoint degrades to an empty hint list;
  a Redis dump contains no credential, lease token or input bytes.
- explicit non-goals: no one-command compose (L5), no frontend/SSE wiring
  (L4), no deletion of legacy redis_relay/zhangbot code until L4/L5 replace
  the last consumer, no changes to the Cloudflare tree or cloudflare-deploy.

## Scope
- files allowed: backend/local_runtime/outbox_redis.py, backend/local_runtime/worker_api.py, backend/local_runtime/__init__.py, tests/test_local_redis_outbox.py
- files read-only: backend/local_runtime/{repository,migrations}.py, backend/code_agent/**
- files forbidden: everything else
- external systems allowed: isolated Docker PostgreSQL (127.0.0.1:25432) and
  isolated Docker Redis (127.0.0.1:26379) only

## Frozen invariants
- PostgreSQL outbox is the only durable event record; Redis stores a capped
  hint stream (`infinity:local:hints`, MAXLEN ~1000) with event_id,
  idempotency_key, pool_id, task_id, event_type only.
- Claim uses FOR UPDATE SKIP LOCKED plus owner/lease fencing; expired claims
  are requeued by recover_expired_claims at startup.
- Redis outage never loses or duplicates: failures stay `pending` with
  exponential backoff; Workers keep PostgreSQL polling as the authoritative
  path (L2), hints are advisory wake-ups only.
- Explicit password required: LOCAL_REDIS_URL/LOCAL_REDIS_PASSWORD must be
  supplied; there is no default credential (test password lives only in the
  gitignored `.local-test/redis-test.env`).

## Baseline
- exact checks: HEAD at L2 commit, branch main, git status clean before L3.
- known failures: none; L1+L2 suites green.

## Decision note
- The standalone Redis for this stage runs via `docker run` with an
  explicitly generated password, mirroring the L1 PostgreSQL harness. The
  plan's single `docker-compose.local.yml` (PostgreSQL + Redis + API +
  frontend + Workers) is L5's deliverable, so no parallel compose file is
  introduced now.

## Evidence
- tests-and-exit-codes.txt: ruff 0; L3 suite 7 passed (exit 0); full
  local-runtime regression 31 passed (exit 0); no-DSN run skips PG/Redis
  tests (exit 0).
- diff-summary.txt, baseline.txt, secret-scan.txt in this directory.
