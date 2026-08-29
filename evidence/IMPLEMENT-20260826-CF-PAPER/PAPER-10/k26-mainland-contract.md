# PAPER-10 Kimi K2.6 mainland API contract correction

Date: 2026-08-29
Status: local contract correction complete; live provider acceptance is still required.

## Finding

The checked-in Edge configuration used the international Kimi endpoint
`https://api.moonshot.ai/v1`. The official mainland Kimi documentation defines
the service address as `https://api.moonshot.cn`, the OpenAI-compatible base URL
as `https://api.moonshot.cn/v1`, and the chat endpoint as `POST
/v1/chat/completions`. It defines authentication as `Authorization: Bearer
$MOONSHOT_API_KEY`; the key value was not read or recorded.

The official Kimi K2.6 mainland quickstart defines model ID `kimi-k2.6`, text,
image, and video input, and an OpenAI-compatible message containing a base64
`image_url`. URL images are not the supported input form; the bounded Paper
image path already sends base64 data URLs. Sources:

- https://platform.kimi.com/docs/api/overview
- https://platform.kimi.com/docs/guide/kimi-k2-6-quickstart

## TDD and implementation

- The first red regression run changed the provider-contract tests to require
  the mainland `.cn` endpoint and failed because `wrangler.jsonc` still had
  the `.ai` endpoint (exit `1`).
- `cloudflare-worker/wrangler.jsonc` now sets
  `MODEL_BASE_URL` to `https://api.moonshot.cn/v1`; `MODEL_ID` remains
  `kimi-k2.6`.
- The model-provider test pins the deployed configuration and replacement URL
  normalization. The chat test asserts exact `POST
  https://api.moonshot.cn/v1/chat/completions`, Bearer auth, model ID, and
  streaming. The Paper image test asserts the same endpoint/auth contract and
  a base64 `image_url` message.
- Existing Processor lockfile/manifest changes were retained. The delivery
  test now verifies the locked multiline hashes and `pip --require-hashes`;
  no unrelated source was discarded.

## Local gate results

- Focused Edge provider/chat/image tests: exit `0`, 3 files / 26 tests.
- Edge TypeScript check: exit `0` after the test-only Node typing fix.
- Full Edge suite: exit `0`, 24 files / 134 tests.
- Processor pytest under `pyenv shell Agent`: exit `0`, 12 tests.
- Frontend typecheck: exit `0`; lint: exit `0`; unit: exit `0`, 12 files /
  50 tests.
- Frontend E2E: first sandbox-only server bind attempt exit `1` (`EPERM` on
  `127.0.0.1:3000`); the permitted elevated local-server retry exit `0`, 13
  tests passed.
- `git diff --check`: exit `0`.

## Read-only production preflight after the correction

- Initial sandbox-only Wrangler/HTTPS reads failed on local DNS/log-directory
  restrictions; no remote write occurred. The permitted read-only retry then
  returned exit `0` for account, deployment, secret-name, D1 migration, and
  R2 queries. The secret query returned names only.
- Account ID was read-only confirmed as
  `3cfba3bb2ec69798aa4881b05d80810f`; target Worker is
  `infinity-agents-edge`; D1 reported no migrations to apply; target R2 bucket
  is `infinity-agents-resources`.
- Current deployment readback was deployment
  `88868d8f-d8b0-45fe-8d6d-b18e4172f7a7`, 100% version
  `93983647-e6f6-4497-a128-2dfd478d15f5`; no secret value was read.
- The first health path probe used the wrong path `/healthz` and returned HTTP
  `404` (curl exit `6` in the sandbox). The source defines `/health`; the
  corrected read-only probe returned HTTP `200`, curl exit `0`, with D1 and R2
  configured and Paper Processor unconfigured.
- No D1 migration, R2 write, WAF change, Edge Secret change, zhangbot change,
  Redis/Relay/Cloudflared change, browser action, or deployment write occurred
  during this local correction/preflight.

## Next controlled action

Create the local review commit, then deploy this exact `.cn` configuration
through the already-authorized Cloudflare path and run one harmless authenticated
text probe. If the real provider still returns `401 Invalid Authentication`,
record the remaining upstream Kimi credential/account-entitlement blocker; do
not switch to StepFun. Do not claim Paper Workspace completion from this local
contract correction.
