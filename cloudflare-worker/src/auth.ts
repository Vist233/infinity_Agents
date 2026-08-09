import type { Env } from "./env";
import { SESSION_COOKIE, OAUTH_STATE_COOKIE, AUTH_CALLBACK_PATH } from "./env";
import { clearCookie, errorJson, json, nowSeconds, parseCookies, serializeCookie } from "./http";
import { getAuthSession, insertAuthSession, revokeAuthSession, updateAuthSessionTokens } from "./db";
import { verifyAccessToken } from "./jwt";
import { verifyIdToken } from "./jwt";

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30d, matches refresh token TTL
const STATE_TTL_SECONDS = 60 * 10;

interface OidcTransaction {
  state: string;
  nonce: string;
  verifier: string;
  returnTo: string;
  exp: number;
}

export interface AuthedUser {
  userId: string;
  email: string | null;
  sid: string;
}

function randomToken(bytes = 32): string {
  const arr = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...arr)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

function callbackUrl(env: Env): string {
  return `${env.APP_BASE_URL.replace(/\/$/, "")}${AUTH_CALLBACK_PATH}`;
}

function sessionCookie(sid: string): string {
  return serializeCookie(SESSION_COOKIE, sid, { maxAge: SESSION_TTL_SECONDS, sameSite: "Lax" });
}

