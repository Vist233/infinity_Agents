# CHECKPOINT IMPLEMENT-20260826-CF-PAPER / PAPER-10

- status: `BLOCKED_PROCESSOR_EDGE_ACCESS`
- branch: `cloudflare-deploy`
- release commit: `3558c1fec9035465407ca121fea94bd77e74d7bd`
- one completed outcome: local Paper Processor release contract, all local
  PAPER-10 gates, read-only OS/Cloudflare/zhangbot preflight, and production
  D1 migrations are complete for the explicitly approved zhangbot-only
  runtime.
- evidence: `execution-card.md`, `baseline.txt`,
  `tests-and-exit-codes.txt`, `diff-summary.txt`, `secret-scan.txt`.
- external authorization: explicitly granted for this exact PAPER-10 target,
  including D1 migrations `0017`–`0021`, minimum Edge/R2/Processor setup,
  zhangbot service installation, deployment, and authenticated live acceptance.
- external systems modified: the reviewed runtime and blocker evidence were
  backed up non-force through commit
  `a35d110e608d4bfaa07c203c87fb3a8d5e03f657`; the exact remote ref was
  independently read back with `ls-remote` exit 0. The runtime release commit
  above is an ancestor of that backup. Production D1 migrations `0017`–`0021`
  were applied and read back. Edge versions
  `4ef4cea2-71ca-402e-aa4a-f5322417da2a` and
  `ce8c9923-5776-4e5b-82a4-ec322912b6ba` were deployed during failed attempts;
  the temporary shared secret and zhangbot token were then revoked/removed.
  No R2 object, Redis, Relay, or Cloudflared change occurred.
- historical blocker: the exact package candidate is correct
  (`python3.10-venv`, `3.10.12-1~22.04.17`), but the earlier authorized
  `sudo -n apt-get update` exited 1 with `sudo: a password is required`. The
  owner subsequently installed the exact package, and read-only dpkg/venv/
  ensurepip/pip verification passed. No substitute package or sudo-policy
  change was attempted. The earlier Cloudflare-managed runtime/OCI blocker is
  historical evidence only.
- current remediation: the first Processor start failed with systemd
  `218/CAPABILITIES` because the old unit requested host-incompatible
  `PrivateDevices` and kernel protection controls. Disposable probes and a
  focused regression test established the supported minimum; the new release
  removes only those directives, updates the delivery hash and runbook, and
  passes all local gates. The failed external attempt was rolled back before
  this new release is installed.
- latest blocker: with the corrected release and Edge version
  `ce8c9923-5776-4e5b-82a4-ec322912b6ba`, the real zhangbot `connect` request
  was rejected by Cloudflare before the Worker handler with HTTP 403 Error
  1010 `browser_signature_banned` (the Python urllib client signature was
  banned). The service auto-restarted while diagnosing, then was stopped and
  disabled. The temporary Edge shared secret, zhangbot token, release,
  current symlink, and unit were removed; read-only D1/R2/service checks passed.
  Do not retry or claim readiness until the owner provides a reviewed,
  authorized resolution for this exact Edge access policy/client contract.
- blocker resolution: a subsequent owner-provided installation was verified
  read-only over SSH. `dpkg-query` reports
  `python3.10-venv 3.10.12-1~22.04.17 install ok installed`; disposable venv
  creation, ensurepip, and pip all passed. The earlier sudo failure is
  retained as historical evidence and is no longer the current stop reason.
- repository verification: the prior fresh read-only `ls-remote` independently
  verified `origin/cloudflare-deploy` at
  `33d494cb5a402101a48833e46b822b0f04d64d41`. The current release commit is
  local only until the next non-force push and exact read-only ref check.
- evidence backup: commit
  `7c0b01b25205ed87aacacbc9f646f313b509fcc7` was pushed non-force to
  `origin/cloudflare-deploy` (exit 0), and an elevated read-only
  `ls-remote` independently returned the exact same SHA. The local tracking
  ref was updated to that verified value.
