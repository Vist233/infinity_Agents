# Offline auth and Discovery resilience hardening — 2026-09-13

Status: OFFLINE VERIFIED ONLY. The production Claude/Artifact gate remains
BLOCKED by the observed D1 write-side availability failure; this record does
not claim a live pass or a new deployment.

## Scoped changes

- Browser session resolution treats role projection as a best-effort,
  throttled product projection. A verified JWT session is not converted into a
  generic 500 when the `user_access_roles` write fails.
- Invalid-token cleanup and refresh-session claim/release/rotation writes are
  bounded at the auth boundary. Revocation or migration failure cannot escape
  as an unhandled browser request error; legacy token migration is also
  throttled per session while its D1 update is unavailable.
- The deterministic Paper document-evidence gate is enforced before profile
  object/catalog persistence and again at the task and match read/materialize
  boundaries. Non-scientific/review papers cannot become matching-eligible.
- Dataset profile saving re-reads the immutable R2 source and streams a
  bounded SHA-256/size check before writing the profile object or ready row.
  Collection deletion remains guarded by the immutable task-resource graph for
  queued, claimed, and running tasks; multipart request bodies remain bounded
  before `formData()` buffering.

## Verification

- `npm run check`: passed.
- Full offline Edge suite: 32 files / 199 tests passed.
- Python artifact/security regression suite under `pyenv shell Agent`:
  34 tests passed.
- New deterministic coverage includes `/api/me` during role-write outage,
  invalid-token revocation-write failure, throttled legacy migration, paper
  evidence rejection, dataset source checksum/size mismatch, all live task
  states blocking collection deletion, and filtered review-paper matches.

No Cloudflare/D1 write, feature-flag change, secret access, live Task creation,
or destructive cleanup was performed for this offline follow-on.