/** GET /auth/login — start the authorization-code flow. */
export async function handleLogin(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const returnTo = url.searchParams.get("return_to") ?? "/";
  const state = randomToken(24);
  const nonce = randomToken(24);
  const verifier = randomToken(48);
  const transaction: OidcTransaction = {
    state,
    nonce,
    verifier,
    returnTo: returnTo.startsWith("/") ? returnTo : "/",
    exp: nowSeconds() + STATE_TTL_SECONDS,
  };

  const authorizeUrl = new URL(`${env.ZHANG_AUTH_BASE_URL.replace(/\/$/, "")}/authorize`);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", env.ZHANG_AUTH_CLIENT_ID);
  authorizeUrl.searchParams.set("redirect_uri", callbackUrl(env));
  authorizeUrl.searchParams.set("scope", "openid profile email offline_access");
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("nonce", nonce);
  authorizeUrl.searchParams.set("code_challenge", await pkceChallenge(verifier));
  authorizeUrl.searchParams.set("code_challenge_method", "S256");

  const headers = new Headers({ location: authorizeUrl.toString() });
  headers.append(
    "set-cookie",
    serializeCookie(OAUTH_STATE_COOKIE, JSON.stringify(transaction), { maxAge: STATE_TTL_SECONDS, sameSite: "Lax" })
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

  let transaction: OidcTransaction | null = null;
  try {
    const parsed = JSON.parse(cookies[OAUTH_STATE_COOKIE] ?? "null") as Partial<OidcTransaction> | null;
    if (
      parsed &&
      typeof parsed.state === "string" &&
      typeof parsed.nonce === "string" &&
      typeof parsed.verifier === "string" &&
      typeof parsed.exp === "number"
    ) {
      transaction = {
        state: parsed.state,
        nonce: parsed.nonce,
        verifier: parsed.verifier,
        returnTo: typeof parsed.returnTo === "string" && parsed.returnTo.startsWith("/") ? parsed.returnTo : "/",
        exp: parsed.exp,
      };
    }
  } catch {
    // ignore
  }
  if (!transaction || transaction.exp <= nowSeconds() || transaction.state !== state) {
    return errorJson("Invalid state", 400, "INVALID_STATE");
  }

  const basic = btoa(`${env.ZHANG_AUTH_CLIENT_ID}:${env.ZHANG_AUTH_CLIENT_SECRET}`);
  let tokenRes: Response;
  let tokenPayload: {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    id_token?: string;
    error?: string;
    error_description?: string;
  };
  try {
    tokenRes = await fetch(`${env.ZHANG_AUTH_BASE_URL.replace(/\/$/, "")}/token`, {
      method: "POST",
      headers: {
        authorization: `Basic ${basic}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: callbackUrl(env),
        code_verifier: transaction.verifier,
      }).toString(),
    });
    tokenPayload = await tokenRes.json() as typeof tokenPayload;
  } catch {
    return errorJson("Authentication provider is unavailable", 502, "AUTH_PROVIDER_UNAVAILABLE");
  }
  if (!tokenRes.ok || !tokenPayload.access_token || !tokenPayload.refresh_token || !tokenPayload.id_token) {
    return errorJson(tokenPayload.error_description ?? tokenPayload.error ?? "Token exchange failed", 401, "TOKEN_EXCHANGE_FAILED");
  }

  // Verify both token types before creating the site session. The access token
  // is used for API calls; the ID token binds the response to this login's
  // client and nonce.
  let payload: Awaited<ReturnType<typeof verifyAccessToken>>;
  try {
    payload = await verifyAccessToken(tokenPayload.access_token, env);
    await verifyIdToken(tokenPayload.id_token, env, transaction.nonce);
  } catch {
    return errorJson("Authentication token validation failed", 401, "TOKEN_VALIDATION_FAILED");
  }

  const sid = randomToken(32);
  const ts = nowSeconds();
  await insertAuthSession(env, {
    sid,
    user_id: payload.sub,
    email: payload.email ?? null,
    access_token: tokenPayload.access_token,
    access_expires_at: payload.exp,
    refresh_token: tokenPayload.refresh_token,
    created_at: ts,
    last_used_at: ts
  });

  const safeReturn = transaction.returnTo;
  const headers = new Headers({ location: `${env.APP_BASE_URL.replace(/\/$/, "")}${safeReturn}` });
  headers.append(
    "set-cookie",
    sessionCookie(sid)
  );
  headers.append("set-cookie", clearCookie(OAUTH_STATE_COOKIE));
  return new Response(null, { status: 302, headers });
}

/**
 * Resolve the authenticated user for a request. Two-layer check:
 *  1) valid site session cookie mapped to a stored session
 *  2) the stored access token verifies against JWKS (refreshing + rotating if expired)
 * Returns the user and renews the site cookie on every successful API request.
 * This makes the 30-day browser session sliding rather than fixed at login.
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
    return {
      user: { userId: payload.sub, email: payload.email ?? current.email, sid },
      setCookie: sessionCookie(sid)
    };
  } catch {
    await revokeAuthSession(env, sid);
    return null;
  }
}

async function refreshSession(env: Env, sid: string, refreshToken: string): Promise<boolean> {
  const basic = btoa(`${env.ZHANG_AUTH_CLIENT_ID}:${env.ZHANG_AUTH_CLIENT_SECRET}`);
  const res = await fetch(`${env.ZHANG_AUTH_BASE_URL.replace(/\/$/, "")}/token`, {
    method: "POST",
    headers: {
      authorization: `Basic ${basic}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }).toString(),
  });
  const payload = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!res.ok || !payload.access_token || !payload.refresh_token) {
    return false;
  }
  let exp = nowSeconds() + (payload.expires_in ?? 900);
  try {
    const verified = await verifyAccessToken(payload.access_token, env);
    exp = verified.exp;
  } catch {
    return false;
  }
  await updateAuthSessionTokens(env, sid, payload.access_token, exp, payload.refresh_token);
  return true;
}

/** POST /auth/logout */
export async function handleLogout(request: Request, env: Env): Promise<Response> {
  const cookies = parseCookies(request);
  const sid = cookies[SESSION_COOKIE];
  if (sid) {
    const session = await getAuthSession(env, sid);
    if (session) {
      await revokeAuthSession(env, sid);
    }
  }
  return json({ loggedOut: true }, 200, { "set-cookie": clearCookie(SESSION_COOKIE) });
}
