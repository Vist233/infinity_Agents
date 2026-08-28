# CHECKPOINT IMPLEMENT-20260826-CF-PAPER / PAPER-10

- status: `IN_PROGRESS`
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
- external systems modified: GitHub `origin/cloudflare-deploy` is currently
  still at the previously verified backup commit
  `33d494cb5a402101a48833e46b822b0f04d64d41`; the new release commit above is
  local and pending a non-force backup. Production D1 migrations `0017`–`0021`
  were applied and read back. Edge version
  `4ef4cea2-71ca-402e-aa4a-f5322417da2a` was deployed during the failed attempt;
  its temporary shared secret and the zhangbot token were then revoked/removed.
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
