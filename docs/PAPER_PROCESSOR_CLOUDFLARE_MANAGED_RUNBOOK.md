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

## 0. Edge service-to-service access contract

The zhangbot egress preflight on 2026-08-28 returned the same public IPv4
`39.105.204.121` from three independent read-only providers. This address is a
non-secret deployment input and must be rechecked before every release; a
changed address is a blocker, not a reason to widen the rule.

The zone-level Cloudflare custom-rule exception is a `skip` action with only
`products: ["bic"]` (Browser Integrity Check). It must match the fixed host,
the exact source IP, and only these four fixed method/path pairs:

```text
(ip.src eq 39.105.204.121 and http.host eq "infinity.zhangyvjing.com" and (
  (http.request.method eq "POST" and http.request.uri.path in {
    "/api/paper-processor/connect"
    "/api/paper-processor/poll"
    "/api/paper-processor/control"
  }) or
  (http.request.method eq "PUT" and
   http.request.uri.path eq "/api/paper-processor/object")
))
```

All attempt, resource, and object identifiers are in a validated JSON control
envelope. Binary object uploads use the fixed `/object` path with a bounded
JSON `x-paper-processor-envelope` header and checksum header. The Worker maps
the envelope operation and object kind to server-derived D1/R2 records; the
client cannot choose a URL path or R2 key. No dynamic identifier appears in a
Processor URL, so this rule is expressible on the current Free plan using only
exact path equality and a finite path set.

The only allowed control operations are `input`, `input_source`, `renew`,
`stage`, `finalize`, `cancel`, and `fail`. The only allowed object operation is
`upload`, and its kinds are `source_pdf`, `text_pages`, `text_manifest`,
`image`, and `image_manifest`. The Worker rejects unknown operations, extra
envelope fields, caller-selected object keys, and identifiers that do not
match the authenticated D1 session, attempt, resource, lease, and fencing
state.

Keep matching requests logged. Do not skip `securityLevel`, `uaBlock`,
`zoneLockdown`, `waf`, any WAF phase, Bot Fight Mode, or the remaining custom
rules. Do not use an IP Access `Allow`, whole-host bypass, browser User-Agent
impersonation, or a rule covering non-Processor paths. The Worker independently
requires `PAPER_PROCESSOR_SOURCE_IP` and the Cloudflare-injected
`CF-Connecting-IP` to match before checking `PAPER_PROCESSOR_ID`, the shared
bootstrap secret, session, nonce, lease, and fencing state. Non-zhangbot source
IPs and unlisted routes are rejected before authentication. Missing/wrong
source or route returns `PAPER_PROCESSOR_SOURCE_FORBIDDEN`; missing/wrong
bootstrap credentials still return `PAPER_PROCESSOR_UNAUTHENTICATED`.

The current Wrangler session has `zone(read)` but no Rulesets/WAF management
permission, so creating or reading this rule requires a separately authorized
Cloudflare security-rule capability. A 403/1010 response, a changed egress IP,
or a control plane that cannot read back this exact expression and `bic`-only
scope is a blocker. Never replace it with a broad exception.

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
`ProtectSystem=strict`, `ProtectHome=read-only`, `UMask=0077`,
`LockPersonality=yes`, `RestrictSUIDSGID=yes`, `RestrictRealtime=yes`, the
explicit address-family restriction, bounded `MemoryMax=768M`, `TasksMax=32`,
and `LimitNOFILE=256`. Its only write path is the controlled temporary work
directory. On the owner-approved unprivileged `zhangbot` user manager,
`PrivateDevices` and `ProtectKernelTunables`/`ProtectKernelModules`/
`ProtectControlGroups` are intentionally not enabled: disposable probes on
the host reject those controls with systemd status `218/CAPABILITIES` and the
service cannot spawn when they are present. This is a recorded host-runtime
constraint, not a relaxation of the network, filesystem, privilege, resource,
or singleton boundaries. Do not add a socket, port, timer that creates a
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

### 3.1 Bounded attempt execution and memory pressure

The Processor must not leave a claimed resource in an unobserved processing
loop. The service unit supplies these non-secret runtime limits:

| Limit | Value | Enforcement |
|---|---:|---|
| whole attempt | 240 seconds | Unix wall-clock alarm plus cooperative checkpoints |
| source download | 90 seconds | monotonic stage deadline and 30-second HTTP request timeout |
| PDF extraction | 120 seconds | monotonic stage deadline, page/image checkpoints, and wall-clock alarm |
| result upload/finalize | 150 seconds | monotonic stage deadline and per-request timeout; the 240-second whole-attempt cap still applies |
| lease heartbeat | every 30 seconds | background `renew` using the same fenced grant |
| Processor RSS budget | 512 MiB | `/proc`/runtime RSS guard before and during extraction |
| cgroup soft/hard cap | 512 MiB / 768 MiB | `MemoryHigh` / `MemoryMax` in systemd |

The application checks the attempt and stage deadline before and after each
network operation and at each PDF page/image boundary. A synchronous parser
that does not return is interrupted by the attempt alarm on the approved
Linux runtime. A memory-budget breach or `MemoryError` is mapped to the safe
`PAPER_PROCESSOR_MEMORY_LIMIT` code. A deadline breach is mapped to
`PAPER_PROCESSOR_TIMEOUT` or its stage-specific code. A failed heartbeat is
mapped to `PAPER_PROCESSOR_HEARTBEAT_FAILED`. Each of these paths calls the
existing fenced Edge `fail` operation, so D1 records a terminal failed
attempt/resource rather than relying on process liveness; the normal retry
flow can create a new attempt without reusing a stale lease.

The runner emits only safe operational events (`grant`, `succeeded`,
`failed`, `cancelled`, and `poll_empty`) with opaque resource/attempt IDs,
stage, and bounded error codes. It never logs PDF bytes, extracted text,
headers, tokens, source URLs, local paths, or exception tracebacks. An
unexpected transport/runtime error remains a safe cancellation path; if the
Edge is unreachable, the normal lease/fencing recovery rules apply and the
service reconnects rather than claiming success.

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
5. Read back the service's non-secret bounded limits, `MemoryHigh`/`MemoryMax`,
   `Restart=on-failure`, `KillMode=control-group`, and the single active
   instance before accepting a Paper grant. During a live attempt, verify a
   safe stage event, at least one heartbeat before the lease window, and a
   terminal success or safe failure; process liveness alone is not evidence.
6. Deploy the Edge from the reviewed branch, verify the public readiness
   signal, then verify Processor connect and poll without exposing a public
   Processor route.
7. Run the authenticated end-to-end cases: supported-source search and PDF
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
