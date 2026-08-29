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

## 2026-08-28 secret handoff retry and rollback

- From the clean backed-up commit
  `343738798619546e313a0030f7b7391a6d32cec1`, the complete read-only
  preflight passed and the exact WAF rule was recreated/read back as
  entrypoint `1aa5798c03814e48a95466764dc9d9c6`, rule
  `ac11b4092cf64d3b8a912c455f6f75bd`.
- The Edge secret write returned success, but the SSH command incorrectly
  combined a secret pipe with a here-document. The remote shell printed a
  command-not-found diagnostic, proving the input stream was not a safe
  one-time token handoff. The resulting env-file shape was not trusted even
  though the shape check returned success. The one-time value was immediately
  invalidated and is not recorded anywhere in this evidence.
- Capability-first rollback deleted the exact WAF rule/entrypoint, deleted the
  Edge secret, removed the zhangbot token env, and verified no release/current/
  unit/process remained. Redis/Relay/Cloudflared stayed active; D1/R2 were
  not written and Edge code was not deployed.
- Status is `BLOCKED_PROCESSOR_SECRET_HANDOFF_PIPE`; `deployment.txt` is
  absent. The next retry must use separate stdin channels: a single-line
  remote shell command that reads only the token pipe, with no here-document,
  followed by a value-free functional verification.

## 2026-08-28 artifact-verifier retry and rollback

- From clean backed-up commit `3039acc5cc3b169ecb5d0c4b2090e980b35ee95d`,
  the exact WAF rule was recreated and the corrected secret/token handoff was
  completed without a shell diagnostic. Before any archive transfer, the
  local verifier itself exited `1` because its no-match branch attempted to
  raise `None`; the source and wheel archives were not accepted as deployable
  evidence at that point.
- The verifier failure occurred before zhangbot upload, release creation,
  service start, Edge deployment, or R2 use. Capability-first rollback removed
  the exact WAF rule/entrypoint, Edge secret, and zhangbot token env. Existing
  Redis/Relay/Cloudflared remained active and D1 was untouched.
- The corrected local packaging now produces a minimal Processor-only source
  archive and a three-wheel archive with no `._*` members. `deployment.txt`
  remains absent and PAPER-10 is not complete; the next action is a fresh
  backed-up preflight before recreating any external capability.

## 2026-08-29 GitHub backup blocker

- The corrected minimal Processor-only source archive and three-wheel archive
  passed local validation with no `._*` members. No archive was uploaded and
  no production capability was recreated after the verifier rollback.
- The evidence-only local commit
  `d67952b5bf560aebfbbf0671fab145fcb66718a6` was created successfully, but
  GitHub was unreachable: the configured proxy failed immediately and direct
  HTTPS timed out. Bounded direct `ls-remote` and non-force `push` both
  returned signal-alarm exit `142`; the last independently confirmed remote
  ref remains `3039acc5cc3b169ecb5d0c4b2090e980b35ee95d`.
- This is a source-control backup blocker only. The local worktree is clean,
  but PAPER-10 remains stopped with WAF/secret/token/release/service absent,
  D1/R2 preserved, and Redis/Relay/Cloudflared unchanged.

## 2026-08-29 release retry stop and rollback

- The current clean/backed-up baseline was
  `7f1944a6e056e469509e1eecf5f7df88b5358a12`. Immutable preflight, exact
  WAF read/write/readback, secure Edge/zhangbot secret handoff, and archive
  hash checks passed.
- Release installation reached the venv/dependency phase but stopped at a
  remote hash assertion that accidentally evaluated six paths from `$HOME`.
  The command exited `1`; no service was registered or started. The release
  trap removed the incomplete release, then capability-first rollback removed
  the token, Edge Secret, WAF rule, and empty entrypoint with final readbacks.