- rollback: before external writes, restore the prior Git commit. After any
  authorized external write, follow the runbook's capability-revocation-first
  rollback and preserve D1/R2 metadata.
- next exact action: push the new local release commit non-force to
  `origin/cloudflare-deploy` and verify the exact ref, then repeat the complete
  read-only release preflight against that immutable artifact and actual
  Cloudflare/zhangbot targets. The already-applied D1 migrations `0017`–`0021`
  must not be rerun. Do not claim PAPER-10 complete before real authenticated
  acceptance and all negative cases pass.

## 2026-08-28 current status: BLOCKED_PROCESSOR_EDGE_ACCESS

This is a new PAPER-10 local-only access-contract subphase. Baseline was
`e72ad26b5b18b153f9b780dd678e0282aaf188b3`; the existing reviewed Processor
release remains `3558c1fec9035465407ca121fea94bd77e74d7bd`. The sole objective
was to resolve the real zhangbot-to-Edge 403/1010 using a narrow,
service-to-service contract while preserving shared-secret, Processor-ID,
nonce, session, lease, and fencing validation.

Read-only checks confirmed the fixed routes and methods, zhangbot's stable
egress `39.105.204.121`, the fixed Edge host, no Processor state on zhangbot,
and unchanged Redis/Relay/Cloudflared listeners. The current Cloudflare
session exposes `zone(read)` but no Rulesets/WAF management capability:
ruleset/Firewall reads returned `10000 Authentication error` and security
setting reads returned `9109 Unauthorized to access requested resource`.
The zone is on the Free Website plan. The required dynamic-attempt path
exception cannot use exact regex semantics on that plan; a wildcard would be
broader than the requested exact rule, so it was not created.

Local code now fails closed on the injected source IP and exact application
route family, and the checked-in delivery definition/design/runbook require a
zone-level custom `skip` limited to BIC (`products: ["bic"]`), fixed host/IP,
and the Processor methods/paths only. Tests cover foreign source IP,
missing/wrong bootstrap secret, non-Processor paths, and contract fields. No
Cloudflare rule, secret, token, Processor release/service, Edge deployment,
R2 object write, or Redis/Relay/Cloudflared change occurred in this subphase;
D1 migrations `0017`–`0021` remain applied.

Focused Edge tests passed 23/23; mandatory Edge check/test passed 128/128;
Processor pytest passed 11/11; frontend typecheck/lint/unit passed 50/50;
frontend E2E passed 13/13 after the recorded sandbox bind failure. This
subphase therefore stops at the external capability boundary and does not
create `deployment.txt` or a PASS checkpoint.

Required next action: provide an authorized Cloudflare zone-level
Rulesets/WAF-capable session/token and an approved exact dynamic-path
mechanism (or an equivalent read-back-verifiable capability). Then rerun the
read-only preflight, create only the BIC-only exact rule, read back its
expression/scope, and only after that rotate the shared secret/token, deploy
the single zhangbot Processor and Edge, and run the full authenticated live
acceptance. Do not use IP Access `Allow`, whole-host/wide-path bypasses,
browser-signature impersonation, or an alternate host.

Rollback reference remains capability-revocation-first: remove only any new
rule, secret, token, service, release, or Edge deployment; preserve D1/R2
metadata and leave Redis/Relay/Cloudflared untouched.

## Backup verification

- Review commit: `fb5ed60d22d9949d00381be41d0f5aea86e805c1`.
- Non-force push command: `git push origin HEAD:refs/heads/cloudflare-deploy`,
  exit code 0; GitHub advanced the branch from `e72ad26b` to `fb5ed60`.
- Independent read-only verification: `git ls-remote --heads origin
  cloudflare-deploy`, exit code 0, returned exactly
  `fb5ed60d22d9949d00381be41d0f5aea86e805c1 refs/heads/cloudflare-deploy`.
- The verified commit contains the Paper Workspace access-contract code,
  tests, synchronized design/runbook/plan, and security/rollback evidence.
  The worktree was clean after the commit. This GitHub backup is separate
  from Cloudflare production changes: no rule, secret, token, deployment,
  D1/R2 object, Redis, Relay, or Cloudflared write occurred in this subphase.

