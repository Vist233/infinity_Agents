# Infinity Agents Edge

Cloudflare Worker edge API for the StepFun Coding Plan. It is an OIDC relying
party for `https://auth.zhangyvjing.com` and proxies streaming responses without
exposing the upstream API key to clients.

## Endpoints

- `GET /health`
- `GET /login`, `GET /auth/callback`, `GET /logout`
- `GET /v1/models` (ZhangYvJing browser session required)
- `POST /v1/chat/completions` (ZhangYvJing browser session required)
- `POST /chat` (alias)

ImageJudge uses the same Worker under an isolated `/image-judge/*` namespace:

- `GET /image-judge/healthz`
- `GET /image-judge/desktop/authorize`
- `GET /image-judge/auth/callback`
- `POST /image-judge/desktop/token`
- `POST /image-judge/desktop/refresh`
- `POST /image-judge/desktop/logout`
- `POST /image-judge/api/v1/evaluate`

The deployed Worker needs three secrets:

- `STEPFUN_API_KEY`: StepFun Coding Plan key.
- `ZHANG_AUTH_CLIENT_SECRET`: confidential secret for client `infinity-agents`.
- `INFINITY_SESSION_SECRET`: independent HMAC secret for signed edge sessions.

The callback is fixed to `https://infinity.zhangyvjing.com/auth/callback`; the
Worker uses OIDC Authorization Code + PKCE and validates ID token signature,
issuer, audience, nonce, and expiry against provider discovery/JWKS.

ImageJudge has separate `IMAGE_JUDGE_DB`, `IMAGE_JUDGE_KV`,
`IMAGE_JUDGE_USER_LOCK`, and `IMAGE_JUDGE_*` secrets. Its Zhang Auth callback is
`https://infinity.zhangyvjing.com/image-judge/auth/callback`. The platform model
secret is intentionally unset while local BYOK validation is in progress; the
endpoint returns `PLATFORM_MODEL_NOT_CONFIGURED` instead of retrying.