- Status: `BLOCKED_PROCESSOR_RELEASE_SCRIPT` for this retry; PAPER-10 is not
  PASS. D1 `0017`–`0021` remain applied and were not rerun. No R2 object or
  Edge deployment exists, and Redis/Relay/Cloudflared were unchanged.
- Next exact action: repeat read-only preflight from the clean backed-up
  commit, recreate the exact WAF rule, and retry the release with all hash
  calculations explicitly rooted in the extracted release directory.

## 2026-08-29 listener assertion retry stop and rollback

- The next backed-up baseline was `6a70062186b68b2cd4703f762d3a8f62d3b6eb1e`.
  The Processor release reached venv/dependency/import completion and systemd
  start, but the post-start assertion rejected pre-existing cloudflared
  loopback metrics on port `20242`. Read-only process mapping showed no
  Processor socket.
- The release trap and capability-first rollback completed: release/current/
  unit/process, token, Edge Secret, WAF rule, and empty entrypoint were all
  removed/read back absent. Existing Redis/Relay/Cloudflared and D1/R2 were
  preserved.
- Status: `BLOCKED_PROCESSOR_LISTENER_ASSERTION`; PAPER-10 is not PASS. The
  next retry uses a Processor-main-PID-specific listener check.

## 2026-08-29 corrected release smoke-check stop and rollback

- The next backed-up baseline was `a270b30ad4d144aad5431713d163dee8e7fcac4b`.
  Immutable preflight, exact WAF readback, secure secret/token handoff, and
  current-commit archive validation passed.
- Release setup successfully created the Python 3.10 venv and installed all
  locked wheels. The import smoke check then exited `1` because nested SSH
  quoting converted the test string into a Python `NameError`; no unit or
  Processor process was started.
- Capability-first rollback removed the release, token, Edge Secret, WAF
  rule, and empty entrypoint, with final readbacks confirming absence. D1/R2
  metadata and existing Redis/Relay/Cloudflared services were preserved.
- Status: `BLOCKED_PROCESSOR_RELEASE_SMOKE_CHECK`; PAPER-10 is not PASS. The
  next retry must use a quote-safe smoke check, then repeat immutable
  preflight before recreating capabilities.

## 2026-08-29 backed-up release retry stop and rollback

- The backup prerequisite is now satisfied from clean `cloudflare-deploy`:
  local HEAD and the exact `origin/cloudflare-deploy` readback are both
  `becde2db27aa7ef7e31bfb2ddbe4a0f4ce7be8cf`. A non-force SSH push returned
  `up to date`; no force operation was used.
- A fresh read-only preflight confirmed the approved account, Worker,
  `infinity-agents-db`, `infinity-agents-resources`, applied D1 state, current
  Edge health, Ubuntu/Python/venv capability, fixed egress, and unchanged
  Redis/Relay/Cloudflared services. The previous failed attempt still had
  the exact WAF rule, Edge secret name, and a mode-0600 zhangbot token file;
  it had no release/current symlink/unit/process.
- The retry reached the zhangbot systemd registration stage and exited `1`.
  Its only observed output was creation of the user-service symlink; the
  failing internal assertion was not surfaced, so this record does not infer
  an unobserved cause. Read-only status after the failure confirmed release,
  current symlink, unit, and Processor process absent.
- Capability-first rollback then succeeded: WAF rule delete HTTP `200`, empty
  entrypoint delete HTTP `204`, final entrypoint readback HTTP `404`; Edge
  secret deletion exit `0` with name-only absence; and exact zhangbot token
  removal exit `0` with the file absent. Edge health returned
  `paper_processor: unconfigured` afterward. D1/R2 were preserved, no D1
  migration was rerun, no R2 object was written, and Edge code was not
  deployed. Existing Redis/Relay/Cloudflared remained active and unchanged.
- Status: `BLOCKED_PROCESSOR_RELEASE_SCRIPT`; PAPER-10 is not PASS. The next
  retry must use a diagnostic-preserving, quote-safe release command and must
  repeat immutable preflight before recreating capabilities.

