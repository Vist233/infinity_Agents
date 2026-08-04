/** 平台代理令牌签发/校验 + Zhang Auth ID Token（ES256）校验。 */
import type { Env } from "./types";

const encoder = new TextEncoder();

function b64urlEncode(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(text: string): Uint8Array {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

export interface PlatformTokenPayload {
  sub: string;
  email?: string;
  name?: string;
  type: "access" | "refresh";
  jti: string;
  iat: number;
  exp: number;
}

/** 签发 HMAC-SHA256 签名的平台令牌（格式：payload.sig）。 */
export async function signToken(payload: PlatformTokenPayload, secret: string): Promise<string> {
  const body = b64urlEncode(encoder.encode(JSON.stringify(payload)));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return `${body}.${b64urlEncode(sig)}`;
}

/** 校验签名与有效期；失败返回 null。 */
export async function verifyToken(
  token: string,
  secret: string
): Promise<PlatformTokenPayload | null> {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  try {
    const key = await hmacKey(secret);
    const ok = await crypto.subtle.verify(
      "HMAC",
      key,
      b64urlDecode(sig) as unknown as ArrayBuffer,
      encoder.encode(body)
    );
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body))) as PlatformTokenPayload;
    if (typeof payload.exp !== "number" || payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Zhang Auth ID Token 校验（ES256 + discovery/JWKS）
// ---------------------------------------------------------------------------
export interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

const DISCOVERY_TTL = 3600;

export async function fetchDiscovery(env: Env): Promise<OidcDiscovery> {
  const cacheKey = "oidc:discovery";
  const cached = await env.KV.get(cacheKey, "json");
  if (cached) return cached as OidcDiscovery;
  const resp = await fetch(`${env.ZHANG_AUTH_ISSUER}/.well-known/openid-configuration`, {
    cf: { cacheTtl: 300 },
  });
  if (!resp.ok) throw new Error(`discovery 失败: ${resp.status}`);
  const data = (await resp.json()) as OidcDiscovery;
  if (data.issuer !== env.ZHANG_AUTH_ISSUER) throw new Error("discovery issuer 不匹配");
  await env.KV.put(cacheKey, JSON.stringify(data), { expirationTtl: DISCOVERY_TTL });
  return data;
}

interface Jwk {
  kty: string;
  crv?: string;
  kid?: string;
  alg?: string;
  use?: string;
  x?: string;
  y?: string;
}

async function fetchJwks(env: Env, jwksUri: string): Promise<Jwk[]> {
  const cacheKey = `oidc:jwks:${jwksUri}`;
  const cached = await env.KV.get(cacheKey, "json");
  if (cached) return (cached as { keys: Jwk[] }).keys;
  const resp = await fetch(jwksUri, { cf: { cacheTtl: 300 } });
  if (!resp.ok) throw new Error(`JWKS 获取失败: ${resp.status}`);
  const data = (await resp.json()) as { keys: Jwk[] };
  await env.KV.put(cacheKey, JSON.stringify(data), { expirationTtl: 600 });
  return data.keys;
}

export interface IdTokenClaims {
  iss: string;
  aud: string;
  sub: string;
  exp: number;
  iat: number;
  nonce?: string;
  email?: string;
  name?: string;
}

/** 校验 Zhang Auth ID Token：ES256 签名、iss、aud、exp、nonce。 */
export async function verifyIdToken(
  env: Env,
  idToken: string,
  expectedNonce: string
): Promise<IdTokenClaims> {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("id_token 结构非法");
  const [headerB64, payloadB64, sigB64] = parts;
  const header = JSON.parse(new TextDecoder().decode(b64urlDecode(headerB64))) as {
    alg: string;
    kid?: string;
  };
  if (header.alg !== "ES256") throw new Error(`不支持的签名算法: ${header.alg}`);

  const discovery = await fetchDiscovery(env);
  const keys = await fetchJwks(env, discovery.jwks_uri);
  const jwk = keys.find((k) => (header.kid ? k.kid === header.kid : true) && k.kty === "EC");
  if (!jwk) throw new Error("JWKS 中无匹配密钥");

  const cryptoKey = await crypto.subtle.importKey(
    "jwk",
    jwk as JsonWebKey,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"]
  );
  const ok = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    cryptoKey,
    b64urlDecode(sigB64) as unknown as ArrayBuffer,
    encoder.encode(`${headerB64}.${payloadB64}`)
  );
  if (!ok) throw new Error("id_token 签名校验失败");

  const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(payloadB64))) as IdTokenClaims;
  if (claims.iss !== env.ZHANG_AUTH_ISSUER) throw new Error("iss 校验失败");
  if (claims.aud !== env.OIDC_CLIENT_ID) throw new Error("aud 校验失败");
  if (claims.exp * 1000 < Date.now()) throw new Error("id_token 已过期");
  if (claims.nonce !== expectedNonce) throw new Error("nonce 校验失败");
  if (!claims.sub) throw new Error("缺少 sub");
  return claims;
}

export function s256Challenge(verifier: string): Promise<string> {
  return crypto.subtle
    .digest("SHA-256", encoder.encode(verifier))
    .then((d) => b64urlEncode(d));
}

export function randomToken(byteLength = 32): string {
  return b64urlEncode(crypto.getRandomValues(new Uint8Array(byteLength)));
}
