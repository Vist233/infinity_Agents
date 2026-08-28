# PAPER-10 execution card

- Branch: `cloudflare-deploy`
- Card: PAPER-10 — external release, deployment and live acceptance
- Release commit: `3558c1fec9035465407ca121fea94bd77e74d7bd`
  (supersedes the failed `61cc66d509a86ac93cebef9fd955644d68d278c0` release)
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
  URL validation, unique instance identity, host-compatible systemd-user unit,
  and operator runbook are implemented and tested. The unit retains the
  required privilege, filesystem, network, resource, and singleton controls;
  unsupported user-manager capability controls are explicitly documented and
  tested as absent.
- External outcome at this checkpoint: the previously applied D1 migrations
  `0017`–`0021` remain recorded and will not be rerun. The Edge was deployed as
  version `4ef4cea2-71ca-402e-aa4a-f5322417da2a` and its readiness response
  showed D1, R2, and Processor configuration while the temporary secret was
  present. Processor startup then failed at systemd status
  `218/CAPABILITIES` because the old unit requested unsupported
  `PrivateDevices`/kernel protection controls. The Edge secret, zhangbot token,
  unit, current symlink, and release were revoked or removed by the targeted
  rollback; no R2 object, Redis, Relay, or Cloudflared change occurred.
- Latest external attempt: the corrected release was installed and the Edge
  was deployed as version `ce8c9923-5776-4e5b-82a4-ec322912b6ba` (version
  number 119; the script etag matched the reviewed Edge source). Secret and
  token shape checks passed, but the real Processor `connect` request received
  Cloudflare `403 Error 1010 / browser_signature_banned` before the Worker
  handler. The service was stopped after diagnosis and all newly created
  Processor capability material was revoked or removed. No live paper flow was
  attempted after this failure.

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
The first Processor deployment attempt exposed a host-specific systemd
constraint and was rolled back. The checked-in unit now omits only the
controls proven incompatible with this unprivileged user manager; the next
gate is an owner-approved resolution for the Edge access blocker, followed by
a fresh immutable-release preflight, deployment, and real authenticated
acceptance. PAPER-10 is not complete.