## 2026-08-29 wheel archive metadata stop and rollback

- From backed-up `4647fcb761708d89794f63f99baf5317ed215c6d`, the immutable
  local preflight, full local gates, exact WAF rule/readback, and secure
  Edge/zhangbot secret handoff passed. The source archive was hash-verified
  and had no AppleDouble members.
- Transfer of the source and wheel archives to the commit-named zhangbot
  staging directory succeeded. Remote GNU tar then emitted macOS extended
  metadata warnings while validating the wheel archive and the strict
  AppleDouble check exited `32`; no release installation or service start
  followed. The failing archive was not accepted as deployable.
- Capability-first rollback removed WAF rule `d2d9482066bb468db052f52fe7b28bed`
  (HTTP `200`), empty entrypoint `7885ab9658cb4b9082c34174b67da6c0`
  (HTTP `204`, readback `404`), the Edge Secret by name, the zhangbot token,
  and the exact staging directory. D1/R2, Edge code, Redis/Relay/Cloudflared
  were not modified; existing services remained active.
- A replacement wheel archive built with explicit files, `ustar`, and
  `COPYFILE_DISABLE=1` passed local member validation; its SHA-256 is
  `6bf318a077fd6e82a12e8a6e70178ea6a64582d002b7ca4f542af4165314ff1c`.
  This is a packaging correction, not a production acceptance result.
- Status: `BLOCKED_PROCESSOR_ARCHIVE_METADATA`; PAPER-10 is not PASS. The
  next exact action is to repeat immutable preflight, recreate/read back the
  exact WAF rule and credentials, and validate the replacement archive on
  zhangbot before release installation.

## 2026-08-29 systemd verification-order stop and rollback

- From backed-up `7505d07012ef1e210b7782eff5b6484e0e68d778`, immutable local
  and remote archive validation passed, including source/wheel SHA-256,
  source/lock/unit aggregates, and AppleDouble exclusion. The exact WAF
  rule/entrypoint and secure Edge/zhangbot secret handoff also passed.
- The diagnostic-preserving release command extracted the commit-named
  release and installed the offline locked dependencies, then exited `1` at
  `systemd-analyze --user verify`: the unit's `ExecStart` resolves through
  `current/.venv/bin/python`, but `current` had not yet been activated. No
  unit was installed or enabled, and no Processor process or listener was
  created.
- Capability-first rollback removed WAF rule `e282f79611e94eb59341a792b4ef465a`
  (HTTP `200`), entrypoint `972bf26e0fdd478bbcc97c17ceb54881` (HTTP `204`,
  readback `404`), Edge Secret by name, zhangbot token, release, current,
  unit, and staging. Edge health returned `paper_processor: unconfigured`.
  D1/R2, Edge code, Redis/Relay/Cloudflared were not modified; existing
  services remained active.
- Status: `BLOCKED_PROCESSOR_SYSTEMD_VERIFY_ORDER`; PAPER-10 is not PASS. The
  next retry must activate the exact commit-named current symlink before the
  systemd verify step, then continue only after read-only hash and service
  checks pass.

## 2026-08-29 live acceptance browser blocker and full rollback

- From backed-up `5d2c12875296bd7ce1fad824cb122fc44dab76a1`, the corrected
  metadata-free archive, remote hashes, exact WAF readback, secure secret/
  token handoff, Processor release, and Edge deploy all passed. Edge version
  `4d2a792b-a767-4e91-8a66-09aac0c673e9` reached 100% traffic and health
  readiness was configured.
- Real browser acceptance could not start: the in-app Browser reported
  `ERR_BLOCKED_BY_CLIENT` even for a read-only health navigation, and the
  available authenticated Chrome extension timed out while navigating the
  production home page before a DOM was returned. A direct unauthenticated
  HTTPS read of the root returned HTML 200, but this is not authenticated
  product evidence. No login data, form, upload, paper query, or user data was
  entered or transmitted through the browser.
