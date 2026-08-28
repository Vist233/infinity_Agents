# PAPER-10 execution card

- Branch: `cloudflare-deploy`
- Card: PAPER-10 — external release, deployment and live acceptance
- Release commit: `61cc66d509a86ac93cebef9fd955644d68d278c0`
- Reviewed Processor source commit pinned by the delivery definition:
  `455ae849c572aa285cc752a10e21fd69f031b18d`
- Runtime decision: the user explicitly approved `zhangbot` as the sole
  trusted Paper Processor host, overriding the earlier Cloudflare-managed
  runtime assumption. No other host or replica is in scope.
- External authorization: the user explicitly authorized production D1
  migrations `0017`–`0021`, the minimum Edge/R2/Processor configuration,
  zhangbot service installation, Edge/Processor deployment, and authenticated
  live acceptance. Existing Redis, Redis Relay, and Cloudflared services remain
  outside the change scope.
- Local outcome: the fixed-source contract, PubMed/approved-URL boundaries,
  Python 3.10 virtualenv delivery definition, pinned dependencies, fixed Edge
  URL validation, unique instance identity, hardened systemd-user unit, and
  operator runbook are implemented and tested.
- External outcome at this checkpoint: the previously applied D1 migrations
  `0017`–`0021` remain recorded and will not be rerun. A fresh read-only SSH
  verification now confirms `python3.10-venv` is installed and disposable
  venv/ensurepip/pip checks pass. The Processor service is still absent; no
  new secret, Edge deploy, Processor registration/start, R2 write, Redis
  change, or live acceptance has occurred in this resumed phase.

## Required release acceptance

- [ ] Re-run read-only target, artifact, Cloudflare, D1, R2, zhangbot, and
  runtime preflight.
- [ ] Apply additive D1 migrations `0017` through `0021` in order and read
  back each migration marker and required table/index.
- [ ] Configure the fixed Edge Processor ID and shared secret; transfer only
  the Processor token to the mode-0600 zhangbot env file without logging it.
- [ ] Deploy the reviewed Python virtualenv release and one systemd-user
  service without changing Redis, Relay, or Cloudflared.
- [ ] Deploy the reviewed Edge and verify readiness, Processor connect/poll,
  lease/fencing, retries, cancellation, object publication, and restart
  recovery against real D1/R2.
- [ ] Run authenticated live search, supported PDF materialization, parsing,
  page text, image retrieval/analysis, durable tool history/refresh recovery,
  provider egress, isolation, invalid identifiers, stale leases, duplicate
  finalize, cancellation, malformed input, and oversized/SSRF negatives.
- [ ] Capture deployment identifiers, migration results, live exit codes, safe
  health/readiness output, rollback reference, and post-release secret scan.

## Stop condition

The earlier `BLOCKED_OS_PACKAGE_PRIVILEGE` condition is resolved by the
owner-provided package installation and the passing disposable venv checks.
The next gate is the full read-only artifact/Cloudflare/zhangbot preflight;
PAPER-10 is not complete.
