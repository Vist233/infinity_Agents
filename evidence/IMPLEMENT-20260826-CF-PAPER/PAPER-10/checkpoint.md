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