- Because the required authenticated browser proof was unavailable, no
  search/materialize/PDF/R2/parse/page/image/tool-refresh or negative-case
  claim is made. `deployment.txt` was intentionally not created and PAPER-10
  is not PASS.
- Capability-first rollback succeeded: WAF rule `00c039445f394c8cab0baab0e2fab1f5`
  delete HTTP `200`, entrypoint `c812296bcf4c4c418038db5c38ebf37f` delete
  HTTP `204` and readback `404`; Edge Secret deletion exit `0` with name-only
  absence; zhangbot stop/disable/daemon-reload exit `0`, token/release/current/
  unit/staging absent and Processor inactive. Edge rollback exit `0` restored
  version `d287b02d-a94c-4caa-b473-70f2368f4999` to 100%. D1/R2 metadata was
  preserved, no D1 migration was rerun, no R2 object was written, and
  Redis/Relay/Cloudflared remained active.
- Status: `BLOCKED_AUTHENTICATED_BROWSER_ACCEPTANCE`; PAPER-10 is not PASS.
  The next exact action requires a functioning authenticated browser session
  that can return the production DOM, then a fresh full preflight and a new
  authorized release attempt; no capability is left active from this attempt.

## 2026-08-29 Kimi K2.6 mainland endpoint correction

- The prior live Kimi K2.6 result was a real `401 Invalid Authentication`.
  This subphase corrected only the provider endpoint contract after checking
  the official mainland documentation: `https://api.moonshot.cn/v1`, model
  `kimi-k2.6`, Bearer auth, `POST /chat/completions`, and base64 image input.
- TDD coverage and all local Edge, Processor, frontend, E2E, diff, and secret
  gates passed. Existing Processor lockfile/manifest changes were retained.
- No remote write has occurred in this subphase. `deployment.txt` remains
  absent and PAPER-10 remains incomplete pending deployment and a real
  authenticated text probe.
## 2026-08-29 mainland endpoint deployment / browser stop

- The TDD-corrected Worker configuration was deployed to version
  `79755db3-c12d-4737-b601-aa99f11e3f93` at 100%; read-only health and
  deployment checks passed.
- The required harmless authenticated text probe could not start because the
  same existing Infinity Agents tab remained owned by the source browser
  session across three fresh claim attempts. No browser state or application
  data was inspected or modified.
- `deployment.txt` records the external Edge deployment. PAPER-10 is not PASS;
  no Processor/WAF/Secret/R2 operation was started in this stop.

## 2026-08-29 mainland text gate and WAF capability passed

- The coordinator's authenticated browser record confirms the exact text
  prompt `请只回复：KIMI_MAINLAND_TEXT_PROBE_OK` returned the exact visible
  result `KIMI_MAINLAND_TEXT_PROBE_OK` against Worker version
  `79755db3-c12d-4737-b601-aa99f11e3f93`. This is a real text-provider gate
  pass and supersedes the prior international-endpoint 401; no Kimi secret or
  browser credential is recorded, and StepFun remains unused.
- The scoped WAF read-only capability preflight passed. The additive zone
  custom rule was created and immediately read back exactly as the fixed
  four-path BIC-only contract: entrypoint
  `65e15547ea3144feb70791fc155d1df0`, rule
  `5695e7eb000c4f49b77a616cff1411ae`, action `skip`, products `bic`, enabled,
  and logged. No pre-existing rule was changed.
- External state now active: this WAF rule only. D1 migrations remain applied
  and were not rerun. Edge shared secret, zhangbot token/release/service, R2
  object, Redis/Relay/Cloudflared, and the remaining Paper deployment have
  not yet been written in this attempt.
- PAPER-10 remains incomplete. The next controlled step is a fresh immutable
  preflight followed by the authorized secret/token handoff and single
  Processor release; capability-first rollback starts with this rule if that
  step fails.

## 2026-08-29 fresh immutable preflight passed

