# PAPER-05 execution card

- Branch: `cloudflare-deploy`
- Baseline commit: `61adfab9d18e457b076ce8918afc9124124c3273`
- Card: PAPER-05 — Paper-resource schema, authorization, and object interface
- Objective: make a paper PDF/extraction a first-class authorized D1 metadata resource with a narrow server-side R2 object interface, ownership/link checks, and fenced processing metadata.
- Allowed changes: additive D1 migration, `src/db.ts`, paper-resource routes and route composition, fake-D1 support, focused D1/resource tests, and PAPER-05 evidence.
- Excluded: Processor implementation/control protocol, source download/admission, PDF parsing, PaperAgent tools, image analysis, deployment, remote D1/R2/Redis/Processor writes, and unrelated refactors.
- Pre-existing worktree state: PAPER-01 through PAPER-04 local product changes/evidence and the two user-provided design/plan documents are retained; unrelated edits will be avoided.
- External authorization: not granted; no external system mutation is permitted.

## Acceptance checklist

- [x] Add `paper_resources`, `paper_processing_attempts`, and `paper_resource_links` with bounded fields and allowed states.
- [x] Add ownership/link-aware repository functions and fenced state transition helpers.
- [x] Add authorized pending/ready metadata and manifest/object routes without returning R2 keys or parent credentials.
- [x] Cover owner access, ready manifest, link creation, cross-user/guessed IDs, stale attempt, invalid transition, traversal, deletion, and revoked-link negatives.
- [x] Run focused tests and mandatory Edge checks; no remote activation.
