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

## 2026-08-29 Processor listener assertion retry and rollback

- status: `BLOCKED_PROCESSOR_LISTENER_ASSERTION` for this retry; PAPER-10 is
  not PASS.
- From the clean backed-up `6a70062186b68b2cd4703f762d3a8f62d3b6eb1e`
  baseline, immutable preflight, exact WAF, secure secret/token handoff,
  archive checks, venv/dependency/import validation, and systemd start
  completed before the post-start listener assertion.
- The assertion exited `81` after treating the existing cloudflared
  `127.0.0.1:20242` metrics socket as unexpected. Read-only process mapping
  confirmed 20242 is cloudflared, 8090 is Relay, and 6379 is Redis; the
  Processor main PID had no listener. No Processor inbound socket was
  observed.
- Rollback is verified: release/current/unit/process absent; token removed;
  Edge Secret absent by name; WAF rule/entrypoint deleted with final readback
  `404`; D1/R2 preserved and Redis/Relay/Cloudflared unchanged.
- Next exact action: back up this evidence, repeat immutable preflight, then
  use a PID-specific no-Processor-listener assertion before continuing live
  acceptance. Do not rerun migrations.

## 2026-08-29 backed-up release retry stop and rollback

- status: `BLOCKED_PROCESSOR_RELEASE_SCRIPT`; PAPER-10 is not PASS.
- baseline/current commit: `becde2db27aa7ef7e31bfb2ddbe4a0f4ce7be8cf` on
  `cloudflare-deploy`; exact non-force GitHub push/readback is the same SHA.
- one completed outcome: backup verification and a fresh immutable preflight
  completed; a diagnostic-preserving release retry is still required.
- modified files: PAPER-10 evidence only; no product source or migration was
  changed.
- focused/local gates: previously passing gates remain valid; this retry's
  external command outcomes are recorded in `tests-and-exit-codes.txt`.
- real D1/R2/browser evidence: no new live case was run; D1 `0017`–`0021`
  were not rerun, R2 was not written, and browser acceptance was not started.
- failed required check: zhangbot release setup exited `1` after systemd
  symlink creation without exposing the failing assertion; no cause is
  inferred.
- D1/R2/Redis/external systems modified: the failed retry's WAF rule,
  entrypoint, Edge Secret, and zhangbot token were created then rolled back;
  D1/R2 and Redis/Relay/Cloudflared were preserved; Edge code was not
  deployed.
- secret scan result: no secret value was recorded; the retry's boundary is
  recorded in `secret-scan.txt`.
- rollback commit/operation: WAF rule HTTP `200`, entrypoint HTTP `204` then
  readback `404`; Edge Secret deletion/name-only absence; token file removal
  and absence; release/current/unit/process absent.
- remaining risks and non-goals: Processor release diagnosis, Edge deploy,
  real D1/R2/Processor/browser acceptance, and final PASS remain outstanding.
- next exact card: repeat read-only preflight, recreate/read back the exact
  four-path BIC-only rule, issue one new shared secret/token pair, install a
  diagnostic-preserving immutable zhangbot release, then stop on any failure.

## 2026-08-29 wheel archive metadata stop and rollback

- status: `BLOCKED_PROCESSOR_ARCHIVE_METADATA`; PAPER-10 is not PASS.
- baseline/current commit: `4647fcb761708d89794f63f99baf5317ed215c6d`, already
  backed up to `origin/cloudflare-deploy`.
- one completed outcome: immutable preflight and all local gates passed, but
  remote wheel archive validation stopped before release installation.
- modified files: PAPER-10 evidence only; no product source, D1 migration, or
  runtime contract changed.
- real D1/R2/browser evidence: not run; D1 migrations were not rerun, R2 was
  not written, and Edge code was not deployed.
- failed required check: remote GNU tar/strict AppleDouble validation exited
  `32` on the wheel archive after macOS extended metadata warnings.
- external systems modified: exact WAF rule/entrypoint, Edge Secret, zhangbot
  token, and staging were created then removed. D1/R2 and existing
  Redis/Relay/Cloudflared were preserved.
