interface Env {
  ZHANG_AUTH_CLIENT_SECRET: string;
  INFINITY_SESSION_SECRET: string;
  STEPFUN_API_KEY: string;
  STEPFUN_BASE_URL: string;
  STEPFUN_MODEL: string;
}

import { frontendHtml } from "./frontend";

const ISSUER = "https://auth.zhangyvjing.com";
const CLIENT_ID = "infinity-agents";
const REDIRECT_URI = "https://infinity.zhangyvjing.com/auth/callback";
const SESSION_COOKIE = "__Host-infinity-session";
const TRANSACTION_COOKIE = "__Host-infinity-oidc";
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

type User = { sub: string; email?: string; exp: number };
type Transaction = { state: string; nonce: string; verifier: string; exp: number };

function responseJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, "cache-control": "no-store" } });
}

async function hmac(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value))));
}
function base64url(bytes: Uint8Array): string { return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, ""); }
function bytes(value: string): Uint8Array { const raw = atob(value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=")); return Uint8Array.from(raw, (c) => c.charCodeAt(0)); }
function random(length = 32): string { return base64url(crypto.getRandomValues(new Uint8Array(length))); }
async function sha256(value: string): Promise<string> { return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))); }
async function signed(value: object, secret: string): Promise<string> { const body = base64url(new TextEncoder().encode(JSON.stringify(value))); return `${body}.${await hmac(body, secret)}`; }
async function readSigned<T>(request: Request, name: string, secret: string): Promise<T | null> { const value = readCookie(request, name); if (!value) return null; const [body, signature] = value.split("."); if (!body || !signature || signature !== await hmac(body, secret)) return null; try { return JSON.parse(new TextDecoder().decode(bytes(body))) as T; } catch { return null; } }
function readCookie(request: Request, name: string): string | null { return request.headers.get("cookie")?.split(";").map((item) => item.trim()).find((item) => item.startsWith(`${name}=`))?.slice(name.length + 1) ?? null; }
function cookie(name: string, value: string, seconds: number): string { return `${name}=${value}; Path=/; Max-Age=${seconds}; HttpOnly; Secure; SameSite=Lax`; }
function clearCookie(name: string): string { return `${name}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`; }
function redirect(location: string, cookies: string[] = []): Response { const headers = new Headers({ location }); for (const value of cookies) headers.append("set-cookie", value); return new Response(null, { status: 302, headers }); }

async function currentUser(request: Request, env: Env): Promise<User | null> {
  const user = await readSigned<User>(request, SESSION_COOKIE, env.INFINITY_SESSION_SECRET);
  return user && user.exp > Math.floor(Date.now() / 1000) ? user : null;
}

async function verifyIdToken(token: string, nonce: string): Promise<User> {
  const [headerPart, payloadPart, signaturePart] = token.split(".");
  if (!headerPart || !payloadPart || !signaturePart) throw new Error("Malformed ID token");
  const header = JSON.parse(new TextDecoder().decode(bytes(headerPart))) as { alg?: string; kid?: string };
  const payload = JSON.parse(new TextDecoder().decode(bytes(payloadPart))) as User & { iss?: string; aud?: string | string[]; nonce?: string; azp?: string; nbf?: number; iat?: number };
  const now = Math.floor(Date.now() / 1000); const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (header.alg !== "ES256" || !header.kid || payload.iss !== ISSUER || !audiences.includes(CLIENT_ID) || (audiences.length > 1 && payload.azp !== CLIENT_ID) || payload.nonce !== nonce || !payload.sub || !payload.exp || payload.exp <= now || (payload.nbf !== undefined && payload.nbf > now + 60) || (payload.iat !== undefined && payload.iat > now + 60)) throw new Error("Invalid ID token claims");
  const discovery = await fetch(`${ISSUER}/.well-known/openid-configuration`).then((r) => r.json() as Promise<{ jwks_uri: string }>);
  const jwks = await fetch(discovery.jwks_uri).then((r) => r.json() as Promise<{ keys: JsonWebKey[] }>);
  const jwk = jwks.keys.find((key) => (key as JsonWebKey & { kid?: string }).kid === header.kid);
  if (!jwk || jwk.kty !== "EC" || jwk.crv !== "P-256" || jwk.use !== "sig" || jwk.alg !== "ES256") throw new Error("Unknown signing key");
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const valid = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, bytes(signaturePart), new TextEncoder().encode(`${headerPart}.${payloadPart}`));
  if (!valid) throw new Error("Invalid ID token signature");
  return { sub: payload.sub, email: payload.email, exp: payload.exp };
}

