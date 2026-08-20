# C7 checkpoint

Status: `RELEASE_CANDIDATE_PASS_DEPLOY_PENDING`

The local release candidate and final read-only review passed. Case 2 remains traceable
with its real Task/Attempt/Artifact IDs and SHA-256. Case 3 remains
`DEFERRED_BY_OWNER` and is the sole explicitly accepted scientific-coverage gap.

Remote preflight is healthy, but C7 is not closed by this file yet. Closure requires:

1. add `AUTH_SESSION_ENCRYPTION_KEY` without exposing its value;
2. apply remote D1 migration 0015;
3. push the release candidate to `origin/cloudflare-deploy`;
4. deploy the same candidate to Cloudflare and publish the Worker image;
5. record the new Edge version, image digest, rollback commit and online regression;
6. leave the branch clean before starting C8 on `main`.
