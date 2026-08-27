# Dedicated Paper Processor — zhangbot delivery v2

This runbook implements the checked-in `paper-processor.delivery/v2` contract
at `backend/paper_processor/delivery.v1.json`. `zhangbot` is the one approved
and one allowed host for this release. It is an owner-operated Linux VPS
runtime, not a public Worker, not the C7 Worker runtime, and not a Docker
deployment. No other host, replica, or horizontal scaling is permitted.

The Processor is an outbound-only client. It connects to the fixed Edge
control plane at `https://infinity.zhangyvjing.com` and downloads only from the
source allowlist enforced by `backend/paper_processor/ingest.py`:
`arxiv.org`, `export.arxiv.org`, `www.ncbi.nlm.nih.gov`, `ncbi.nlm.nih.gov`,
and `pmc.ncbi.nlm.nih.gov`. It exposes no listening socket or inbound port.
After a source is admitted and downloaded, parsing must not use the network.

## 1. Reviewed release artifact

The release is a reviewed Git commit plus the checked-in hashes in the
delivery definition. The Processor source hash is calculated with the exact
command recorded in that definition. Dependencies are installed only from
`backend/requirements.paper-processor.zhangbot.txt`, which pins exact
versions. The deployment is a Python 3.10 virtualenv, with this layout:

```text
/home/zhangyvjing/.local/share/infinity-paper-processor/releases/<commit>/
  .venv/
  install-record.txt
/home/zhangyvjing/.local/share/infinity-paper-processor/current -> releases/<commit>
```

The installation record must contain the interpreter version, the lock-file
hash, the reviewed commit, and the installed package list. It must not contain
tokens or parent credentials. Before activation, verify the source, lock file,
service unit, and installation record against the release evidence. A
Dockerfile is not a delivery artifact for this runtime.

## 2. Runtime and credential boundary

The service unit supplies only these non-secret settings:

| Setting | Required value or rule |
|---|---|
| `PAPER_PROCESSOR_EDGE_URL` | `https://infinity.zhangyvjing.com` only |
| `PAPER_PROCESSOR_ID` | `paper-processor-zhangbot-v1` |
| `PAPER_PROCESSOR_INSTANCE_ID` | generated per boot/process/nonce by the runtime, or a verified unique value |
| `PAPER_PROCESSOR_WORK_ROOT` | the controlled user state directory under `.local/state` |
| `PYTHONPATH` | the active release directory |
| `PYTHONUNBUFFERED` | `1` |

The only Processor secret is `PAPER_PROCESSOR_TOKEN`. Store it in
`/home/zhangyvjing/.config/infinity-paper-processor/processor.env` with mode
`0600`; the file contains exactly the one key and no comments, URLs, or other
settings. Deliver it through a secure SSH stdin channel and never put it in a
command argument, shell history, service unit, process log, browser state, or
evidence. The Edge separately stores `PAPER_PROCESSOR_SHARED_SECRET`; its
value is the same bootstrap secret but is never read back into logs or files.

The Processor never receives D1/R2 parent credentials, Redis credentials,
Cloudflare account/API tokens, provider/model keys, or public Worker
credentials. Redis remains only a recreatable notification hint and contains
no paper bytes, extracted text, source URLs, object identifiers, tool payloads,
or secrets.

## 3. Service hardening and singleton protocol

Install and manage
`backend/paper_processor/infinity-paper-processor.service` as a user-level
systemd unit. Validate the unit with `systemd-analyze --user verify` before
starting it. The unit must retain `PrivateTmp=yes`, `NoNewPrivileges=yes`,
`ProtectSystem=strict`, `ProtectHome=read-only`, `PrivateDevices=yes`,
`UMask=0077`, bounded `MemoryMax=256M`, `TasksMax=32`, `LimitNOFILE=256`, and
the explicit address-family restriction. Its only write path is the controlled
temporary work directory. Do not add a socket, port, timer that creates a
second instance, or a second service name.

The D1 control plane remains authoritative for Processor sessions, attempts,
leases, and fencing epochs. There may be only one active instance for
`paper-processor-zhangbot-v1`. Every connect uses a new instance/session; a
restart cannot reuse stale capabilities. A stale attempt is expired or
cancelled and remains fenced before a replacement attempt is accepted.

Readiness means a successful Edge `connect` followed by bounded poll/renew
progress. There is no public Processor health endpoint. systemd restarts only
on process failure with the configured delay; startup recovery removes stale
temporary workspaces. Graceful shutdown stops polling, reports or cancels the
current fenced attempt, and removes temporary files.

## 4. Ordered installation and release procedure

Before each release, record the target account, Worker, D1 database, R2 bucket,
Edge version, reviewed commit, local artifact hashes, and current zhangbot
service state. Use read-only checks to confirm that no older Paper Processor
unit, process, listener, or unexpected release is active. Do not alter the
existing Redis, Redis Relay, or Cloudflared user services.

After the local tests, independent review, diff check, and secret scan pass:

1. Verify the selected commit and artifact hashes again on both the release
   checkout and the zhangbot transfer directory.
2. Apply D1 migrations `0017` through `0021` in order and read back each
   migration marker and required table/index. Stop if any step is ambiguous.
3. Set the non-secret Edge binding `PAPER_PROCESSOR_ID` to
   `paper-processor-zhangbot-v1`. Set the Edge secret
   `PAPER_PROCESSOR_SHARED_SECRET` through the Wrangler secret channel, and
   transfer the same token once to the mode-0600 Processor env file through
   SSH stdin. Never echo either value.
4. Copy the reviewed release into its commit-named directory, create the
   Python 3.10 virtualenv, install only the pinned lock file, write the
   sanitized installation record, validate the unit, and start the single
   user service. Confirm that Redis, Relay, and Cloudflared unit state is
   unchanged.
5. Deploy the Edge from the reviewed branch, verify the public readiness
   signal, then verify Processor connect and poll without exposing a public
   Processor route.
6. Run the authenticated end-to-end cases: supported-source search and PDF
   materialization, D1/R2/Processor processing, page-scoped text, image
   retrieval and analysis, durable tool-call history and refresh recovery,
   provider egress, cross-user isolation, invalid identifiers, stale leases,
   duplicate finalization, cancellation, malformed input, and restart
   recovery. Evidence must include read-only state checks and safe summaries,
   not just HTTP status or process liveness.

## 5. Logging, failure and rollback

Logs may contain only stage, safe error code, opaque resource/attempt IDs,
counts, sizes, and bounded timing. Redact tokens, headers, URLs, local paths,
stack traces, paper contents, raw manifests, and provider credentials. The
normal log and evidence scan must prove that no secret or full payload crossed
the boundary.

On any failed step, stop at that step and record whether an external write
occurred. Revoke Processor capabilities and active sessions first. Stop the
service, preserve D1/R2 metadata, and restore the prior reviewed release by
pointing the `current` symlink to its previous commit-named directory. Start
the old service only after read-only hash and unit verification. Do not delete
or hand-edit metadata to manufacture a pass. A Git revert is separate from a
Cloudflare rollback and does not authorize either one.
