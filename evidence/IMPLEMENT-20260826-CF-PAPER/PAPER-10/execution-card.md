# PAPER-10 execution card

- Branch: `cloudflare-deploy`
- Card: PAPER-10 — external release, deployment and live acceptance
- Baseline commit: `61adfab9d18e457b076ce8918afc9124124c3273`
- Local scope completed: release preflight, prior-card evidence continuity, local Worker checks, migration replay evidence, diff hygiene, and secret-scan review.
- External scope not executed: remote D1 migration, production R2/Processor configuration, Processor registration, deployment, remote task creation, and authenticated live browser/integration acceptance.

## Required release acceptance

- [ ] Apply additive migrations `0017` through `0021` to the authorized target D1 database and verify schema/query behavior remotely.
- [ ] Configure the authorized R2 binding and dedicated Paper Processor through the existing C7-safe deployment path, without exposing parent credentials.
- [ ] Register/start the dedicated Paper Processor and verify lease, fencing, retry, cancellation, object publication, and recovery against real D1/R2.
- [ ] Deploy the reviewed `cloudflare-deploy` Worker and Processor artifacts after immutable artifact/hash capture.
- [ ] Run the authorized live browser/integration acceptance for chat replay, PDF admission/download/parse/page read, image delivery/analysis, deletion/revocation, and cleanup.
- [ ] Capture deployment identifiers, migration results, live test exit codes, safe health/readiness output, rollback reference, and post-release secret scan.

## Approval boundary

This card is blocked until the owner explicitly authorizes the specific external writes and live validation above, and provides the authorized target/account/environment through the existing secure Cloudflare/Processor channels. No credentials or target identifiers are inferred from the repository.