- secret scan result: no secret value was recorded; the secure boundary and
  rollback are recorded in `secret-scan.txt`.
- rollback operation: rule HTTP `200`, entrypoint HTTP `204` then `404`, Edge
  Secret name-only absence, token/staging absence; no release/current/unit/
  process remained.
- remaining risks and non-goals: replacement archive still needs remote
  validation, followed by Processor release, Edge deploy, and complete live
  acceptance.
- next exact card: repeat immutable preflight, recreate/read back exact WAF
  capability and credentials, transfer the metadata-free replacement archive,
  then continue only if remote validation passes.

## 2026-08-29 systemd verification-order stop and rollback

- status: `BLOCKED_PROCESSOR_SYSTEMD_VERIFY_ORDER`; PAPER-10 is not PASS.
- baseline/current commit: `7505d07012ef1e210b7782eff5b6484e0e68d778`, already
  backed up to `origin/cloudflare-deploy`.
- one completed outcome: current metadata-free release passed remote archive
  validation and offline dependency installation; systemd verification was
  reached with a diagnostic-preserving command.
- modified files: PAPER-10 evidence only; no product source, D1 migration, or
  runtime contract changed.
- real D1/R2/browser evidence: not run; D1 migrations were not rerun, R2 was
  not written, and Edge code was not deployed.
- failed required check: `systemd-analyze --user verify` exited `1` because
  verification preceded activation of the `current` symlink referenced by
  `ExecStart`.
- external systems modified: exact WAF rule/entrypoint, Edge Secret, zhangbot
  token, release, and staging were created then removed. D1/R2 and existing
  Redis/Relay/Cloudflared were preserved.
- secret scan result: no secret value was recorded; secure transfer and
  rollback are recorded in `secret-scan.txt`.
- rollback operation: WAF rule HTTP `200`, entrypoint HTTP `204` then `404`,
  Edge Secret name-only absence, token/release/current/unit/staging absence;
  Processor inactive and existing services active.
- remaining risks and non-goals: the corrected activation-before-verify
  release, Edge deployment, and complete live acceptance remain outstanding.
- next exact card: repeat immutable preflight, recreate/read back the exact
  WAF capability and credentials, install the verified release with
  activation before systemd verification, and stop on any failure.

## 2026-08-29 live acceptance browser blocker and full rollback

- status: `BLOCKED_AUTHENTICATED_BROWSER_ACCEPTANCE`; PAPER-10 is not PASS.
- baseline/current commit: `5d2c12875296bd7ce1fad824cb122fc44dab76a1`,
  backed up before the external attempt.
- one completed outcome: the current Processor release and Edge deployment
  reached the intended service state, but the required authenticated browser
  DOM was unavailable before any live case began.
- modified files: PAPER-10 evidence only; no product source or migration was
  changed.
- focused/local gates: Edge `check && test` 0 (129 tests), Processor pytest 0
  (12), frontend typecheck/lint/unit 0 (50), frontend E2E 0 (13); final
  evidence diff/secret gate is recorded in `secret-scan.txt`.
- real D1/R2/browser evidence: no authenticated browser case was run. Root
  HTTPS 200 without authenticated DOM is explicitly not acceptance evidence.
- failed required check: in-app Browser was client-blocked and Chrome
  navigation timed out before DOM; no workaround or unapproved credential was
  used.
- D1/R2/Redis/external systems modified: Edge version
  `4d2a792b-a767-4e91-8a66-09aac0c673e9` was deployed then rolled back to
  `d287b02d-a94c-4caa-b473-70f2368f4999`; WAF rule/entrypoint, Edge Secret,
  zhangbot token/release/service were created then removed. D1/R2 metadata
  was preserved; migrations were not rerun; Redis/Relay/Cloudflared were not
  modified.
- secret scan result: no secret value was recorded; see `secret-scan.txt`.
- rollback operation: WAF HTTP `200`/`204`/`404`, Secret name-only absence,
  Processor targets absent/inactive, Edge rollback 0 and 100% readback.
- remaining risks and non-goals: all real authenticated positive/negative
  cases and final release gate remain outstanding. The project is not
  complete.