- The clean local HEAD is `794f8b10d0c86c50a0575cc4fe2869aaa0aa537b` on
  `cloudflare-deploy`; actual read-only remote ref is
  `e551a5994cd228f19a2ae816c4529e4b04cf41a1`. No new GitHub push was made in
  this continuation. All three delivery artifact hashes match the checked-in
  manifest and no AppleDouble file is present.
- Read-only Cloudflare identity, deployment, D1 migration/schema, R2, health,
  and secret-name checks passed. D1 migrations were not rerun. The exact
  current WAF rule/readback passed with entrypoint
  `65e15547ea3144feb70791fc155d1df0` and rule
  `5695e7eb000c4f49b77a616cff1411ae`; no Processor shared secret exists yet.
- zhangbot package/venv/ensurepip/pip, existing-service, no-stale-Processor,
  fixed-egress, allowlisted-source, and no-Processor-listener checks passed.
  Existing Redis/Relay/Cloudflared services remain active; Docker is absent.
- The next step is the authorized secure Edge shared-secret and zhangbot token
  handoff followed by the single release install. PAPER-10 remains incomplete.

## 2026-08-29 token handoff wrapper failure and rollback

- The Edge shared-secret write succeeded, but the one-time SSH token handoff
  exited `1` before writing the env file: `set -e` terminated on EOF from the
  generated no-newline stdin value before the read-status guard. This is not
  treated as a Token or Provider acceptance result.
- Read-only checks confirmed no zhangbot token env, Processor service, release,
  process, or listener. Capability-first rollback deleted the WAF rule and
  entrypoint (readback `404`), deleted the Edge Secret (name absent), removed
  the exact staging path, and removed the local temporary secret. Existing
  Redis/Relay/Cloudflared and D1/R2 were preserved.
- PAPER-10 remains incomplete. The next attempt must repeat immutable
  preflight and use a quote-safe EOF-tolerant stdin handoff before releasing
  the Processor.

## 2026-08-29 fresh preflight and stale-release isolation

- Baseline `1fc350e7a80c5e330492e235641dea477eb88bee` is clean on
  `cloudflare-deploy`; the actual read-only remote branch is
  `e551a5994cd228f19a2ae816c4529e4b04cf41a1`. Artifact hashes match the
  delivery manifest and no AppleDouble file is tracked. The exact mainland
  Kimi text gate remains a real visible PASS, while Paper acceptance remains
  pending.
- Read-only Cloudflare account, deployment/version, secret-name, D1, R2,
  health, and WAF capability checks passed. The current secret-triggered
  100% Worker version retains the reviewed mainland Kimi base/model; no Paper
  shared secret or WAF custom entrypoint exists after rollback; D1 migrations
  were not rerun.
- Read-only zhangbot checks passed for the installed Python runtime and
  disposable venv/ensurepip, existing-service PIDs, listener inventory,
  no actual Processor runner, no Processor token/unit/current symlink, fixed
  source egress, and allowlisted sources. The only stale artifact found was
  an inert old release; after the no-runner/no-unit/no-current checks it was
  moved to a 0700 quarantine and the formal release root was verified empty.
- Allowed scope for the next step is only: create/read back the exact four
  path BIC-only WAF rule, then write the new Edge shared secret and the paired
  zhangbot 0600 token via secure stdin. If any later step fails, delete the
  new WAF rule/entrypoint first, revoke new capability material, and remove
  only the new release/service; preserve D1/R2 metadata and existing
  Redis/Relay/Cloudflared.

## 2026-08-29 exact WAF retry passed

- After the fresh immutable preflight, the first exact WAF create attempt was
  rejected HTTP `400`/error `20127`; its immediate entrypoint read was still
  `404`, so no partial rule was assumed. A corrected documented inline-set
  expression was used in a second additive request.
