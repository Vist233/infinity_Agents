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

The deployed Worker needs three secrets:

- `STEPFUN_API_KEY`: StepFun Coding Plan key.
- `ZHANG_AUTH_CLIENT_SECRET`: confidential secret for client `infinity-agents`.
- `INFINITY_SESSION_SECRET`: independent HMAC secret for signed edge sessions.

The callback is fixed to `https://infinity.zhangyvjing.com/auth/callback`; the
Worker uses OIDC Authorization Code + PKCE and validates ID token signature,
issuer, audience, nonce, and expiry against provider discovery/JWKS.