- next exact card: restore a functioning authenticated browser session/DOM,
  then rerun PAPER-10 from a fresh read-only preflight; do not reuse this
  rolled-back capability state or claim PASS from the direct HTML read.

## 2026-08-29 authenticated DOM capability recheck

- status: `BLOCKED_AUTHENTICATED_BROWSER_DOM_UNAVAILABLE`; PAPER-10 is not
  PASS.
- the existing Chrome extension exposed the exact target tab metadata:
  URL `https://infinity.zhangyvjing.com/`, title `Infinity Agents`.
- read-only `chrome.user.openTabs()` and `chrome.tabs.list()` succeeded, but
  claiming and reading the exact target tab timed out before a controllable
  handle or DOM was returned. A selected-tab read timed out as well.
- no navigation, input, login data, upload, paper operation, or application
  mutation occurred; no secrets or browser storage were inspected.
- the direct metadata is not authenticated DOM evidence. No live acceptance
  case was run and no external write occurred in this recheck.
- detailed evidence: `browser-recheck.txt` in this directory.
- next exact action: restore responsive control of this same existing Chrome
  tab, then repeat a fresh read-only PAPER-10 preflight. Do not create or
  reset another session, reuse rolled-back state, or claim PASS.

## 2026-08-29 repeated Chrome control attempts

- status remains `BLOCKED_AUTHENTICATED_BROWSER_DOM_UNAVAILABLE`; PAPER-10 is
  not PASS.
- the exact existing tab remained visible in the connected Chrome extension
  and `tabs.list()` returned ID `876490032`. Direct handle acquisition timed
  out; `tabs.selected()` returned the same ID, but visible-DOM extraction and
  a read-only screenshot both timed out.
- no page mutation, credential transmission, or production operation was
  performed. No additional external system was touched.
- detailed results are in `browser-recheck.txt`; the existing rollback state
  is unchanged. Next exact action is to restore a responsive control/read
  path for this same tab, then start a fresh read-only PAPER-10 preflight.

## 2026-08-29 current-tab DOM retry

- status remains `BLOCKED_AUTHENTICATED_BROWSER_DOM_UNAVAILABLE`; PAPER-10 is
  not PASS.
- the selected handle again matched the existing tab ID `876490032` and its
  known public URL/title, but both documented visible-DOM extraction and the
  Playwright DOM snapshot timed out.
- no browser or production mutation occurred. No credential, storage, or
  application payload was inspected or transmitted.
- detailed attempt evidence is in `browser-recheck.txt`; the previous
  capability-first rollback remains unchanged. Next exact action is to make
  the same tab's DOM control channel responsive, then begin a fresh read-only
  PAPER-10 preflight.

## 2026-08-29 latest current-tab retry

- status remains `BLOCKED_AUTHENTICATED_BROWSER_DOM_UNAVAILABLE`; PAPER-10 is
  not PASS.
- the same selected tab `876490032` was used. Both documented visible-DOM
  extraction and a fresh Playwright DOM snapshot timed out again.
- no browser or production mutation occurred; no credential, storage, page
  payload, or live acceptance request was inspected or transmitted.
- detailed results are in `browser-recheck.txt`; existing rollback state is
  unchanged. Next exact action is to restore the DOM control path for this
  same tab, then start a fresh read-only PAPER-10 preflight.

## 2026-08-29 fresh-tab ownership blocker

- status: `BLOCKED_BROWSER_TAB_OWNED_BY_SOURCE_SESSION`; PAPER-10 is not PASS.
- the exact new tab `876490061` was found with the requested URL/title, but
  both immediate and delayed claims were refused because the tab remains
  owned by source session `01a03d69-25c4-7ff0-94e7-9b3af0a8e627`.
- no alternate tab/session was created or reused, and no page, credential, or
  production system was modified. No fresh preflight or live acceptance ran.
- detailed evidence is in `browser-recheck.txt`. Next exact action is for the
  source session to release this same tab; then claim it and read the DOM
  before beginning a fresh PAPER-10 preflight.

## 2026-08-29 post-release claim retry

