# PAPER-10 Processor health closure — 2026-08-30

## Scope and baseline

- Objective: install the already-reviewed single zhangbot Paper Processor and
  verify the real fixed Edge `connect`/`poll` loop reaches configured health.
- Branch: `cloudflare-deploy`.
- Local baseline HEAD: `e30187cc11b2c0a555b4e10da03484ca6fed32cd`.
- Worktree was clean before this evidence amendment. The release content is
  the already-validated `aa2306fe291fa31da73dd2d55223112cafafc580` source
  tree; `git diff aa2306fe..HEAD` has zero changes under
  `backend/paper_processor` and the dependency lock. The current HEAD change
  is evidence-only.
- D1 migrations `0017`–`0021` were not rerun. Kimi, browser state, R2,
  Redis, Redis Relay, and Cloudflared were not changed by this subphase.

## Artifact transfer and immutable verification

- Source archive SHA-256:
  `f827dc40a79d245419d945d5bceb7c57a1300199f7b3b00b40f67da1867cc70e`.
  SCP and remote SHA readback both exited `0`.
- The first wheel archive was not used after remote GNU tar exposed four
  macOS AppleDouble `._*` members. It was not extracted into the release.
  The same locked wheels were repacked locally as USTAR; the used wheelhouse
  archive SHA-256 is
  `9ffe54a2e27cad1b0840479d9d2decf8ec092ac48028bff9073796f3385a3d66`.
  Local and remote member scans both reported zero unsafe `._*`/parent-path
  members, and the remote archive contained exactly three wheels.
- Remote extraction and tree validation exited `0`. The release-relative
  source aggregate is
  `510715c4a3e8605181219508d38bd8747b1fff28a7c676fb64d15fd1ed57d15e`;
  dependency-lock SHA-256 is
  `e7b669892e0e5790179ee84dedd106d04ac40005ca49943059d2ee585f63ff97`;
  service-unit SHA-256 is
  `424a6846ef7b30d1eb505811da53620156e9186dae60ece38f3826e8338a2b2f`.
  All matched `backend/paper_processor/delivery.v1.json`.
- The immutable release was moved to
  `/home/zhangyvjing/.local/share/infinity-paper-processor/releases/aa2306fe291fa31da73dd2d55223112cafafc580`.
  The venv used Python 3.10.12; `ensurepip`, offline hash-locked pip install,
  `pip check`, and `fitz`/`pypdf` imports exited `0`. The non-secret remote
  install record and package list were written mode `0600`.

## Capability and service result

- The exact zone custom WAF rule was created and strictly read back. Entrypoint
  ID: `68dd39f74fee45d0a4c5b5120956eeb9`; rule ID:
  `4a6264b8d93849ef9d0f20139268a08a`. It is one enabled, logged `skip` rule
  with `products=["bic"]`, matching only source IP `39.105.204.121`, host
  `infinity.zhangyvjing.com`, POST `/api/paper-processor/connect`,
  `/poll`, `/control`, and PUT `/api/paper-processor/object`. The corrected
  strict readback exited `0`; no broader path or product was added.
- The coordinator-provisioned `PAPER_PROCESSOR_SHARED_SECRET` binding and
  zhangbot `processor.env` were not read or overwritten. The env file was
  only metadata-checked as owner `zhangyvjing`, mode `0600`, one-key/one-line.
  No secret value entered a command argument, log, repository, or evidence.
- The installed user unit passed `systemd-analyze --user verify`; daemon reload,
  enable, and start exited `0`. It is `enabled` and `active/running` with
  MainPID `2052141`, `ExecMainStatus=0`, and `NRestarts=0`.
- Two status samples eight seconds apart returned the same PID and stable
  `active/running` state, with zero restarts and zero recent error-priority
  journal lines. Because `runner.py` performs `connect()` before entering
  its bounded `poll()` loop, this stable post-start process is the real
  connect/poll readiness evidence; no mock endpoint was used.
- A read-only request from zhangbot to `https://infinity.zhangyvjing.com/health`
  returned HTTP `200` with `d1=configured`, `resource_bucket=configured`, and
  `paper_processor=configured`.
- The Processor PID had zero listening sockets. The existing
  `infinity-redis`, `infinity-redis-relay`, and `infinity-cloudflared` user
  services remained active/running with their established listener inventory.
  The temporary upload directory was removed after installation; the
  immutable release, current link, unit, and work root were preserved.

## Boundary and status

- External writes in this subphase: one narrowly scoped BIC-only WAF rule;
  zhangbot release files, virtualenv, user unit, enable/start state, and
  non-secret install records. The Edge secret/token were pre-provisioned by
  the coordinator and were not changed here.
- No D1 migration, R2 object write, Kimi/provider change, Edge deployment,
  browser action, Redis/Relay/Cloudflared change, or other host write occurred.
- Status: `PROCESSOR_HEALTH_PASS_BROWSER_ACCEPTANCE_PENDING`. This subphase
  passes its stated health objective; PAPER-10 overall is not PASS until the
  separately required authenticated real-paper browser acceptance completes.
- Rollback reference: revoke the new Processor capability first by deleting
  WAF rule `4a6264b8d93849ef9d0f20139268a08a` and empty entrypoint
  `68dd39f74fee45d0a4c5b5120956eeb9`, then stop/disable the new unit and
  remove only this release/current link after read-only verification. Preserve
  D1/R2 metadata and existing Redis/Relay/Cloudflared services.
