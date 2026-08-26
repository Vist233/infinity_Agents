# Dedicated Paper Processor — Cloudflare-managed delivery v1

This runbook implements the checked-in `paper-processor.delivery/v1` contract
at `backend/paper_processor/delivery.v1.json`. It is restricted to an
owner-approved Cloudflare-managed runtime. The repository currently does not
identify a concrete managed runtime profile or an approved image registry for
this dedicated service; therefore release remains blocked with
`CLOUDFLARE_MANAGED_RUNTIME_PROFILE_UNSPECIFIED` and
`PAPER_PROCESSOR_IMAGE_DIGEST_NOT_PROVIDED`. Do not infer a host, registry,
container service, or account from the repository.

## 1. Immutable artifact gate

- Build only from `backend/Dockerfile.paper-processor`.
- Record an owner-approved OCI reference in the release record using
  `PAPER_PROCESSOR_IMAGE_DIGEST` and the exact form
  `oci-image@sha256:<64-hex-digest>`.
- Floating tags, mutable image names, local-only images, and the existing
  public Claude-Code Worker image are not valid Processor artifacts.
- A missing approved runtime profile or digest is a blocker; do not substitute
  a public host or a guessed Cloudflare product.

## 2. Runtime and environment boundary

The managed runtime may receive only these non-secret names:

| Name | Boundary |
|---|---|
| `PAPER_PROCESSOR_EDGE_URL` | approved Edge HTTPS control-plane URL |
| `PAPER_PROCESSOR_ID` | server-issued Processor identity |
| `PAPER_PROCESSOR_INSTANCE_ID` | unique runtime instance identity |
| `PAPER_PROCESSOR_WORK_ROOT` | temporary local workspace root |
| `PYTHONPATH`, `PYTHONUNBUFFERED` | image/runtime settings |

The only Processor secret is `PAPER_PROCESSOR_TOKEN`, injected by the approved
platform secret mechanism. The Edge separately holds
`PAPER_PROCESSOR_SHARED_SECRET`. Neither side receives D1/R2 parent
credentials, Redis credentials, Cloudflare account/API tokens, or provider
keys. Secret values never appear in this file, image arguments, logs, browser
state, Redis, or evidence.

## 3. Lease, singleton and network assumptions

- Run one active instance for each server-issued `PAPER_PROCESSOR_ID`.
- `PAPER_PROCESSOR_INSTANCE_ID` must be unique; horizontal scaling requires a
  separately approved protocol change.
- D1 is the authority for the short-lived Processor session, resource lease,
  attempt, and fencing epoch. A restart reconnects and cannot reuse stale
  capabilities.
- The Processor calls only the fixed HTTPS Edge control API. It has no D1/R2
  SDK, Redis connection, public Worker credential, or broad object listing.
- After source download and validation, parsing runs without network access.

## 4. Health, restart and logs

Readiness requires a successful Edge `connect` and a live poll/renew loop. The
service does not expose a public health route. Liveness is process health plus
bounded poll progress. The managed runtime restarts a failed process with its
bounded backoff; startup recovery removes stale temporary workspaces and the
next session is fenced by D1. Graceful shutdown stops polling, reports or
cancels the current fenced attempt, and removes temporary files.

Logs are structured and safe: stage, safe error code, opaque IDs, counts and
sizes are allowed. Tokens, headers, source URLs, local paths, PDF/full-text or
image bytes, raw manifests, stack traces and provider credentials are never
logged. Failure details are returned only as bounded safe error codes/messages
through the Edge protocol.

## 5. Release and rollback procedure

Before any external operation, the owner must approve the exact Cloudflare
managed runtime profile, image digest, target environment, secret injection
channel, and maintenance window. Then:

1. Re-run local Edge, Processor, frontend, migration-replay, diff, and secret
   gates; capture the immutable image digest.
2. Provision only the named secret values through the platform secret channel.
3. Register one Processor identity and start one instance in the approved
   managed runtime; verify connect, claim, renew, fenced upload/finalize,
   cancellation and restart recovery.
4. On rollback, revoke Processor capabilities and active sessions first, pause
   the new runtime, and point it to the prior immutable image digest. Preserve
   D1 metadata and immutable R2 evidence; never hand-edit or delete state to
   manufacture a pass.

No step above authorizes a remote migration, R2 write, Processor registration,
deployment, Redis ACL change, or secret rotation by itself. Those operations
remain PAPER-10 actions and require separate explicit owner authorization.