- status remains `BLOCKED_BROWSER_TAB_OWNED_BY_SOURCE_SESSION`; PAPER-10 is
  not PASS.
- the current `openTabs()` result supplied the requested URL/title object, but
  claim was still refused because the tab remained owned by the source
  browser session. No alternate tab or session was used.
- no DOM was read and no browser, Cloudflare, zhangbot, D1, R2, WAF, Secret,
  or deployment write occurred. Detailed evidence is in
  `browser-recheck.txt`.

## 2026-08-29 Kimi provider authenticated recheck and rollback

- Status: `BLOCKED_KIMI_PROVIDER_AUTHENTICATION`; PAPER-10 is not PASS.
- The existing authenticated Infinity Agents tab was successfully claimed and
  its visible DOM was available. A harmless text probe returned the real
  provider error `401 Invalid Authentication`.
- Per the provider rollout rollback rule, no tool or image probe and no other
  PAPER-10 release step was attempted. Analysis Worker traffic was restored to
  the specified rollback version `d287b02d-a94c-4caa-b473-70f2368f4999` at
  100%; deployment readback and the public readiness endpoint succeeded.
- The only external write in this subphase was that Worker traffic rollback.
  D1 migrations `0017`-`0021` were not rerun. No WAF, R2 object, new Edge
  Secret, zhangbot Processor, Redis/Relay/Cloudflared, or live paper workflow
  write occurred in this subphase.
- Detailed redacted evidence: `provider-recheck.md`. The provider credential
  value was never read or recorded.

Next exact action: correct/reissue the approved Kimi credential through its
secret channel, then repeat the fresh authenticated text, tool, and image
preflight. Do not resume the rest of PAPER-10 until all three pass.

## 2026-08-29 Kimi K2.6 browser-probe blocker and rollback

- Status: `BLOCKED_AUTHENTICATED_BROWSER_TAB_OWNERSHIP`; PAPER-10 is not PASS.
- The expected existing authenticated Infinity Agents tab was rediscovered,
  but two claims were refused because the tab remained owned by the source
  browser session. No alternate session was created and no provider request was
  sent. Provider status is `NOT_VERIFIED`; no provider HTTP response or model
  result was obtained.
- The Kimi K2.6 candidate was read-only confirmed at 100% before the rollback.
  Per the non-clean-success rule, Edge traffic was restored to
  `d287b02d-a94c-4caa-b473-70f2368f4999` at 100%; deployment and health
  readbacks succeeded.
- The only Cloudflare write in this subphase was that Worker traffic rollback.
  D1 migrations were not rerun. No R2 object, WAF rule, new Edge secret,
  zhangbot Processor, Redis/Relay/Cloudflared, or live paper workflow write
  occurred.
- Detailed redacted evidence: `k26-browser-probe.md`; no credential value was
  read or recorded.

Next exact action: release the same existing authenticated browser tab, then
rediscover/claim it and run the single harmless Kimi K2.6 text probe. Do not
start paper tooling or image analysis before a clean text success.

## 2026-08-29 Kimi K2.6 authenticated 401 result

- Status: `BLOCKED_KIMI_API_CREDENTIAL_OR_ENTITLEMENT`; PAPER-10 is not PASS.
- The coordinator's authenticated browser acceptance record reports a real
  text probe against Kimi K2.6 returning provider HTTP `401 Invalid
  Authentication`. The result is recorded as user-visible evidence; no
  credential value is present.
- The Kimi candidate `93983647-e6f6-4497-a128-2dfd478d15f5` remains deployed at
  100% under deployment `5d0122b3-4d06-45b3-8e3f-67c2a684a4a2` by explicit
  decision. StepFun was not used as a rollback target because it is also
  unusable.
- This evidence-only update made no credential, browser, deployment, paper
  tooling, D1, R2, WAF, Processor, Redis, Relay, or Cloudflared change.

Detailed evidence: `k26-provider-auth-result.md`.

Next exact action: resolve the approved Kimi credential/account entitlement,
then repeat the text gate before any paper or image operation.

## 2026-08-29 Kimi K2.6 mainland endpoint correction — local gate

