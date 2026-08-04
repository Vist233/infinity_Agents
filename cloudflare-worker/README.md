# Infinity Agents Edge

Cloudflare Worker edge for the PaperAgent web application and the isolated
ImageJudge API. It is an OIDC relying party for `https://auth.zhangyvjing.com`,
keeps browser sessions in the Infinity D1 database, and proxies model/tool
calls without exposing upstream API keys to clients.

## Endpoints

- `GET /health`
- `GET /auth/login`
- `GET /auth/callback`
- `POST /auth/logout`
- `GET /api/me` (authenticated)
- `GET /api/sessions` (authenticated)
- `POST /api/sessions` (authenticated)
- `GET /api/sessions/:id/messages` (authenticated)
- `PATCH /api/sessions/:id/title` (authenticated)
- `DELETE /api/sessions/:id` (authenticated)
- `POST /api/chat` (authenticated SSE stream)

ImageJudge uses the same Worker under an isolated `/image-judge/*` namespace:

- `GET /image-judge/healthz`
- `GET /image-judge/desktop/authorize`
- `GET /image-judge/auth/callback`
- `POST /image-judge/desktop/token`
- `POST /image-judge/desktop/refresh`
- `POST /image-judge/desktop/logout`
- `POST /image-judge/api/v1/evaluate`

The deployed Worker needs these PaperAgent secrets:

- `STEPFUN_API_KEY`: StepFun Coding Plan key.
- `ZHANG_AUTH_CLIENT_SECRET`: confidential secret for client `infinity-agents`.

The callback is fixed to `https://infinity.zhangyvjing.com/auth/callback`. The
Worker stores the provider access/refresh tokens server-side and validates the
access token against the configured Zhang Auth JWKS before every protected API
request. Browser cookies contain only an opaque session identifier.

ImageJudge has separate `IMAGE_JUDGE_DB`, `IMAGE_JUDGE_KV`,
`IMAGE_JUDGE_USER_LOCK`, migrations, and `IMAGE_JUDGE_*` secrets. Its Zhang Auth
callback is `https://infinity.zhangyvjing.com/image-judge/auth/callback`. The
platform model secret is intentionally unset while local BYOK validation is in
progress; the endpoint returns `PLATFORM_MODEL_NOT_CONFIGURED` instead of
retrying.
