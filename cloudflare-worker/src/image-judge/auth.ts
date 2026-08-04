/** 桌面授权桥接：/desktop/authorize、/auth/callback、/desktop/token、refresh、logout（文档 §8.1、§19.1）。 */
import type { Env } from "./types";
import { errorResponse, json, newId } from "./types";
import {
  fetchDiscovery,
  randomToken,
  s256Challenge,
  signToken,
  verifyIdToken,
  verifyToken,
} from "./tokens";

const TXN_TTL = 600; // OIDC 事务 10 分钟
const CODE_TTL = 120; // 一次性桌面 code 2 分钟

interface DesktopTxn {
  desktop_state: string;
  desktop_challenge: string;
  redirect_uri: string;
  nonce: string;
  verifier: string;
}

interface DesktopCodeEntry {
  sub: string;
  email: string;
  name: string;
  challenge: string;
  redirect_uri: string;
}

/** 仅允许本机 loopback 或已登记的 custom scheme（文档 §9.4）。 */
export function isAllowedDesktopRedirect(uri: string): boolean {
  if (uri === "imagejudge://auth/callback") return true;
  try {
    const u = new URL(uri);
    if (u.protocol !== "http:") return false;
    return u.hostname === "127.0.0.1" || u.hostname === "localhost";
  } catch {
    return false;
  }
}

export async function handleDesktopAuthorize(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const redirectUri = url.searchParams.get("redirect_uri") ?? "";
  const state = url.searchParams.get("state") ?? "";
  const challenge = url.searchParams.get("code_challenge") ?? "";
  const method = url.searchParams.get("code_challenge_method") ?? "";

  if (!isAllowedDesktopRedirect(redirectUri)) {
    return errorResponse(400, "INVALID_REQUEST", "redirect_uri is not allowed", false);
  }
  if (!state || !challenge || method !== "S256") {
    return errorResponse(400, "INVALID_REQUEST", "Missing state or code_challenge(S256)", false);
  }

  const discovery = await fetchDiscovery(env);
  const oidcState = randomToken(24);
  const nonce = randomToken(24);
  const verifier = randomToken(48);
  const oidcChallenge = await s256Challenge(verifier);

  const txn: DesktopTxn = {
    desktop_state: state,
    desktop_challenge: challenge,
    redirect_uri: redirectUri,
    nonce,
    verifier,
  };
  await env.KV.put(`txn:${oidcState}`, JSON.stringify(txn), { expirationTtl: TXN_TTL });

  const authorize = new URL(discovery.authorization_endpoint);
  authorize.searchParams.set("client_id", env.OIDC_CLIENT_ID);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("scope", "openid profile email");
  authorize.searchParams.set("redirect_uri", env.OIDC_REDIRECT_URI);
  authorize.searchParams.set("state", oidcState);
  authorize.searchParams.set("nonce", nonce);
  authorize.searchParams.set("code_challenge", oidcChallenge);
  authorize.searchParams.set("code_challenge_method", "S256");
  return Response.redirect(authorize.toString(), 302);
}

