import type { Env } from "./env";

// ES256 JWT verification against zhang-auth's published JWKS.
// JWKS is cached in-memory per isolate for a short TTL.

export interface AccessTokenPayload {
  sub: string;
  email?: string;
  role: string;
  iss: string;
  aud: string | string[];
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
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (env.ZHANG_AUTH_AUD && !audiences.includes(env.ZHANG_AUTH_AUD)) {
    throw new Error("Invalid audience");
  }
  return payload;
}

/** Verify an OIDC ID token and bind it to the login transaction nonce. */
export async function verifyIdToken(token: string, env: Env, expectedNonce: string): Promise<void> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid ID token format");
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  let header: { alg?: string; kid?: string };
  let payload: {
    iss?: string;
    sub?: string;
    aud?: string | string[];
    nonce?: string;
    iat?: number;
    exp?: number;
  };
  try {
    header = JSON.parse(new TextDecoder().decode(base64UrlToBytes(encodedHeader))) as typeof header;
    payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(encodedPayload))) as typeof payload;
  } catch {
    throw new Error("Invalid ID token claims");
  }
  if (header.alg !== "ES256" || !header.kid) throw new Error("Invalid ID token header");

  const keys = await loadJwks(env);
  const jwk = keys.find((key) => (key as JsonWebKey & { kid?: string }).kid === header.kid);
  if (!jwk) throw new Error("Unknown ID token signing key");
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    base64UrlToBytes(encodedSignature),
    new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
  );
  if (!valid) throw new Error("ID token signature verification failed");

  const now = Math.floor(Date.now() / 1000);
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (
    payload.iss !== env.ZHANG_AUTH_BASE_URL.replace(/\/$/, "") ||
    !audiences.includes(env.ZHANG_AUTH_CLIENT_ID) ||
    payload.nonce !== expectedNonce ||
    !payload.sub ||
    typeof payload.exp !== "number" ||
    payload.exp <= now ||
    (typeof payload.iat === "number" && payload.iat > now + 60)
  ) {
    throw new Error("Invalid ID token claims");
  }
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
