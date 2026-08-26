# PAPER-06 execution card

- Branch: `cloudflare-deploy`
- Baseline commit: `61adfab9d18e457b076ce8918afc9124124c3273`
- Card: PAPER-06 — Dedicated Paper Processor control protocol
- Objective: provide a fixed, independently authenticated Edge control plane for one trusted Paper Processor to connect, claim exactly one resource, renew a fenced lease, retrieve only that resource's input, upload fixed-kind objects, finalize once, and cancel safely.
- Allowed changes: additive processor-session migration/repository helpers, fixed Edge processor routes, narrow fixed-kind R2 put/get abstraction, dedicated processor client/image scaffold, fake-D1/R2 support, focused tests, and PAPER-06 evidence.
- Excluded: public Worker-v2 changes, PDF download/admission, parsing/OCR/image extraction behavior, Agent tool exposure, deployment, processor registration in production, remote D1/R2/Redis writes, and unrelated refactors.
- Pre-existing worktree state: PAPER-01 through PAPER-05 local product changes/evidence and the user-provided design/plan documents are retained; unrelated edits will be avoided.
- External authorization: not granted; no external system mutation is permitted.

## Acceptance checklist

- [x] Dedicated Processor identity/session is distinct from public Worker credentials and stores hashes only.
- [x] Poll/claim returns at most one queued resource with an attempt lease and fencing epoch.
- [x] Renew, fixed input, fixed-kind upload, stage, finalize, and cancel enforce resource/attempt/session/token ownership.
- [x] Duplicate/stale/cancelled/swap/broad-list/public-Worker negative cases are covered.
- [x] Dedicated processor image/client has no D1/R2/Redis parent credential or public Claude Worker dependency.
- [x] Focused tests, mandatory Edge checks, and protocol evidence pass without remote activation.
