import type { Env } from "./env";

// ES256 JWT verification against zhang-auth's published JWKS.
// JWKS is cached in-memory per isolate for a short TTL.

export interface AccessTokenPayload {
  sub: string;
  email: string;
  role: string;
  iss: string;
  aud: string;
  type: string;
  iat: number;
  exp: number;
  sid: string;
}

interface CachedJwks {
  keys: JsonWebKey[];
  fetchedAt: number;
}

let jwksCache: CachedJwks | null = null;
const JWKS_TTL_MS = 10 * 60 * 1000;

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function loadJwks(env: Env): Promise<JsonWebKey[]> {
  if (jwksCache && Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS) {
    return jwksCache.keys;
  }
  const res = await fetch(env.ZHANG_AUTH_JWKS_URL, { cf: { cacheTtl: 300 } });
  if (!res.ok) {
    throw new Error(`Failed to fetch JWKS: ${res.status}`);
  }
  // zhang-auth serves JWKS wrapped in its standard envelope: { ok, data: { keys } }.
  // Accept both the enveloped shape and a bare { keys } for robustness.
  const body = (await res.json()) as { keys?: JsonWebKey[]; data?: { keys?: JsonWebKey[] } };
  const keys = Array.isArray(body.keys)
    ? body.keys
    : Array.isArray(body.data?.keys)
      ? body.data.keys
      : [];
  jwksCache = { keys, fetchedAt: Date.now() };
  return keys;
}

/**
 * Verify an ES256 access token's signature against the JWKS and validate its
 * standard claims (type, exp, aud). Returns the payload or throws.
 */
export async function verifyAccessToken(token: string, env: Env): Promise<AccessTokenPayload> {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("Invalid JWT format");
  }
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const signingInput = new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`);
  const signature = base64UrlToBytes(encodedSignature);

  const keys = await loadJwks(env);
  let verified = false;
  for (const jwk of keys) {
    try {
      const key = await crypto.subtle.importKey(
        "jwk",
        jwk,
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["verify"]
      );
      // WebCrypto expects a raw (r||s) signature for ECDSA, which is exactly the
      // JOSE ES256 encoding.
      const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, signature, signingInput);
      if (ok) {
        verified = true;
        break;
      }
    } catch {
      // try next key
    }
  }
  if (!verified) {
    throw new Error("JWT signature verification failed");
  }

  const payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(encodedPayload))) as AccessTokenPayload;
  if (payload.type !== "access") {
    throw new Error("Invalid token type");
  }
  if (payload.exp <= Math.floor(Date.now() / 1000)) {
    throw new Error("Access token expired");
  }
  if (env.ZHANG_AUTH_AUD && payload.aud !== env.ZHANG_AUTH_AUD) {
    throw new Error("Invalid audience");
  }
  return payload;
}

/** Decode payload without verifying (used to read exp before deciding to refresh). */
export function decodeExp(token: string): number | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(parts[1]))) as { exp?: number };
    return typeof payload.exp === "number" ? payload.exp : null;
  } catch {
    return null;
  }
}