## 2026-08-28 fixed internal endpoint protocol status

- status: `BLOCKED_PROCESSOR_EDGE_ACCESS` / `WAITING_MINIMUM_WAF_CAPABILITY`
- baseline: clean `cloudflare-deploy` at
  `5ca83c60c6247e3271a639544c4233a791ef7860`; no unrelated worktree change.
- sole local objective: replace dynamic Processor URL paths with a finite,
  Free-plan-expressible fixed protocol while preserving the public browser/API
  contract and C7 D1/R2/Redis/Relay/Worker-v2 boundaries.
- exact fixed routes:
  `POST /api/paper-processor/connect`,
  `POST /api/paper-processor/poll`,
  `POST /api/paper-processor/control`,
  `PUT /api/paper-processor/object`.
- exact control operations: `input`, `input_source`, `renew`, `stage`,
  `finalize`, `cancel`, `fail`. The object envelope allows only `upload` and
  the checked-in kinds `source_pdf`, `text_pages`, `text_manifest`, `image`,
  and `image_manifest`. IDs are carried in validated envelopes; the Worker
  derives D1/R2 destinations after session, lease, fencing, attempt/resource
  ownership, source-IP, Processor-ID, and shared-secret/session checks.
- compatibility impact: all former dynamic Processor paths are removed from
  the client and handler dispatch and fail closed; no compatibility path can
  bypass the new source/path gate. Public browser/API paths are unchanged.
- local gate result: focused Edge 23/23; full Edge 128/128; Processor 12/12;
  frontend unit 50/50; frontend E2E 13/13; all required typecheck/lint,
  `git diff --check`, and normalized secret scan passed with the exact exit
  codes in `tests-and-exit-codes.txt`.
- external changes: none in this subphase. No Cloudflare rule/secret/token/
  deployment, D1/R2 object, zhangbot release/service, Redis/Relay/Cloudflared
  write, or live acceptance was performed. `deployment.txt` remains absent;
  no PASS checkpoint is asserted.
- rollback: revert the review commit locally if required; if a later
  authorized rollout occurs, revoke only newly created rule/capabilities,
  stop/remove only the new release/service, restore the previous reviewed
  Edge/Processor versions, and preserve D1/R2 metadata and existing Redis,
  Relay, and Cloudflared services.
- next exact user action: authorize only the minimum zone Rulesets/WAF
  capability needed to create and read back one BIC-only rule matching
  `ip.src eq 39.105.204.121`, host `infinity.zhangyvjing.com`, and the four
  exact method/path pairs above. A plan upgrade is not required. After a
  successful read-back, rerun the PAPER-10 preflight, rotate the Edge/shared
  Processor secret through secure channels, deploy the single zhangbot
  service and Edge, and perform the real authenticated D1/R2/Processor/live
  acceptance. Do not rerun D1 migrations `0017`–`0021`.

## Review backup for the fixed-endpoint amendment

- review commit: `d87da003a741ac5ed5ef7015946776582c17ab13`
- non-force push: `git push origin HEAD:refs/heads/cloudflare-deploy`, exit
  code 0; remote advanced from `5ca83c60c6247e3271a639544c4233a791ef7860`.
- read-only verification: `git ls-remote --heads origin cloudflare-deploy`,
  exit code 0; exact ref was
  `d87da003a741ac5ed5ef7015946776582c17ab13 refs/heads/cloudflare-deploy`.
- post-push local status: clean `cloudflare-deploy`; this is a GitHub source
  backup only. No Cloudflare rule/secret/token/deployment, zhangbot release or
  service, D1/R2 object, Redis, Relay, or Cloudflared write occurred.

## 2026-08-28 minimum WAF capability preflight blocker

- status: `BLOCKED_WAF_TOKEN_PERMISSIONS`
- baseline: `cloudflare-deploy` was clean at
  `01a596619f3bb9ac1506c503e81738d4f5381ff3`, matching the remote tracking
  ref.
