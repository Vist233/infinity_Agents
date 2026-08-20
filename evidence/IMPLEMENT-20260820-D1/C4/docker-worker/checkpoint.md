# C4 Checkpoint

## Status

**Complete for the local D1/Relay HTTPS Worker candidate.** The only
Cloudflare-shaped Worker Compose path now starts `consumer_v2`; the container
uses D1/R2 through `/api/worker/v2/*`, uses Redis only through fixed Relay hints,
runs the single Goal-Driven Claude Code runtime, uploads a final Artifact, and
cleans its attempt directory.

## Verified

- D1 Edge typecheck and 53 Edge tests pass.
- Python suite passes with 328 passed and 45 skipped.
- The Worker image builds and excludes PostgreSQL, Redis client, Docker, old
  Worker entrypoints, and verifier code.
- Windows onboarding and env templates no longer ask for PostgreSQL, raw Redis,
  Namespace, Pool, or temporary credentials.
- No remote state was changed.

## Remaining gate

C5 must use real D1, R2, zhangbot Redis Relay, local Docker, and real Claude Code
to execute Case 2 and Case 3, download and hash the final Artifacts, prove
post-task cleanup and continued readiness, then revisit historical PostgreSQL
files before deletion. Remote operations remain blocked until explicitly
authorized.
