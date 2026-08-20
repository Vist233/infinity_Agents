# C7 final release review execution card

## Scope

Final hardening and release gate for the single `cloudflare-deploy` production path:

`Browser -> Cloudflare Edge -> D1/R2 -> named Redis Relay -> Docker Worker -> Goal-Driven Claude Code -> R2 Artifact`.

The card does not rerun Case 3. The owner explicitly deferred Case 3; its status remains
`DEFERRED_BY_OWNER`, not PASS.

## Changes reviewed

- Fenced and recoverable Task cancellation, Attempt completion and Artifact finalize.
- Stable Artifact identity, stale finalize ownership, partial-state repair and R2 retry.
- Interruptible Artifact collection and upload without blocking lease renewal.
- OAuth access/refresh token encryption and single-owner refresh rotation.
- Recoverable and owner-fenced D1 Outbox publishing.
- Browser-side direct Artifact downloads and responsive Task detail controls.
- CI branch coverage, committed-secret patterns and resilient Worker image build.
- One Docker runtime only; no Docker-in-Docker, verifier, SQL driver or Redis client.

## Invariants

- D1 is the sole Task/Attempt/Worker/Event/Artifact metadata truth source.
- R2 stores immutable input and Artifact bytes.
- Redis carries only opaque hints and is never a Task truth source.
- Browser users are filtered by `created_by`; public Workers may claim across users.
- Worker v1 is disabled with 410 and has no caller.
- Navigation contains Analysis, Task Center and ImageJudge only; no Chat Agent.