- read-only result: the owner-provided short-lived WAF token file exists and
  is owned by the current user, but its mode is `0644`; required mode is
  `0600`. The metadata check exited 4.
- secret safety: token contents were not read, copied, printed, hashed, put in
  an argument, sent to Cloudflare, or written to evidence.
- external changes: none. No Cloudflare API request, WAF rule, secret
  rotation, Edge/Processor deployment, D1/R2 write, zhangbot change, Redis,
  Relay, or Cloudflared change occurred. `deployment.txt` remains absent.
- stop condition: account/zone/WAF read/write capability and rule capacity
  were not checked because the token permission precondition failed.
- next exact action: change only the token file mode to `0600` without
  revealing its contents, then resume PAPER-10. Repeat metadata validation,
  verify the exact Cloudflare account/zone and Rulesets/WAF read/write
  capability and safe entrypoint/capacity before creating the single
  BIC-only fixed-path rule. Do not rotate secrets, deploy, or run live
  acceptance before those read-only checks pass.
- rollback: none required; no external write occurred. Existing GitHub and D1
  state are unchanged.

## 2026-08-28 corrected-token WAF capability and artifact preflight stop

- status: `BLOCKED_PROCESSOR_ARTIFACT_HASH_MISMATCH`
- baseline/current commit: `84edb2cd34919ecb42d3ea7af7f1704c471adc21` on
  clean `cloudflare-deploy`; no unrelated worktree change was present before
  this evidence update.
- WAF preflight: token metadata was mode `0600`; token verification was
  active. The scoped token's Rulesets read succeeded for the previously
  verified target zone. Broader account/zone convenience reads returned
  `9109`, and the custom entrypoint initially returned `404`/`10003` with no
  existing custom rule order.
- WAF external operation: one additive zone-level
  `http_request_firewall_custom` entrypoint/rule was created and immediately
  read back exactly. Entrypoint ID:
  `823074a217994347a3af06ee6e6f4a28`; rule ID:
  `8ee926f7fcf34736bbe565b2adbe0396`. It matched only
  `39.105.204.121`, `infinity.zhangyvjing.com`, the four fixed endpoint
  method/path pairs, `skip` with `products=["bic"]`, enabled logging, and
  enabled status.
- artifact gate: the current Processor source aggregate is
  `510715c4a3e8605181219508d38bd8747b1fff28a7c676fb64d15fd1ed57d15e`, but
  the checked-in delivery definition requires
  `ce76a75997ebff53c10a1baf2beb2631b66c8fb5a6740b469ba8bf04bf381813`.
  Dependency-lock and service-unit hashes match. The mismatch was found
  before any Secret, Processor, Edge, D1, R2, or zhangbot deployment write;
  no D1 migration `0017`–`0021` was rerun.
- rollback: the new rule DELETE returned HTTP `200`; readback showed zero
  rules. The new entrypoint DELETE returned HTTP `204`; the first wrapper
  exited `45` solely because it expected `200`, not because the API rejected
  the deletion. Independent final entrypoint readback returned HTTP `404` and
  the ruleset list returned the original four non-custom rulesets. Net WAF
  state is restored. No Secret/token, Processor service/release, Edge
  deployment, R2 object, zhangbot, Redis, Relay, or Cloudflared change
  remains.
- real D1/R2/browser acceptance: not run because the immutable artifact gate
  failed before deployment. `deployment.txt` remains absent; no PASS
  checkpoint is asserted.
- next exact action: reconcile the current fixed-endpoint source aggregate
  hash with `delivery.v1.json` in a reviewed local change, rerun local gates
  and immutable preflight, then recreate only the exact WAF rule and continue
  PAPER-10. Preserve D1 migrations and do not rerun `0017`–`0021`.

## 2026-08-28 manifest drift reconciliation checkpoint

- status: `READY_FOR_PAPER_10_IMMUTABLE_PREFLIGHT` (PAPER-10 is not PASS).
- baseline: clean `cloudflare-deploy` at
  `c73e780b6c9dff342a6dfbbe8f3164ac2b4db520`, with the local and remote
  branch refs equal before this local change.