- The corrected rule/readback passed with entrypoint
  `6a212d8fb2444135a6b2511e7d8ad8d0` and rule
  `a7f6a28a87624da28d595a11eeb5d92b`: one enabled/logged zone rule, action
  `skip`, action parameters exactly BIC, and exact source/host/four fixed
  method/path pairs. No existing ruleset or product was edited.
- The WAF rule is the only active Paper-release change. The next allowed
  operation is the corrected secure secret/token handoff; failure requires
  deleting this rule/entrypoint first and preserving D1/R2 and existing host
  services.

## 2026-08-29 rebuilt current-HEAD preflight

- Baseline is clean `cloudflare-deploy` HEAD
  `63cb12c2cdf3f3704e2a76e7f33f7ce367ac248d`; the actual read-only remote is
  `e551a5994cd228f19a2ae816c4529e4b04cf41a1`. No GitHub write was made.
- The current-HEAD source/wheel archives passed member, no-AppleDouble,
  lock-hash, and manifest identity checks. Archive hashes are recorded in
  `preflight.txt` and the release was not transferred.
- Read-only Cloudflare checks pass for the exact account/Worker/D1/R2 target,
  active 100% mainland Kimi version, no pending D1 migrations, zero-write
  schema metadata, unchanged R2 count/size, absent Paper secret, absent WAF
  entrypoint, and Processor-unconfigured health. Read-only zhangbot checks
  pass for the exact venv package, existing-service preservation, no stale
  Processor state, fixed egress, and allowlisted source connectivity.
- This card is now ready for one fresh exact BIC-only WAF create/readback. No
  D1 migration is to be rerun; any failure must use WAF-first rollback.

## 2026-08-29 capability handoff passed

- The first local secret-generation check stopped at the expected precondition
  because the newline-terminated output was 65 bytes; no external write
  followed. The corrected 64-hex value was then written to the Edge secret
  binding and delivered once through SSH stdin to the zhangbot 0600 token file.
- Edge name-only readback and public health passed; zhangbot readback passed
  token mode/owner/one-line/shape. The EOF return `1` was expected and was
  accepted only because the token buffer was non-empty and exactly 64 hex
  characters. The local temporary value was removed. No token value entered
  logs, evidence, arguments, or the repository.
- Processor is not yet installed or running. Existing Redis/Relay/Cloudflared
  remain active and listener inventory is unchanged. The next step is
  current-HEAD archive transfer and immutable remote release installation;
  failures require WAF-first capability rollback.

## 2026-08-29 archive HEAD mismatch and rollback

- The release step stopped before transfer because the package directory was
  for prior commit `5e42e4e…`, not clean current HEAD `5c4b7563…`. This was a
  local packaging precondition, not a remote artifact mismatch; no old package
  was reused.
- Rollback deleted the fresh WAF rule/entrypoint and read back 404, removed
  token/staging, and corrected the Edge-secret deletion command after its
  unsupported `--yes` invocation returned exit `1`. The supported confirmed
  delete returned exit `0` and name-only readback showed absence.
- No Processor release/service, D1 migration, R2 object, Edge code deployment,
  or existing-service change occurred. The next attempt must package current
  HEAD and repeat preflight before any capability write.

## 2026-08-29 exact WAF retry passed

- After the fresh immutable preflight, the first exact WAF create attempt was
  rejected HTTP `400`/error `20127`; its immediate entrypoint read was still
  `404`, so no partial rule was assumed. A corrected documented inline-set
  expression was used in a second additive request.
- The corrected rule/readback passed with entrypoint
  `6a212d8fb2444135a6b2511e7d8ad8d0` and rule
  `a7f6a28a87624da28d595a11eeb5d92b`: one enabled/logged zone rule, action
  `skip`, action parameters exactly BIC, and exact source/host/four fixed
  method/path pairs. No existing ruleset or product was edited.
- The WAF rule is the only active Paper-release change. The next allowed
  operation is the corrected secure secret/token handoff; failure requires
  deleting this rule/entrypoint first and preserving D1/R2 and existing host
  services.
