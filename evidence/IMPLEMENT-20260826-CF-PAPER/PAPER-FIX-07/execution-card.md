# PAPER-FIX-07 — Bounded Processor attempts and memory-pressure recovery

- Branch: `cloudflare-deploy`
- Baseline: `81fe88f77f2c8e6e8a778786ac3cd23291757796` (`PAPER-FIX-06`)
- Unique objective: prevent a claimed Paper Processor attempt from remaining
  indefinitely in `processing`; make timeout, memory pressure, and lease
  heartbeat failure become safe terminal outcomes while preserving the D1/R2/
  Processor contract.
- Root-cause input: the production zhangbot service was alive while a real
  resource remained `processing` for more than four minutes. The prior
  synchronous path did not renew its lease, had no total or stage deadline,
  had no resident-memory guard, and emitted no safe grant/stage terminal log.
  The observed cgroup was near `MemoryMax=256M`.
- Allowed scope: Processor ingest/runner runtime, the checked-in systemd unit,
  versioned delivery definition, Processor/Edge delivery regression tests,
  governing design/execution/runbook documentation, and this evidence
  directory.
- Prohibited scope: Cloudflare or zhangbot production writes, D1 migrations,
  R2 writes, WAF/secrets/Redis/Relay/Cloudflared changes, browser control,
  provider changes, and Git push.
- Rollback: revert the local review commit; if later deployed, restore the
  prior immutable release through the existing release procedure. Preserve D1,
  R2, Redis/Relay/Cloudflared, and existing lease metadata.