- contract audit: `delivery.v1.json` names the fixed four-file source set
  `__init__.py`, `client.py`, `ingest.py`, `runner.py` under
  `backend/paper_processor/`, in that order, and declares the exact
  `sha256sum <files> | sha256sum` algorithm. Two deterministic runs returned
  aggregate
  `510715c4a3e8605181219508d38bd8747b1fff28a7c676fb64d15fd1ed57d15e`.
- reconciliation: the manifest now contains that exact aggregate. A new
  delivery test verifies both the command/input contract and equality with
  the current source. It failed intentionally before the manifest update
  (exit `1`, 4/5) and passed after the update (exit `0`, 5/5).
- local gates: Edge `npm run check && npm test` exit `0` (23 files/129
  tests); Processor pytest exit `0` (12); frontend typecheck, lint, and unit
  exit `0` (50 unit tests); frontend E2E exit `0` after the permitted local
  server rerun (13 tests). The first sandbox-only E2E attempt exited `1`
  because binding `127.0.0.1:3000` was denied with `EPERM`; it is retained in
  the test record. Diff and secret gates pass.
- external changes: none in this reconciliation. The WAF rule/entrypoint is
  currently rolled back and absent; no Edge shared secret, zhangbot token,
  Processor release/service, Edge deployment, D1/R2 object, Redis, Relay, or
  Cloudflared write occurred. D1 migrations `0017`–`0021` remain applied and
  must not be rerun.
- next exact action: review and non-force-push the reconciliation commit,
  verify the exact remote ref with `ls-remote`, then redo the full immutable
  read-only preflight. If and only if it passes, recreate the exact
  fixed-path `products=["bic"]` rule and immediately read it back. Any later
  external failure must use capability-first rollback. `deployment.txt`
  remains absent and no PASS is asserted.

## 2026-08-28 immutable preflight and WAF rule checkpoint

- status: `READY_FOR_PROCESSOR_SECRET_AND_RELEASE` (PAPER-10 is not PASS).
- baseline/current commit: clean, backed-up `cloudflare-deploy` commit
  `793dec74a5ca6717e08e9083f673d648622b4095`; exact remote ref verified.
- one completed outcome: source manifest drift is reconciled and the exact
  fixed-path WAF capability has been created and read back.
- modified files: no repository files since the review commit in the external
  preflight. Current working tree remained clean through the preflight.
- focused/full local gates: recorded as passing in items 43–47 of
  `tests-and-exit-codes.txt`; artifact identity and all read-only preflight
  checks exited `0`.
- real D1/R2/browser evidence: D1 markers/schema and R2 bucket metadata were
  read-only verified; no new D1/R2 object or live browser flow has run.
- external changes: one additive zone-level custom WAF entrypoint/rule only.
  Entrypoint `f08c457a6ff54e52b17fda00ead62161`, rule
  `7d0a2bb78b1b4634b7523a1c0902d37d`; exact source/host/four path pairs,
  `skip`/`products=["bic"]`, enabled logging, and enabled state read back.
  D1 migrations were not rerun; Edge secret/token/deployment and zhangbot
  release/service remain untouched at this checkpoint.
- rollback operation: if the next step fails, delete rule
  `7d0a2bb78b1b4634b7523a1c0902d37d` and then empty entrypoint
  `f08c457a6ff54e52b17fda00ead62161` after read-only confirmation, then
  revoke any secret/token/release created in the failed attempt. Preserve D1
  metadata and leave Redis/Relay/Cloudflared unchanged.
- next exact action: write the minimal shared secret through Wrangler's stdin
  channel, deliver one Processor token through SSH stdin to the mode-0600
  env file, install the immutable release, then deploy Edge and run real
  authenticated acceptance. Stop at the first failure; no PASS yet.

## 2026-08-28 PAPER-10 dependency-install blocker and rollback

