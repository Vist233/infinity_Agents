# Status-only Windows Processor inspection — 2026-09-13

Status: PASS for the offline container-health check only. This is not a
Cloudflare/D1/R2 availability check and does not reopen the blocked live gate.

## Host and container state

The read-only SSH target reported host `EAPS6CGH-LT`. Docker listed the two
Workers and the isolated Discovery Processor as running:

| container | image tag | state | restart count |
| --- | --- | --- | ---: |
| `infinity-discovery-processor-discovery-processor-1` | `infinity-agents-discovery-processor:2026.09.11-r1` | `running` | 0 |
| `infinityagentsworkers-worker-1-1` | `infinity-agents-worker:2026.09.12-r3` | `running` | 0 |
| `infinityagentsworkers-worker-2-1` | `infinity-agents-worker:2026.09.12-r3` | `running` | 0 |

The local image metadata matched the pinned platform and digest records:

- Discovery Processor: `amd64/linux`, image ID
  `sha256:2bb2a1c1171e28e646006d185a2fc9bab3fb190b3aa1b0778e04194087147496`.
- Worker r3: `amd64/linux`, image ID
  `sha256:1ac359bfc2a9336d9ee82dbe37b0115b666e6ebd5f9f8ac28674a52c4c2e5227`.

No raw logs, container environment, credentials, or response bodies were
read. `RestartCount=0` for all three containers is the bounded evidence that
there is no current restart loop.

## Image-source and network architecture reconciliation

The Windows Worker Compose definition resolves both services to the local
`infinity-agents-worker:2026.09.12-r3` tag. The independent Processor Compose
project resolves to the local
`infinity-agents-discovery-processor:2026.09.11-r1` tag. Both committed Compose
definitions use `pull_policy: never`; the status-only `config --images`
checks returned only these local tags. No Docker Hub pull or registry login
was attempted during this inspection.

The Processor remains a separate Compose project and runs only
`backend.discovery.processor`. The repository architecture documents that it
uses the fixed `/api/discovery-processor/*` HTTPS control protocol and does
not connect directly to Cloudflare D1, R2, or Redis. Durable progress and
artifacts therefore remain Edge/D1/R2 responsibilities; the Windows check
only confirms the isolated runtime is alive and pinned.

## Git verification

The read-only remote branch listing taken during the container inspection
returned `1d190c9ecdeac17df7481a63e3a3385324ac6e52` for
`refs/heads/cf-deploy`, which was the then-current commit
`1d190c9` (`fix: contain auth and discovery write outages`). A subsequent
read-only verification for this final record resolves the remote branch to
`5a34f729dd040717b66934b7940b438227d3ecf6`, the documentation commit that
contains this evidence.

No Cloudflare contact, D1/R2 operation, feature-flag change, secret access,
live Task creation, or destructive action was performed.
