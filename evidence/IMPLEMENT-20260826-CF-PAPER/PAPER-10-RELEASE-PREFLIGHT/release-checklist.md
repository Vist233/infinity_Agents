# PAPER-10 controlled release checklist (prepared, not executed)

This is the exact next release sequence derived from the current local
Wrangler 4.120.0 behavior and the read-only target state. Every command in
this file is a plan only; this preflight card did not execute a write command.

## 0. Immutable preconditions

Run from the clean local checkout and stop if any readback differs:

```text
git switch cloudflare-deploy
git status --short --branch
git rev-parse HEAD
git merge-base --is-ancestor ad0dd13e387026309399de6c161be72205e1e296 HEAD
git merge-base --is-ancestor e706d37c8fd8eb30f3ba56223289abe25ceac893 HEAD
git merge-base --is-ancestor 06529ffc62e0bfe980eda7594047e9e2add27c15 HEAD
cd cloudflare-worker
./node_modules/.bin/wrangler d1 migrations list infinity-agents-db --remote
./node_modules/.bin/wrangler deployments status --name infinity-agents-edge --json
./node_modules/.bin/wrangler versions view 1891abf4-9fcf-4f5a-bc8c-7e059ef285e7 --name infinity-agents-edge --json
./node_modules/.bin/wrangler versions secret list --name infinity-agents-edge
./node_modules/.bin/wrangler d1 info infinity-agents-db --json
./node_modules/.bin/wrangler r2 bucket info infinity-agents-resources
```

Also read back the exact WAF ruleset and the zhangbot service/hash/listener
probes without printing the WAF token or Processor token. The WAF expression
must remain exactly the four fixed method/path pairs, source IP
`39.105.204.121`, host `infinity.zhangyvjing.com`, action `skip`, and
`products=["bic"]` only.

## 1. Apply only the pending additive migration

Current readback says 0017–0021 are applied and 0022 is the only pending file.
After the owner permits leaving this preflight-only phase, run exactly:

```text
cd cloudflare-worker
./node_modules/.bin/wrangler d1 migrations apply infinity-agents-db --remote
```

Confirm the interactive prompt. Do not pass a different database, do not run a
SQL file manually, and do not rerun 0017–0021. The installed CLI help says the
apply command captures a backup and rolls back the migration on an error. Then
read back:

```text
./node_modules/.bin/wrangler d1 migrations list infinity-agents-db --remote
./node_modules/.bin/wrangler d1 execute infinity-agents-db --remote --json --command "SELECT name, type FROM sqlite_master WHERE name = 'paper_request_continuations'"
```

The required result is no pending migration and one
`paper_request_continuations` table, with the query metadata showing no write
outside the migration. If this readback fails, stop and preserve the migration
backup; do not deploy the candidate.

## 2. Build and upload a no-traffic Worker candidate

From the current local HEAD, run the local gates and build the frontend before
upload. Then create a version without changing production traffic:

```text
cd frontend
npm run build
cd ../cloudflare-worker
npm run check && npm test
./node_modules/.bin/wrangler versions upload --name infinity-agents-edge --keep-vars --strict --message "PAPER-10 FIX-01/02/03 durable Paper release"
```

Capture the returned candidate version ID. This is the versioned upload path,
not `wrangler deploy`. The installed CLI sends `bindings_inherit=strict` for
version upload. `--keep-vars` preserves vars managed outside the checked-in
config. Do not use legacy `wrangler secret put`.

The current production version already has
`PAPER_PROCESSOR_SHARED_SECRET` and all other existing secret bindings by
name. The normal code-only path therefore does not rotate or rewrite any
secret. Wrangler's local help further says secrets are never deleted by
deployment and `--secrets-file` is additive. If a separately approved secret
rotation becomes necessary, it must be a separate versioned operation supplied
only through a protected stdin channel:

```text
./node_modules/.bin/wrangler versions secret put <SECRET_NAME> --name infinity-agents-edge --message "PAPER-10 versioned secret change" <protected-stdin>
```

That command is not needed for this preflight and its secret input must never
be placed in a shell argument, repository file, log, or evidence. It creates a
new version; use that new version as the candidate after another binding
readback. Never use `wrangler secret put`.

## 3. Candidate metadata and binding gate

Immediately read back the candidate, replacing `<CANDIDATE>` locally without
recording an untrusted value in evidence:

```text
./node_modules/.bin/wrangler versions view <CANDIDATE> --name infinity-agents-edge --json
```

The candidate must have the FIX-01/02/03 bundle and the exact current resource
bindings. Compare by name/type and target ID, never by secret value:

- every current `secret_text` name remains present, including
  `PAPER_PROCESSOR_SHARED_SECRET`, `MODEL_API_KEY`, auth/session, Relay, and
  existing Worker credential names;
