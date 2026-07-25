import type { Env } from "./env";
import { SESSION_COOKIE, OAUTH_STATE_COOKIE, AUTH_CALLBACK_PATH } from "./env";
import { clearCookie, errorJson, json, nowSeconds, parseCookies, serializeCookie } from "./http";
import { getAuthSession, insertAuthSession, revokeAuthSession, updateAuthSessionTokens } from "./db";
import { verifyAccessToken } from "./jwt";

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30d, matches refresh token TTL
const STATE_TTL_SECONDS = 60 * 10;

export interface AuthedUser {
  userId: string;
  email: string | null;
  sid: string;
}

function randomToken(bytes = 32): string {
  const arr = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...arr)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function callbackUrl(env: Env): string {
  return `${env.APP_BASE_URL.replace(/\/$/, "")}${AUTH_CALLBACK_PATH}`;
}

/** GET /auth/login — start the authorization-code flow. */
export function handleLogin(request: Request, env: Env): Response {
  const url = new URL(request.url);
  const returnTo = url.searchParams.get("return_to") ?? "/";
  const state = randomToken(24);
  // Pack the intended post-login location into the state cookie value.
  const statePayload = JSON.stringify({ state, returnTo });

  const authorizeUrl = new URL(`${env.ZHANG_AUTH_BASE_URL.replace(/\/$/, "")}/authorize`);
  authorizeUrl.searchParams.set("client_id", env.ZHANG_AUTH_CLIENT_ID);
  authorizeUrl.searchParams.set("redirect_uri", callbackUrl(env));
  authorizeUrl.searchParams.set("state", state);

  const headers = new Headers({ location: authorizeUrl.toString() });
  headers.append(
    "set-cookie",
    serializeCookie(OAUTH_STATE_COOKIE, statePayload, { maxAge: STATE_TTL_SECONDS, sameSite: "Lax" })
  );
  return new Response(null, { status: 302, headers });
}

/** GET /auth/callback?code=...&state=... — exchange the code for tokens server-side. */
export async function handleCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookies = parseCookies(request);

  if (url.searchParams.get("error")) {
    return errorJson(`Authorization failed: ${url.searchParams.get("error")}`, 400, "OAUTH_ERROR");
  }
  if (!code || !state) {
    return errorJson("Missing code or state", 400, "MISSING_PARAMS");
  }

  let expectedState = "";
  let returnTo = "/";
  try {
    const parsed = JSON.parse(cookies[OAUTH_STATE_COOKIE] ?? "{}") as { state?: string; returnTo?: string };
    expectedState = parsed.state ?? "";
    returnTo = parsed.returnTo ?? "/";
  } catch {
    // ignore
  }
  if (!expectedState || expectedState !== state) {
    return errorJson("Invalid state", 400, "INVALID_STATE");
  }

  const tokenRes = await fetch(`${env.ZHANG_AUTH_BASE_URL.replace(/\/$/, "")}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      client_id: env.ZHANG_AUTH_CLIENT_ID,
      client_secret: env.ZHANG_AUTH_CLIENT_SECRET,
      redirect_uri: callbackUrl(env)
    })
  });
  const tokenPayload = (await tokenRes.json()) as {
    ok?: boolean;
    data?: { accessToken: string; refreshToken: string; expiresIn: number; user: { id: string; email: string } };
    error?: { message?: string };
  };
  if (!tokenRes.ok || !tokenPayload.ok || !tokenPayload.data) {
    return errorJson(tokenPayload.error?.message ?? "Token exchange failed", 401, "TOKEN_EXCHANGE_FAILED");
  }

  const { accessToken, refreshToken, user } = tokenPayload.data;
  // Verify the just-issued token before trusting its claims.
  const payload = await verifyAccessToken(accessToken, env);

  const sid = randomToken(32);
  const ts = nowSeconds();
  await insertAuthSession(env, {
    sid,
    user_id: payload.sub || user.id,
    email: payload.email ?? user.email ?? null,
    access_token: accessToken,
    access_expires_at: payload.exp,
    refresh_token: refreshToken,
    created_at: ts,
    last_used_at: ts
  });

  const safeReturn = returnTo.startsWith("/") ? returnTo : "/";
  const headers = new Headers({ location: `${env.APP_BASE_URL.replace(/\/$/, "")}${safeReturn}` });
  headers.append(
    "set-cookie",
    serializeCookie(SESSION_COOKIE, sid, { maxAge: SESSION_TTL_SECONDS, sameSite: "Lax" })
  );
  headers.append("set-cookie", clearCookie(OAUTH_STATE_COOKIE));
  return new Response(null, { status: 302, headers });
}

/**
 * Resolve the authenticated user for a request. Two-layer check:
 *  1) valid site session cookie mapped to a stored session
 *  2) the stored access token verifies against JWKS (refreshing + rotating if expired)
 * Returns the user plus any Set-Cookie header to apply on the response.
 */
export async function resolveUser(
  request: Request,
  env: Env
): Promise<{ user: AuthedUser; setCookie?: string } | null> {
  const cookies = parseCookies(request);
  const sid = cookies[SESSION_COOKIE];
  if (!sid) return null;

  const session = await getAuthSession(env, sid);
  if (!session) return null;

  // Refresh proactively if the access token is expired or about to expire.
  if (session.access_expires_at - nowSeconds() <= 30) {
    const refreshed = await refreshSession(env, session.sid, session.refresh_token);
    if (!refreshed) {
      await revokeAuthSession(env, sid);
      return null;
    }
  }

  const current = await getAuthSession(env, sid);
  if (!current) return null;

  try {
    const payload = await verifyAccessToken(current.access_token, env);
    return { user: { userId: payload.sub, email: payload.email ?? current.email, sid } };
  } catch {
    await revokeAuthSession(env, sid);
    return null;
  }
}

async function refreshSession(env: Env, sid: string, refreshToken: string): Promise<boolean> {
  const res = await fetch(`${env.ZHANG_AUTH_BASE_URL.replace(/\/$/, "")}/v1/token/refresh`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refreshToken })
  });
  const payload = (await res.json()) as {
    ok?: boolean;
    data?: { accessToken: string; refreshToken: string; expiresIn: number };
  };
  if (!res.ok || !payload.ok || !payload.data) {
    return false;
  }
  let exp = nowSeconds() + (payload.data.expiresIn ?? 900);
  try {
    const verified = await verifyAccessToken(payload.data.accessToken, env);
    exp = verified.exp;
  } catch {
    return false;
  }
  await updateAuthSessionTokens(env, sid, payload.data.accessToken, exp, payload.data.refreshToken);
  return true;
}

/** POST /auth/logout */
export async function handleLogout(request: Request, env: Env): Promise<Response> {
  const cookies = parseCookies(request);
  const sid = cookies[SESSION_COOKIE];
  if (sid) {
    const session = await getAuthSession(env, sid);
    if (session) {
      // Best-effort revoke upstream refresh token.
      try {
        await fetch(`${env.ZHANG_AUTH_BASE_URL.replace(/\/$/, "")}/v1/logout`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ refreshToken: session.refresh_token })
        });
      } catch {
        // ignore upstream failures
      }
      await revokeAuthSession(env, sid);
    }
  }
  return json({ loggedOut: true }, 200, { "set-cookie": clearCookie(SESSION_COOKIE) });
}
