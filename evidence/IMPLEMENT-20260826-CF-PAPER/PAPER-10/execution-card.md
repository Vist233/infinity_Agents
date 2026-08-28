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
- External outcome at this checkpoint: read-only preflight passed and D1
  migrations `0017`–`0021` applied. The shared secret and zhangbot token were
  created only for the next deployment step, then both were rolled back after
  zhangbot virtualenv creation failed because ensurepip/
  `python3.10-venv` is missing. No Processor service started, no Edge deploy,
  Processor registration, R2 write, Redis change, or live acceptance occurred.

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

`BLOCKED_OS_PACKAGE_PRIVILEGE`: the exact zhangbot host prerequisite is
identified (`python3.10-venv`, candidate `3.10.12-1~22.04.17`), but the
authorized `sudo -n apt-get update` cannot run because a sudo password is
required. The next action is a secure operator path for only the two
authorized APT commands, followed by venv/ensurepip verification and a fresh
read-only preflight. PAPER-10 is not complete.
