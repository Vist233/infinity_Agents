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

## 2026-08-28 WAF capability subphase stop

- This subphase started from clean commit
  `84edb2cd34919ecb42d3ea7af7f1704c471adc21` on `cloudflare-deploy`.
- The corrected mode-0600 scoped WAF token passed token verification and
  Rulesets read. One exact BIC-only fixed-endpoint zone rule was created and
  read back, then fully removed after the immutable release check found that
  the current Processor source aggregate hash
  `510715c4a3e8605181219508d38bd8747b1fff28a7c676fb64d15fd1ed57d15e`
  did not match the delivery definition's pinned
  `ce76a75997ebff53c10a1baf2beb2631b66c8fb5a6740b469ba8bf04bf381813`.
- Status is `BLOCKED_PROCESSOR_ARTIFACT_HASH_MISMATCH`. No Paper Secret,
  Processor release/service, Edge deployment, D1/R2 object, zhangbot,
  Redis, Relay, or Cloudflared write was performed. The WAF rule and its
  newly created entrypoint are absent on readback; `deployment.txt` is not
  created. The next action is a reviewed local hash reconciliation and fresh
  immutable preflight before any further production write.

## 2026-08-28 source-manifest hash reconciliation

- Baseline: clean `cloudflare-deploy` at
  `c73e780b6c9dff342a6dfbbe8f3164ac2b4db520`, matching the read-only
  `origin/cloudflare-deploy` ref. This subphase is limited to the Processor
  delivery manifest's source hash and its regression test; no runtime or
  external resource is in scope.
- Audited hash contract: the fixed input set is, in order,
  `backend/paper_processor/__init__.py`, `client.py`, `ingest.py`, and
  `runner.py`; the declared algorithm is the exact `sha256sum ... | sha256sum`
  command in `delivery.v1.json`. Two independent executions produced the
  deterministic aggregate
  `510715c4a3e8605181219508d38bd8747b1fff28a7c676fb64d15fd1ed57d15e`.
- Change: synchronized `processor_source_sha256` to that aggregate and added
  a delivery regression assertion for the exact command/input set and live
  aggregate. The intentional pre-update test was red (exit `1`, 4/5); the
  post-update focused test was green (exit `0`, 5/5).
- Local gates: Edge `check`/test exit `0` (129 tests), Processor pytest exit
  `0` (12 tests), frontend typecheck/lint/unit exit `0` (50 unit tests), and
  permitted frontend E2E exit `0` (13 tests). `git diff --check` and the
  changed-scope secret scan also pass. The first sandbox-only E2E attempt
  remains recorded as exit `1` for `127.0.0.1:3000` `EPERM`.
- External state: no Cloudflare or zhangbot write occurred in this
  reconciliation; the WAF entrypoint/rule is absent, Edge secret/token are
  absent from this subphase, D1 migrations remain applied and are not to be
  rerun, and no R2/Redis/Relay/Cloudflared change was made.
- Next gate: create and verify the review backup commit, then repeat the
  complete immutable read-only preflight. Only if that preflight passes may
  the exact four-path BIC-only WAF rule be recreated and read back before the
  remaining authorized PAPER-10 operations. `deployment.txt` remains absent.