- Status: `READY_FOR_KIMI_MAINLAND_ENDPOINT_DEPLOY`; PAPER-10 is not PASS.
- Baseline was local `7d1c75cbd936ce51a5672997fb63368226c7e37b` on
  `cloudflare-deploy`, with the existing Processor lockfile/manifest changes
  preserved and reviewed.
- Official mainland documentation confirms `https://api.moonshot.cn/v1`,
  `kimi-k2.6`, Bearer authentication, `POST /v1/chat/completions`, and
  base64 `image_url` input. The checked-in Worker configuration was corrected
  from the international `.ai` endpoint to the mainland `.cn` endpoint.
- Regression coverage now asserts the exact text request URL/method/auth/model
  and the exact image request URL/auth/base64 message shape. The first red
  configuration test failed against the old `.ai` value; all corrected tests
  passed.
- Local gates passed: Edge 24 files/134 tests; Processor pytest 12 tests;
  frontend typecheck/lint/unit 50 tests; frontend E2E 13 tests after the
  permitted elevated local-server retry; `git diff --check` exit `0`.
- Fresh read-only production checks confirmed the target account, Worker,
  existing D1 migrations, R2 bucket, 100% Kimi K2.6 candidate, secret names,
  and `/health` HTTP `200` with Paper Processor still unconfigured. The first
  mistaken `/healthz` probe returned `404`; no write followed it.
- No credential value was read or recorded. No D1 migration, R2 object, WAF,
  Edge Secret, zhangbot, Processor, Redis/Relay/Cloudflared, browser, or
  deployment write occurred in this local phase.

Next exact action: commit the local correction, deploy the corrected mainland
endpoint through the already-authorized Edge path, and run one harmless
authenticated text probe. If the real result remains `401 Invalid
Authentication`, record the upstream Kimi credential/account-entitlement
blocker and do not switch to StepFun.
## 2026-08-29 Kimi mainland deployment and authenticated-tab blocker

- Status: `BLOCKED_KIMI_MAINLAND_AUTHENTICATED_BROWSER_TAB`; PAPER-10 is not
  PASS.
- Local commit `286d0c177f5ebc89b740709bcb3f466c493d83ce` passed its local gates.
  The corrected Worker was deployed as version
  `79755db3-c12d-4737-b601-aa99f11e3f93` under deployment
  `a98fd1bd-ff46-4768-8cd8-af23dcc53fca`, read back at 100%, and `/health`
  returned HTTP `200`.
- The existing authenticated Chrome tab was found by its current URL/title on
  three fresh `openTabs()` attempts, but every claim was refused because the
  tab remained owned by the source browser session. No DOM or provider request
  was obtained; the prior international-endpoint `401` must not be reused as
  the mainland-endpoint result.
- No Paper operation, D1 migration, R2 write, WAF, Edge Secret, zhangbot
  Processor, Redis/Relay/Cloudflared, or GitHub write occurred in this
  subphase. The corrected Edge version remains at 100%; StepFun was not used.
- Detailed deployment evidence: `deployment.txt`; local contract evidence:
  `k26-mainland-contract.md`.

Next exact action: obtain control of the same existing authenticated tab after
the source session releases it, read the visible DOM, and run only the
harmless text probe against Worker version `79755db3-c12d-4737-b601-aa99f11e3f93`.
If that real result is still `401 Invalid Authentication`, record the upstream
Kimi credential/account-entitlement blocker and then resume only the
non-model PAPER-10 work.

## 2026-08-29 Kimi mainland text gate and exact WAF rule

- Status: `READY_FOR_PAPER_PROCESSOR_RELEASE`; PAPER-10 is not PASS.
- The coordinator's real authenticated browser record reports that the exact
  prompt `请只回复：KIMI_MAINLAND_TEXT_PROBE_OK`, sent to corrected Worker
  version `79755db3-c12d-4737-b601-aa99f11e3f93`, produced the exact visible
  result `KIMI_MAINLAND_TEXT_PROBE_OK`.
- This supersedes the earlier international `.ai` endpoint `401 Invalid
  Authentication` record. Kimi K2.6 remains at 100% on the mainland `.cn`
  configuration; StepFun was not used.