- status: `BLOCKED_PROCESSOR_DEPENDENCY_INSTALL_NETWORK_TIMEOUT`.
- baseline/current commit: `793dec74a5ca6717e08e9083f673d648622b4095`,
  previously backed up and verified on `origin/cloudflare-deploy`; no code
  change was made during the failed external attempt.
- one completed outcome: immutable preflight passed through archive transfer,
  but pinned zhangbot dependency installation failed with pip exit `2` due to
  a read timeout fetching `pypdf==6.15.0`; staging was automatically removed.
- modified files: only uncommitted PAPER-10 evidence is being updated; no
  source/runtime file changed. `deployment.txt` remains absent.
- focused/full local gates: all local gates remain passing as recorded in
  items 43–47. External install command exit `2`; no Processor start or Edge
  code deployment was attempted after the failure.
- real D1/R2/browser evidence: no live paper flow ran. D1 remained read-only
  verified and migrations `0017`–`0021` were not rerun. R2 was not written;
  its metadata read returned `15/41.9 MB`, then `0/0 B`, then `15/41.9 MB` on
  immediate repeat, so the inconsistency is an unresolved risk.
- external systems modified: the exact WAF entrypoint/rule was created and
  read back, then deleted and read back absent; Edge shared secret was
  written twice through secure stdin and deleted; one matching zhangbot token
  was delivered and deleted; one archive was transferred and deleted. No
  release/current/unit/service remained. Redis, Relay, Cloudflared, D1
  metadata and R2 objects were not intentionally changed.
- rollback: capability-first rollback is complete for the resources created
  in this attempt. WAF entrypoint read is `404`/`10003`; Edge secret name is
  absent; zhangbot token/archive/release/current are absent; existing services
  remain active. The local WAF token file is retained at its owner-controlled
  0600 mode for a separately authorized retry.
- remaining risks/non-goals: dependency package retrieval is not yet
  reproducibly available on zhangbot; R2 bucket-info reads were temporarily
  inconsistent; no live acceptance or deployment PASS is claimed.
- next exact card/action: remain on PAPER-10 but stop. Resolve the precise
  dependency network/approved wheel path and R2 read inconsistency, then
  restart with a fresh preflight. Do not rerun D1 `0017`–`0021`.

## 2026-08-28 dependency-closure retry and rollback

- status: `READY_FOR_DEPENDENCY_CLOSURE_COMMIT` (PAPER-10 is not PASS).
- baseline: clean `cloudflare-deploy` commit
  `6c67c8ec94eb32f8e9a77013c49c34f6c374b8d3`; direct read-only preflight
  passed after bypassing the unavailable local proxy. D1 `0017`–`0021` were
  read-only verified and not rerun; R2 remained at `15` objects / `41.9 MB`.
- retry findings: the old wheelhouse contained AppleDouble members and was
  rejected. A portable wheelhouse passed local/remote hash and member checks.
  The corrected release install then failed with exit `1` because
  `pypdf==6.15.0` requires `typing_extensions>=4.0` on Python 3.10 and the
  prior lock did not declare it. No release/current/unit/service/process or
  R2 object was created.
- rollback: the exact WAF rule/entrypoint was deleted and read back absent;
  the Edge shared secret was deleted and name-only read back absent; the
  zhangbot token, release/current/unit, and retry archives were removed.
  Redis/Relay/Cloudflared remained active and D1 was preserved.
- local resolution: `typing_extensions==4.13.2` is now pinned, the delivery
  lock hash is synchronized, and the delivery test asserts the exact pin.
  Focused/full local gates passed: Edge `129`, Processor `12`, frontend unit
  `50`, E2E `13`; `git diff --check` and normalized secret scan passed.
- next exact action: create and back up the review commit, then repeat the
  immutable read-only preflight. Recreate the exact four-path BIC-only rule
  only after that preflight; do not rerun D1 migrations.

## 2026-08-28 dependency-closure review backup

- status: `READY_FOR_IMMUTABLE_PREFLIGHT` (PAPER-10 is not PASS).
- The dependency-closure review commit is
  `96dce21a302ebe258f1ae6de343ae8b148bde76e` and contains the exact lock
  pin, delivery hash/test, and the no-secret retry/rollback evidence.
