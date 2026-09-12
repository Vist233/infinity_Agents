# D11 — Scheduled literature watch

Date: 2026-09-11 (Asia/Shanghai)
Status: PASS (bounded opt-in watcher; live cron repetition pending)

The scheduled watcher supports arXiv and Europe PMC with per-source timeout,
per-run and per-day caps, canonical IDs, cursor persistence, duplicate checks,
and per-source failure isolation. arXiv revision suffixes normalize to one
stable catalog identity. It is opt-in and currently disabled in Edge vars.
