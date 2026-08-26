# PAPER-09 execution card

- Branch: `cloudflare-deploy`
- Card: PAPER-09 — private image delivery, provider egress, observability, cancellation and cleanup
- Baseline commit: `61adfab9d18e457b076ce8918afc9124124c3273`
- Scope: same-origin owned image delivery, manifest/object bounds, policy-gated provider analysis, safe audit/health events, resource cancellation/deletion and retry-safe R2 cleanup.
- Out of scope: remote migration, Processor registration, production deployment, and live authenticated release validation (PAPER-10).

## Acceptance

- [x] Owner-only image delivery validates session, resource ownership, ready state, manifest image ID, fixed R2 namespace, byte cap, and private/no-store response headers.
- [x] Cross-user, guessed-image, revoked/deleted, and giant-image access are rejected without exposing object keys or bytes in SSE/tool output.
- [x] Image analysis requires the explicit egress feature policy, reads one manifest-authorized image from R2, enforces an 8 MiB cap and bounded provider response, and returns bounded provenance only.
- [x] Provider success, denial, transport/provider failure, upload/extraction failure, cancellation, deletion, and cleanup outcomes emit structured safe audit records with no raw payloads or credentials.
- [x] `/health` reports only safe binding readiness flags; it does not expose secret values or internal credentials.
- [x] Cancellation revokes active attempts; deletion revokes the resource/attempts and schedules one idempotent cleanup job; stale and transient cleanup states are reclaimable/retry-safe.
- [x] Positive and negative regressions cover owner image access, cross-user/guessed ID, size cap, egress policy, provider success, deletion during processing, cancellation, cleanup retry, and stale-job recovery.
- [x] No deployment, remote D1 migration, remote R2 write, Processor registration, Redis ACL change, secret rotation, or Cloudflare configuration change was performed.