- `DB` remains D1 ID `9ee9ec94-cb42-40b5-8372-681c7b57c105`;
- `RESOURCE_BUCKET` remains R2 `infinity-agents-resources`;
- `ASSETS`, ImageJudge KV/DB/DO, rate limiter, and existing plain vars remain;
- `MODEL_BASE_URL` remains `https://api.moonshot.cn/v1` and `MODEL_ID` remains
  `kimi-k2.6`;
- `PAPER_PROCESSOR_ID` remains `paper-processor-zhangbot-v1` and
  `PAPER_PROCESSOR_SOURCE_IP` remains `39.105.204.121`;
- the candidate's Durable Object exports match the stable version before any
  percentage split.

If any binding is missing, changed, or has an unexpected type, do not deploy
the candidate. Preserve the stable 100% deployment and diagnose the candidate
upload; do not repair it by deleting or overwriting a secret.

## 4. Safe traffic sequence and rollback

The current stable rollback reference is
`1891abf4-9fcf-4f5a-bc8c-7e059ef285e7`. Wrangler accepts the following
percentage specs and its `--dry-run` behavior was verified in this card:

```text
./node_modules/.bin/wrangler versions deploy <CANDIDATE>@1% 1891abf4-9fcf-4f5a-bc8c-7e059ef285e7@99% --name infinity-agents-edge --yes --message "PAPER-10 FIX candidate canary"
./node_modules/.bin/wrangler deployments status --name infinity-agents-edge --json
curl -fsS --max-time 20 https://infinity.zhangyvjing.com/health
```

Do not call the release healthy from HTTP 200 alone. The Processor must remain
active/enabled, connect/poll through the exact fixed endpoints, and produce
real D1/R2 progress in the live acceptance below. If any canary or binding /
readiness check fails, immediately restore the stable version:

```text
./node_modules/.bin/wrangler versions deploy 1891abf4-9fcf-4f5a-bc8c-7e059ef285e7@100% --name infinity-agents-edge --yes --message "PAPER-10 rollback to verified stable version"
```

Keep additive migration 0022 and any immutable R2 metadata; do not manually
edit D1 state. If a later capability/Processor failure occurs, follow the
existing capability-first rollback, but do not change Redis/Relay/Cloudflared.
After all live checks pass, promote only the verified candidate:

```text
./node_modules/.bin/wrangler versions deploy <CANDIDATE>@100% --name infinity-agents-edge --yes --message "PAPER-10 FIX-01/02/03 production release"
```

Then read back deployment status, candidate binding metadata, WAF exact rule,
Processor active state, D1 migration state, and R2 metadata.

## 5. Required real authenticated browser acceptance

Use the existing authenticated Infinity Agents session after the candidate is
known to receive traffic. Use a supported open-access result returned by
`search_paper` (prefer an arXiv result such as the actual returned
`arxiv:1706.03762` reference; never type an arbitrary URL). Record only
opaque IDs, safe statuses, counts, and redacted errors.

1. Search for the supported paper and visibly confirm the returned canonical
   source reference is allowlisted.
2. Invoke materialization. Confirm the durable tool timeline contains the
   `materialize_paper` call/result and the Paper task surface shows
   `requested`, `downloading`, `extracting`, or `uploading`; a successful
   materialize invocation while processing must not display `ready`.
3. Refresh during processing and confirm the same correlated task/resource is
   rehydrated with bounded progress, without model prose being used as state.
4. Wait for the Processor's real D1/R2 completion. Confirm the progress model
   becomes `ready`, the D1 resource/attempt are terminally successful, and R2
   contains the source PDF plus validated text/image manifests. This must be
   verified by read-only metadata/manifest checks, not by HTTP 200 or process
   liveness.
5. Read a bounded page-text range through `read_paper`; confirm the visible
   result is sourced from the ready resource. Read the image manifest and view
   one authorized image through the image route; run one authorized image
   analysis and verify the safe provider-egress audit/result. No R2 key or
   parent credential may reach the browser.
6. Refresh after ready and confirm the durable tool timeline, progress status,
   counts, and ready-only resume/read action remain present. Click resume once
   and confirm the existing continuation endpoint produces a real subsequent
   read/image tool event; a duplicate click must not create a second run.
7. Perform a non-owner negative test with a separate authenticated owner
   session. Attempts to read progress, page text, image data, or continuation
   for the first user's opaque resource must receive the contract's uniform
   denied/not-found boundary, create no cross-user event/object access, and
   reveal no title, text, image bytes, source URL, or R2 key.
8. Read back the fixed WAF rule, D1 continuation/resource/attempt records, R2
   manifest metadata, Processor safe logs, and provider-egress audit after
   the flow. Then run the full local Edge/Processor/frontend gates, diff check,
   and secret scan before declaring the release accepted.

The browser acceptance is not complete if any item is replaced by assistant
prose, a mock, a local fixture, an unauthenticated request, an HTTP 200, or a
live process check.