export async function handleAuthCallback(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const oidcState = url.searchParams.get("state");
  const oidcError = url.searchParams.get("error");
  if (oidcError) {
    return new Response(`Login failed: ${oidcError}`, { status: 400 });
  }
  if (!code || !oidcState) {
    return new Response("Missing code or state", { status: 400 });
  }

  const rawTxn = await env.KV.get(`txn:${oidcState}`);
  if (!rawTxn) return new Response("The login transaction has expired; please start again", { status: 400 });
  await env.KV.delete(`txn:${oidcState}`);
  const txn = JSON.parse(rawTxn) as DesktopTxn;

  const discovery = await fetchDiscovery(env);
  // Zhang Auth token endpoint 仅接受 client_secret_basic
  const basic = btoa(`${env.OIDC_CLIENT_ID}:${env.ZHANG_AUTH_CLIENT_SECRET}`);
  const tokenResp = await fetch(discovery.token_endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basic}`,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: env.OIDC_REDIRECT_URI,
      code_verifier: txn.verifier,
    }),
  });
  if (!tokenResp.ok) {
    return new Response(`Zhang Auth token exchange failed: ${tokenResp.status}`, { status: 502 });
  }
  const tokenData = (await tokenResp.json()) as { id_token?: string };
  if (!tokenData.id_token) return new Response("The identity provider response is missing id_token", { status: 502 });

  let claims;
  try {
    claims = await verifyIdToken(env, tokenData.id_token, txn.nonce);
  } catch (err) {
    return new Response(`id_token validation failed: ${(err as Error).message}`, { status: 401 });
  }

  // 以 OIDC sub 作为用户稳定身份（文档 §8.1 步骤 5）
  await env.DB.prepare(
    `INSERT INTO users (sub, email, name, created_at) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(sub) DO UPDATE SET email = excluded.email, name = excluded.name`
  )
    .bind(claims.sub, claims.email ?? "", claims.name ?? "", Date.now())
    .run();

  // 生成一次性、短时桌面 code（不回传 Zhang Auth refresh token）
  const desktopCode = randomToken(32);
  const entry: DesktopCodeEntry = {
    sub: claims.sub,
    email: claims.email ?? "",
    name: claims.name ?? "",
    challenge: txn.desktop_challenge,
    redirect_uri: txn.redirect_uri,
  };
  await env.KV.put(`code:${desktopCode}`, JSON.stringify(entry), { expirationTtl: CODE_TTL });

  const back = new URL(txn.redirect_uri);
  if (back.protocol === "http:") {
    back.searchParams.set("code", desktopCode);
    back.searchParams.set("state", txn.desktop_state);
  } else {
    // custom scheme：imagejudge://auth/callback?code=...&state=...
    back.search = `?code=${encodeURIComponent(desktopCode)}&state=${encodeURIComponent(txn.desktop_state)}`;
  }
  return Response.redirect(back.toString(), 302);
}

export async function handleDesktopToken(req: Request, env: Env): Promise<Response> {
  const form = await req.formData();
  const code = String(form.get("code") ?? "");
  const verifier = String(form.get("code_verifier") ?? "");
  const redirectUri = String(form.get("redirect_uri") ?? "");
  if (!code || !verifier || !redirectUri) {
    return errorResponse(400, "INVALID_REQUEST", "Missing required parameters", false);
  }

  const raw = await env.KV.get(`code:${code}`);
  if (!raw) return errorResponse(400, "INVALID_REQUEST", "The authorization code is invalid or expired", false);
  await env.KV.delete(`code:${code}`); // single-use code
  const entry = JSON.parse(raw) as DesktopCodeEntry;
  if (entry.redirect_uri !== redirectUri) {
    return errorResponse(400, "INVALID_REQUEST", "redirect_uri does not match", false);
  }
  const challenge = await s256Challenge(verifier);
  if (challenge !== entry.challenge) {
    return errorResponse(400, "INVALID_REQUEST", "PKCE verification failed", false);
  }

  return issueTokenPair(env, entry.sub, entry.email, entry.name);
}

async function issueTokenPair(env: Env, sub: string, email: string, name: string): Promise<Response> {
  const now = Math.floor(Date.now() / 1000);
  const accessTtl = parseInt(env.ACCESS_TOKEN_TTL_SECONDS || "900", 10);
  const refreshTtl = parseInt(env.REFRESH_TOKEN_TTL_SECONDS || "2592000", 10);
  const jti = newId("sess");

  await env.DB.prepare(
    `INSERT INTO sessions (jti, user_sub, issued_at, expires_at, revoked) VALUES (?1, ?2, ?3, ?4, 0)`
  )
    .bind(jti, sub, now, now + refreshTtl)
    .run();

  const accessToken = await signToken(
    { sub, email, name, type: "access", jti: newId("at"), iat: now, exp: now + accessTtl },
    env.TOKEN_SIGNING_SECRET
  );
  const refreshToken = await signToken(
    { sub, type: "refresh", jti, iat: now, exp: now + refreshTtl },
    env.TOKEN_SIGNING_SECRET
  );
  return json({
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: "Bearer",
    expires_in: accessTtl,
    email,
    name,
  });
}

export async function handleDesktopRefresh(req: Request, env: Env): Promise<Response> {
  const form = await req.formData();
  const refreshToken = String(form.get("refresh_token") ?? "");
  const payload = await verifyToken(refreshToken, env.TOKEN_SIGNING_SECRET);
  if (!payload || payload.type !== "refresh") {
    return errorResponse(401, "AUTH_EXPIRED", "The refresh token is invalid or expired", false);
  }
  const row = await env.DB.prepare(
    `SELECT revoked, expires_at FROM sessions WHERE jti = ?1`
  )
    .bind(payload.jti)
    .first<{ revoked: number; expires_at: number }>();
  if (!row || row.revoked || row.expires_at * 1000 < Date.now()) {
    return errorResponse(401, "AUTH_EXPIRED", "The session has been revoked or expired", false);
  }

  // 轮换：撤销旧 refresh token（文档 §9.4）
  const user = await env.DB.prepare(`SELECT email, name FROM users WHERE sub = ?1`)
    .bind(payload.sub)
    .first<{ email: string; name: string }>();

  const now = Math.floor(Date.now() / 1000);
  const refreshTtl = parseInt(env.REFRESH_TOKEN_TTL_SECONDS || "2592000", 10);
  const accessTtl = parseInt(env.ACCESS_TOKEN_TTL_SECONDS || "900", 10);
  const newJti = newId("sess");

  await env.DB.batch([
    env.DB.prepare(`UPDATE sessions SET revoked = 1, replaced_by = ?2 WHERE jti = ?1`).bind(
      payload.jti,
      newJti
    ),
    env.DB.prepare(
      `INSERT INTO sessions (jti, user_sub, issued_at, expires_at, revoked) VALUES (?1, ?2, ?3, ?4, 0)`
    ).bind(newJti, payload.sub, now, now + refreshTtl),
  ]);

  const accessToken = await signToken(
    {
      sub: payload.sub,
      email: user?.email ?? "",
      name: user?.name ?? "",
      type: "access",
      jti: newId("at"),
      iat: now,
      exp: now + accessTtl,
    },
    env.TOKEN_SIGNING_SECRET
  );
  const newRefresh = await signToken(
    { sub: payload.sub, type: "refresh", jti: newJti, iat: now, exp: now + refreshTtl },
    env.TOKEN_SIGNING_SECRET
  );
  return json({
    access_token: accessToken,
    refresh_token: newRefresh,
    token_type: "Bearer",
    expires_in: accessTtl,
  });
}

export async function handleDesktopLogout(req: Request, env: Env): Promise<Response> {
  const form = await req.formData().catch(() => null);
  const refreshToken = String(form?.get("refresh_token") ?? "");
  const payload = await verifyToken(refreshToken, env.TOKEN_SIGNING_SECRET);
  if (payload?.type === "refresh") {
    await env.DB.prepare(`UPDATE sessions SET revoked = 1 WHERE jti = ?1`)
      .bind(payload.jti)
      .run();
  }
  return new Response(null, { status: 204 });
}