- Non-force push exited `0`; direct read-only `git ls-remote --heads origin
  cloudflare-deploy` exited `0` and returned exactly
  `96dce21a302ebe258f1ae6de343ae8b148bde76e` for the target ref. The local
  branch is `cloudflare-deploy` and the worktree is clean.
- External state after rollback is unchanged: no WAF rule/entrypoint, Edge
  shared secret, zhangbot token/release/service, Edge deployment, D1/R2
  write, Redis, Relay, or Cloudflared write. D1 migrations remain applied and
  must not be rerun.
- next exact action: repeat the full immutable read-only Cloudflare and
  zhangbot preflight from this backed-up commit; only if it passes may the
  exact four-path BIC-only rule be recreated.

## 2026-08-28 secret handoff retry and rollback

- status: `BLOCKED_PROCESSOR_SECRET_HANDOFF_PIPE` (PAPER-10 is not PASS).
- From clean backed-up commit
  `343738798619546e313a0030f7b7391a6d32cec1`, read-only preflight passed and
  exact WAF rule creation/readback passed. The Edge secret write returned
  success, but the combined SSH stdin/here-document handoff emitted a remote
  command-not-found diagnostic; the token was not accepted as a trustworthy
  match and Processor startup was not attempted.
- Rollback completed: WAF rule/entrypoint deleted/read back absent, Edge
  secret deleted/read back absent by name, zhangbot token env removed, and no
  release/current/unit/process remained. Existing Redis/Relay/Cloudflared
  stayed active; D1/R2 were preserved and no Edge code deployment occurred.
  The one-time value was invalidated and is not recorded in evidence.
- next exact action: commit and back up this blocker evidence, then repeat
  preflight and exact WAF creation. Deliver the new secret through a single
  stdin-only remote command (no here-document), validate only file shape and
  later functional connect, and stop on any ambiguity. Do not rerun D1
  migrations.

## 2026-08-28 artifact-verifier retry and rollback

- status: `BLOCKED_PROCESSOR_ARTIFACT_VERIFIER` (PAPER-10 is not PASS).
- The clean baseline was `3039acc5cc3b169ecb5d0c4b2090e980b35ee95d`.
  Read-only preflight, exact WAF rule/readback, and corrected single-stdin
  secret/token setup passed. The local archive verifier then exited `1` due
  to an invalid `raise None` in its no-match branch, before transfer or
  release installation.
- Rollback completed: WAF rule/entrypoint deleted/read back absent, Edge
  secret deleted/read back absent by name, zhangbot token removed, and no
  release/current/unit/process remained. D1/R2 were preserved and existing
  Redis/Relay/Cloudflared stayed active.
- Corrected local packaging now passes: minimal Processor-only source archive
  and three-wheel dependency archive, both without `._*` members. Source
  archive hash is `b15487530515787a69b4a2592e796d09c6ca841837236371c472d263141edf8d`;
  wheel archive hash is
  `0556776a06168ac46933365d7e778d532a4c251c62015e4b46cea69e647aefce`.
- next exact action: commit and back up this blocker evidence, then repeat
  immutable read-only preflight from the new clean commit. Do not recreate
WAF/secret/token before that preflight; do not rerun D1 migrations.

## 2026-08-29 GitHub backup blocker

- status: `BLOCKED_GITHUB_BACKUP` (PAPER-10 is not PASS).
- Corrected local artifact packaging passed with source archive
  `b15487530515787a69b4a2592e796d09c6ca841837236371c472d263141edf8d` and
  wheel archive
  `0556776a06168ac46933365d7e778d532a4c251c62015e4b46cea69e647aefce`, both
  without `._*` members. No transfer or production write followed.
- Local evidence commit
  `d67952b5bf560aebfbbf0671fab145fcb66718a6` was created. The configured
  proxy returned connection-refused exit `7`; direct GitHub HTTPS timed out
  with exit `28`; bounded direct `ls-remote` and non-force push returned
  `142`. The last confirmed remote ref remains
  `3039acc5cc3b169ecb5d0c4b2090e980b35ee95d`; the local commit is not claimed
  as backed up.