- The scoped WAF capability preflight passed. The newly created exact
  fixed-endpoint BIC-only rule is entrypoint
  `65e15547ea3144feb70791fc155d1df0`, rule
  `5695e7eb000c4f49b77a616cff1411ae`; immediate readback validated the exact
  source IP, host, four method/path pairs, `skip`, `products=["bic"]`,
  enabled state, and logging.
- No credential value is present in evidence. No D1 migration was rerun, and
  no Edge shared secret, Processor token/release/service, R2 object, Redis,
  Relay, or Cloudflared write has occurred yet in this release attempt.

Next exact action: repeat the immutable read-only preflight, then perform the
authorized minimal Edge shared-secret/zhangbot token handoff and single
Processor release. On any failure, delete the new WAF rule and entrypoint
first, then revoke only the newly created capability material and remove the
new release/service.

## 2026-08-29 immutable preflight recheck passed

- Status: `READY_FOR_SECRET_AND_PROCESSOR_RELEASE`; PAPER-10 is not PASS.
- Local `cloudflare-deploy` HEAD is
  `794f8b10d0c86c50a0575cc4fe2869aaa0aa537b` and the worktree is clean. A
  read-only `ls-remote` returned actual remote ref
  `e551a5994cd228f19a2ae816c4529e4b04cf41a1`; no new GitHub push is included
  in this continuation. The current evidence commit contains no production
  source change.
- The source, dependency-lock, and service-unit hashes match the delivery
  manifest; no `._*` release input is present. The target account, Worker,
  D1, and R2 identities match the checked-in contract. D1 reported no pending
  migrations and a zero-write schema read with all required Paper tables and
  indexes. R2 remains `15` objects / `41.9 MB`; `/health` is HTTP `200` with
  D1/R2 configured and Processor unconfigured.
- The exact active WAF rule read back successfully: entrypoint
  `65e15547ea3144feb70791fc155d1df0`, rule
  `5695e7eb000c4f49b77a616cff1411ae`, fixed source IP/host/four method-path
  pairs, `skip` only `bic`, enabled, and logged.
- zhangbot still has the exact `python3.10-venv` package, passing disposable
  venv/ensurepip/pip checks, fixed egress `39.105.204.121`, HTTP-200 access to
  the allowed arXiv/NCBI/PMC sources, no Processor release/service/token or
  process, no Docker, and no Processor listener. Existing cloudflared, Redis,
  and Redis Relay services are active and unchanged.
- The verified mainland Kimi text gate is recorded as exact visible
  `KIMI_MAINLAND_TEXT_PROBE_OK` against Worker version
  `79755db3-c12d-4737-b601-aa99f11e3f93`; StepFun remains unused.

Next exact action: perform the already authorized minimal Edge shared-secret
write and one-time zhangbot token handoff, then install and verify the
commit-named single Processor release. If any later step fails, remove the
new WAF rule/entrypoint first, then revoke only newly created capability
material and remove the new release/service; preserve D1/R2 metadata and
existing Redis/Relay/Cloudflared services.

## 2026-08-29 token handoff wrapper failure and rollback

- Status: `BLOCKED_PROCESSOR_TOKEN_HANDOFF_READ`; PAPER-10 is not PASS.
- The exact WAF rule was active and read back before this attempt. Edge Secret
  creation succeeded, but the SSH token handoff stopped before writing because
  `set -e` treated EOF from the deliberately newline-free stdin value as a
  fatal `read` status. No Processor token file, release, unit, process, or
  listener was created.
- Capability-first rollback completed: the WAF rule and entrypoint were
  deleted and the entrypoint read back `404`; the Edge Secret was deleted and
  absent by name-only readback; the zhangbot staging directory and local
  temporary secret were removed. D1/R2 metadata and existing Redis/Relay/
  Cloudflared services were preserved.
- No credential value is recorded. The next exact action is a fresh immutable
  preflight followed by recreation/readback of the exact WAF rule and a
  corrected EOF-tolerant one-line token handoff. Do not rerun D1 migrations.