async function forwardChat(request: Request, env: Env): Promise<Response> {
  if (!await currentUser(request, env)) return responseJson({ error: { message: "Authentication required" } }, 401);
  if (request.headers.get("origin") !== "https://infinity.zhangyvjing.com") return responseJson({ error: { message: "Same-origin browser request required" } }, 403);
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (!Number.isFinite(contentLength) || contentLength > 64 * 1024) return responseJson({ error: { message: "Request body is too large" } }, 413);
  let payload: Record<string, unknown>;
  try { payload = await request.json<Record<string, unknown>>(); } catch { return responseJson({ error: { message: "Request body must be JSON" } }, 400); }
  if (!Array.isArray(payload.messages) || payload.messages.length === 0 || payload.messages.length > 20 || payload.messages.some((message) => !message || typeof message !== "object" || typeof (message as { content?: unknown }).content !== "string" || (message as { content: string }).content.length > 12_000)) return responseJson({ error: { message: "messages must contain at most 20 text messages of 12,000 characters" } }, 400);
  const upstream = await fetch(`${env.STEPFUN_BASE_URL}/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${env.STEPFUN_API_KEY}`, "content-type": "application/json", accept: payload.stream === true ? "text/event-stream" : "application/json" }, body: JSON.stringify({ ...payload, model: env.STEPFUN_MODEL, max_tokens: Math.min(Number(payload.max_tokens) || 1024, 2048) }) });
  return new Response(upstream.body, { status: upstream.status, headers: { "content-type": upstream.headers.get("content-type") ?? "application/json; charset=utf-8", "cache-control": "no-store" } });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") return responseJson({ status: "ok", service: "infinity-agents-edge", model: env.STEPFUN_MODEL });
    if (request.method === "GET" && url.pathname === "/login") {
      try {
      const transaction: Transaction = { state: random(), nonce: random(), verifier: random(48), exp: Math.floor(Date.now() / 1000) + 600 };
      const auth = new URL(`${ISSUER}/authorize`); auth.search = new URLSearchParams({ response_type: "code", client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, scope: "openid profile email offline_access", state: transaction.state, nonce: transaction.nonce, code_challenge: await sha256(transaction.verifier), code_challenge_method: "S256" }).toString();
      return redirect(auth.toString(), [cookie(TRANSACTION_COOKIE, await signed(transaction, env.INFINITY_SESSION_SECRET), 600)]);
      } catch (error) { return responseJson({ error: error instanceof Error ? error.message : String(error) }, 500); }
    }
    if (request.method === "GET" && url.pathname === "/auth/callback") {
      try {
        const transaction = await readSigned<Transaction>(request, TRANSACTION_COOKIE, env.INFINITY_SESSION_SECRET);
        const code = url.searchParams.get("code");
        if (!transaction || transaction.exp <= Math.floor(Date.now() / 1000) || !code || url.searchParams.get("state") !== transaction.state) return redirect("/", [clearCookie(TRANSACTION_COOKIE)]);
        const basic = btoa(`${CLIENT_ID}:${env.ZHANG_AUTH_CLIENT_SECRET}`);
        const token = await fetch(`${ISSUER}/token`, { method: "POST", headers: { authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI, code_verifier: transaction.verifier }).toString() });
        if (!token.ok) throw new Error("Token exchange failed");
        const data = await token.json() as { id_token?: string };
        if (!data.id_token) throw new Error("Provider did not return an ID token");
        const user = await verifyIdToken(data.id_token, transaction.nonce);
        return redirect("/", [cookie(SESSION_COOKIE, await signed(user, env.INFINITY_SESSION_SECRET), Math.max(1, user.exp - Math.floor(Date.now() / 1000))), clearCookie(TRANSACTION_COOKIE)]);
      } catch { return redirect("/", [clearCookie(TRANSACTION_COOKIE)]); }
    }
    // The provider intentionally scopes logout to its own browser session and
    // does not support a registered post-logout URI. Sign out of Infinity
    // locally while retaining the provider's SSO session for other apps.
    if (request.method === "GET" && url.pathname === "/logout") return redirect("/", [clearCookie(SESSION_COOKIE), clearCookie(TRANSACTION_COOKIE)]);
    if (request.method === "GET" && url.pathname === "/") { const user = await currentUser(request, env); return new Response(frontendHtml(user), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } }); }
    if (request.method === "GET" && url.pathname === "/v1/models") { if (!await currentUser(request, env)) return responseJson({ error: { message: "Authentication required" } }, 401); return responseJson({ object: "list", data: [{ id: env.STEPFUN_MODEL, object: "model" }] }); }
    if (request.method === "POST" && (url.pathname === "/v1/chat/completions" || url.pathname === "/chat")) return forwardChat(request, env);
    return responseJson({ error: { message: "Not found" } }, 404);
  },
} satisfies ExportedHandler<Env>;