- External state remains rolled back: WAF/secret/token/release/service absent,
  D1/R2 preserved, Redis/Relay/Cloudflared unchanged. Worktree is clean and
  `deployment.txt` is absent.
- next exact action when GitHub connectivity returns: read-only verify the
  remote ref, non-force push `d67952b`, and exact `ls-remote` verification;
  only then repeat immutable preflight. Do not run D1 migrations again.

## 2026-08-29 bounded GitHub retry

- status remains: `BLOCKED_GITHUB_BACKUP` (PAPER-10 is not PASS).
- The local evidence commit `ea0f92e` was created. A fresh read-only
  `ls-remote` returned exit `128` with TLS `SSL_ERROR_SYSCALL`; two direct
  variants returned exit `142` after bounded timeouts. Three non-force push
  variants likewise returned exit `128`, `142`, and `142`; no remote update
  occurred. The last confirmed remote ref remains
  `3039acc5cc3b169ecb5d0c4b2090e980b35ee95d`.
- No Cloudflare or zhangbot write was performed in this retry; the WAF rule,
  Edge shared secret, Processor token, release, service, and deployment are
  absent, while D1 is preserved and Redis/Relay/Cloudflared are unchanged.
- Next exact action: when GitHub connectivity returns, read-only verify the
  target, non-force push the current local evidence history, and verify the
  exact remote ref with `ls-remote`; only then repeat immutable PAPER-10
  preflight. Do not rerun migrations.

## 2026-08-29 release retry rollback

- status: `BLOCKED_PROCESSOR_RELEASE_SCRIPT` for this retry; PAPER-10 is not
  PASS.
- The clean backed-up baseline was
  `7f1944a6e056e469509e1eecf5f7df88b5358a12`. Read-only immutable preflight,
  exact four-path BIC-only WAF creation/readback, safe Edge/zhangbot token
  handoff, and no-AppleDouble archive/hash checks passed.
- Release setup stopped with exit `1` because the remote hash assertion used
  paths relative to `$HOME`, not the extracted release directory. No unit was
  registered, no Processor was started, and no R2 object or Edge code deploy
  occurred.
- Rollback is verified: token env absent; Edge Secret deleted and absent by
  name; WAF rule deleted (HTTP `200`), empty entrypoint deleted (HTTP `204`),
  final entrypoint readback `404`; D1 preserved and existing
  Redis/Relay/Cloudflared services unchanged.
- Next exact action: commit/back up this evidence, repeat the full read-only
  preflight, recreate/read back the exact WAF rule, and retry release setup
  with absolute paths for all extracted-file hash calculations. Do not rerun
  D1 migrations.

## 2026-08-29 corrected release smoke-check stop and rollback

- status: `BLOCKED_PROCESSOR_RELEASE_SMOKE_CHECK` for this retry; PAPER-10 is
  not PASS.
- From the backed-up `a270b30ad4d144aad5431713d163dee8e7fcac4b` baseline, the
  full immutable preflight, second exact WAF rule/readback, and secure
  Edge/zhangbot token handoff passed. The current-commit archives passed
  remote hash and AppleDouble checks.
- The corrected release setup created the venv and installed the offline
  dependency lock, but the import smoke check exited `1` because nested SSH
  quoting turned the harmless Python print string into a `NameError`. No unit
  was registered or started.
- Rollback is verified: release/current/unit/process absent; zhangbot token
  removed; Edge Secret deleted and absent by name; WAF rule deleted (HTTP
  `200`), empty entrypoint deleted (HTTP `204`), and final readback `404`.
  D1/R2 were preserved and Redis/Relay/Cloudflared were unchanged.
- Next exact action: commit/back up this evidence, repeat immutable preflight,
  recreate/read back the exact WAF rule, and rerun the release without a
  nested shell-quoted smoke-check expression. Do not rerun migrations.
