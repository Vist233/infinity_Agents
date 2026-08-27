# PAPER-10 execution card

- Branch: `cloudflare-deploy`
- Card: PAPER-10 — external release, deployment and live acceptance
- Baseline commit: `61adfab9d18e457b076ce8918afc9124124c3273`
- Local scope completed: release preflight, prior-card evidence continuity, local Worker checks, migration replay evidence, diff hygiene, and secret-scan review.
- External scope not executed: preflight stopped before remote D1 migration, production R2/Processor configuration, Processor registration, deployment, remote task creation, or authenticated live browser/integration acceptance because the approved Processor runtime and immutable image identity were not available.

## Required release acceptance

- [ ] Apply additive migrations `0017` through `0021` to the authorized target D1 database and verify schema/query behavior remotely.
- [ ] Configure the authorized R2 binding and dedicated Paper Processor through the existing C7-safe deployment path, without exposing parent credentials.
- [ ] Register/start the dedicated Paper Processor and verify lease, fencing, retry, cancellation, object publication, and recovery against real D1/R2.
- [ ] Deploy the reviewed `cloudflare-deploy` Worker and Processor artifacts after immutable artifact/hash capture.
- [ ] Run the authorized live browser/integration acceptance for chat replay, PDF admission/download/parse/page read, image delivery/analysis, deletion/revocation, and cleanup.
- [ ] Capture deployment identifiers, migration results, live test exit codes, safe health/readiness output, rollback reference, and post-release secret scan.

## Preflight blocker

Owner authorization for the external writes and live validation has now been provided, but the release remains blocked until the owner provides the exact approved Cloudflare-managed Processor runtime profile, registry and immutable OCI image digest, Processor identity/token handoff, and Edge shared-secret injection channel. No credentials or target identifiers were inferred from the repository. No external write was attempted.
