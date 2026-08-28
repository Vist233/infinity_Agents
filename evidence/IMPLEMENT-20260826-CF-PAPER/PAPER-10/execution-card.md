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

## 2026-08-28 immutable preflight passed; exact WAF rule active

- Review commit `793dec74a5ca6717e08e9083f673d648622b4095` is clean and
  matches `origin/cloudflare-deploy`.
- The reconciled source, dependency-lock, and service-unit hashes matched the
  delivery definition. Production D1 markers/schema and R2 target metadata
  matched; migrations `0017`–`0021` were not rerun.
- zhangbot passed the Python 3.10 venv/ensurepip/pip, existing service,
  listener, no-stale-Processor, fixed-egress, and source-connectivity checks.
- The WAF token was used only by secure stdin header pipe. The exact additive
  rule is now entrypoint `f08c457a6ff54e52b17fda00ead62161`, rule
  `7d0a2bb78b1b4634b7523a1c0902d37d`; readback validation passed. This is the
  only external write so far in this release attempt. No Edge shared secret,
  Processor token/release/service, D1/R2 object, Edge deployment, Redis,
  Relay, or Cloudflared write has occurred.
- Next operation is the authorized secret/token/release sequence. If any
  later step fails, apply capability-first rollback and retain the exact
  rollback IDs in the checkpoint. `deployment.txt` remains absent.

## 2026-08-28 dependency installation stop

- The exact WAF rule/readback and secure secret/token setup initially passed.
  The commit archive was verified end-to-end without macOS `._*` entries and
  its source/lock/unit hashes matched the delivery definition.
- Release installation stopped at pinned dependency retrieval: zhangbot pip
  exited `2` on an HTTPS read timeout from the package host while fetching
  `pypdf==6.15.0`. The staging directory was cleaned; no release/current,
  unit registration, Processor process, Edge code deployment, or live flow
  followed.
- Rollback removed the exact WAF rule and empty entrypoint, revoked the Edge
  shared secret, removed the single zhangbot token env and archive, and
  verified no Processor remained. Redis/Relay/Cloudflared and D1 were
  preserved. The R2 bucket-info read briefly disagreed (`15/41.9 MB`, then
  `0/0 B`, then `15/41.9 MB`); no R2 write was issued.
- Current status is `BLOCKED_PROCESSOR_DEPENDENCY_INSTALL_NETWORK_TIMEOUT`;
  `deployment.txt` is absent and PAPER-10 is not complete.

## 2026-08-28 dependency-closure retry and rollback

- This retry began from clean `cloudflare-deploy` commit
  `6c67c8ec94eb32f8e9a77013c49c34f6c374b8d3`. Direct read-only preflight
  verified the target account/Worker/D1/R2, no pending D1 migrations, stable
  R2 metadata (`15` objects / `41.9 MB`), the exact four-path BIC-only WAF
  rule, and the zhangbot venv/ensurepip, existing-service, listener, and
  no-stale-Processor checks. The initial proxy-backed read stopped on the
  unavailable local proxy; the same reads passed after switching to direct
  network access.
- The first remote archive validation exposed `._*` members in the older
  wheelhouse. A new GNU-format wheelhouse was generated and independently
  verified locally and remotely with SHA-256
  `241dce8114d95fe6a74ca86eb745dfe5687e8d58302e015d0d539bfcbf609b17` and
  no AppleDouble/PAX members. The source archive hash remained
  `5d694b88f413abe59c64c4276d49d4e924dad05bb272348807ecccf7006e174b`.
- A first install wrapper stopped before the candidate check because it
  assumed the archive root was `<commit>`; a corrected attempt found the
  `infinity-paper-processor-<commit>` root, created the Python 3.10 venv,
  and then failed honestly at offline pip installation because pypdf's
  Python 3.10 dependency `typing_extensions>=4.0` was absent from the
  wheelhouse. The corrected install command exited `1`; no release/current,
  unit, service, process, Edge deployment, or R2 object was created.
- Capability-first rollback removed the exact WAF entrypoint/rule, deleted
  `PAPER_PROCESSOR_SHARED_SECRET`, removed the one mode-0600 zhangbot token
  env and all four retry archives, and verified no Processor release/current/
  unit/process remained. D1 was not rerun, R2 was not written, and Redis,
  Relay, and Cloudflared remained active.
- The local closure is now a minimal exact pin
  `typing_extensions==4.13.2`, its delivery lock hash is synchronized, and
  the delivery regression test asserts the pin. Focused/full local gates
  pass (Edge 129, Processor 12, frontend unit 50, E2E 13 after the permitted
  local-server retry). `deployment.txt` remains absent and PAPER-10 is not
  complete; the next action is a review commit/backup followed by a fresh
  immutable preflight.

## 2026-08-28 dependency-closure review backup

- The local review commit is
  `96dce21a302ebe258f1ae6de343ae8b148bde76e`; non-force push and exact
  read-only remote-ref verification both exited `0` for
  `origin/cloudflare-deploy`. The worktree is clean.
- This is a source-control backup only. PAPER-10 remains pending a fresh
  immutable preflight and real production acceptance; no new Cloudflare or
  zhangbot write occurred after the rollback.
