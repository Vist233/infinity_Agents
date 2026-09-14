import type { Env } from "./env";

// ES256 JWT verification against zhang-auth's published JWKS.
// JWKS is cached in-memory per isolate for a short TTL.

export interface AccessTokenPayload {
  sub: string;
  email?: string;
  name?: string;
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

export const JWKS_TTL_MS = 10 * 60 * 1000;
export const JWKS_FETCH_TIMEOUT_MS = 10 * 1000;
export const JWKS_STALE_IF_ERROR_MS = 5 * 60 * 1000;
export const JWKS_REFRESH_RETRY_DELAY_MS = 30 * 1000;

// These maps are isolate-local caches, not request state. A URL key keeps test
// environments and any future multi-issuer configuration from sharing keys.
const jwksCache = new Map<string, CachedJwks>();
const jwksRefreshes = new Map<string, Promise<JsonWebKey[]>>();
const jwksRefreshFailures = new Map<string, { failedAt: number; error: unknown }>();

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function fetchJwks(env: Env): Promise<JsonWebKey[]> {
  const controller = new AbortController();
  let timedOut = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new Error("JWKS fetch timed out"));
    }, JWKS_FETCH_TIMEOUT_MS);
  });

  try {
    const body = await Promise.race([
      (async () => {
        const res = await fetch(env.ZHANG_AUTH_JWKS_URL, {
          signal: controller.signal,
          cf: { cacheTtl: 300 },
        });
        if (!res.ok) {
          throw new Error(`Failed to fetch JWKS: ${res.status}`);
        }
        // zhang-auth serves JWKS wrapped in its standard envelope: { ok, data: { keys } }.
        // Accept both the enveloped shape and a bare { keys } for robustness.
        return (await res.json()) as { keys?: JsonWebKey[]; data?: { keys?: JsonWebKey[] } };
      })(),
      timeout,
    ]);
    const keys = Array.isArray(body.keys)
      ? body.keys
      : Array.isArray(body.data?.keys)
        ? body.data.keys
        : [];
    if (keys.length === 0) throw new Error("JWKS response did not contain keys");
    return keys;
  } catch (error) {
    // Aborting the platform fetch can reject before the timeout promise wins
    // the race. Normalize both paths to one bounded, observable failure.
    if (timedOut) throw new Error("JWKS fetch timed out");
    throw error;
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

function staleJwksOrThrow(url: string, error: unknown): JsonWebKey[] {
  const cached = jwksCache.get(url);
  if (cached && Date.now() - cached.fetchedAt < JWKS_TTL_MS + JWKS_STALE_IF_ERROR_MS) {
    // A short stale-if-error window avoids taking every authenticated API
    // request through the same upstream outage, while the bound still fails
    // closed after a key rotation could reasonably have propagated.
    return cached.keys;
  }
  throw error;
}

function startJwksRefresh(env: Env): Promise<JsonWebKey[]> {
  const url = env.ZHANG_AUTH_JWKS_URL;
  const existing = jwksRefreshes.get(url);
  if (existing) return existing;

  const refresh = fetchJwks(env)
    .then((keys) => {
      jwksCache.set(url, { keys, fetchedAt: Date.now() });
      jwksRefreshFailures.delete(url);
      return keys;
    })
    .catch((error) => {
      jwksRefreshFailures.set(url, { failedAt: Date.now(), error });
      throw error;
    });
  jwksRefreshes.set(url, refresh);

  // Use a rejection handler for the cleanup branch so a stale-while-
  // revalidate refresh cannot create an unhandled rejection when it runs in
  // the background. Callers that need the result still await `refresh`.
  void refresh.then(
    () => {
      if (jwksRefreshes.get(url) === refresh) jwksRefreshes.delete(url);
    },
    () => {
      if (jwksRefreshes.get(url) === refresh) jwksRefreshes.delete(url);
    },
  );
  return refresh;
}

async function loadJwks(env: Env): Promise<JsonWebKey[]> {
  const url = env.ZHANG_AUTH_JWKS_URL;
  const now = Date.now();
  const cached = jwksCache.get(url);
  const cacheAge = cached ? now - cached.fetchedAt : null;
  if (cached && cacheAge !== null && cacheAge < JWKS_TTL_MS) {
    return cached.keys;
  }

  const previousFailure = jwksRefreshFailures.get(url);
  const staleWindowAvailable = cached !== undefined
    && cacheAge !== null
    && cacheAge < JWKS_TTL_MS + JWKS_STALE_IF_ERROR_MS;
  if (staleWindowAvailable && previousFailure && now - previousFailure.failedAt < JWKS_REFRESH_RETRY_DELAY_MS) {
    return staleJwksOrThrow(url, previousFailure.error);
  }

  const refresh = startJwksRefresh(env);
  if (staleWindowAvailable) {
    // Stale-while-revalidate: the cached key set remains bounded by
    // staleJwksOrThrow, while the refresh is deduplicated and observed in the
    // background for subsequent requests.
    void refresh.catch(() => undefined);
    return cached.keys;
  }

  try {
    return await refresh;
  } catch (error) {
    jwksRefreshFailures.set(url, { failedAt: Date.now(), error });
    return staleJwksOrThrow(url, error);
  }
}

/**
 * Verify an ES256 access token's signature against the JWKS and validate its
 * standard claims (issuer, type, exp, aud). Returns the payload or throws.
 */
export async function verifyAccessToken(token: string, env: Env): Promise<AccessTokenPayload> {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("Invalid JWT format");
  }
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  let header: { alg?: unknown; kid?: unknown };
  try {
    header = JSON.parse(new TextDecoder().decode(base64UrlToBytes(encodedHeader))) as typeof header;
  } catch {
    throw new Error("Invalid access token header");
  }
  if (header.alg !== "ES256" || typeof header.kid !== "string" || !header.kid.trim()) {
    throw new Error("Invalid access token header");
  }

  const signingInput = new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`);
  let signature: Uint8Array;
  try {
    signature = base64UrlToBytes(encodedSignature);
  } catch {
    throw new Error("Invalid JWT signature");
  }

  const keys = await loadJwks(env);
  const jwk = keys.find((key) => {
    const candidate = key as JsonWebKey & { kid?: string; kty?: string; crv?: string };
    return candidate.kid === header.kid && candidate.kty === "EC" && candidate.crv === "P-256";
  });
  if (!jwk) {
    throw new Error("Unknown access token signing key");
  }

  let verified = false;
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
    verified = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, signature, signingInput);
  } catch {
    verified = false;
  }
  if (!verified) {
    throw new Error("JWT signature verification failed");
  }

  let payload: AccessTokenPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(encodedPayload))) as AccessTokenPayload;
  } catch {
    throw new Error("Invalid access token payload");
  }
  if (payload.type !== "access") {
    throw new Error("Invalid token type");
  }
  if (payload.iss !== env.ZHANG_AUTH_BASE_URL.replace(/\/$/, "")) {
    throw new Error("Invalid token issuer");
  }
  if (!payload.sub || typeof payload.sub !== "string") {
    throw new Error("Invalid token subject");
  }
  if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) {
    throw new Error("Invalid access token expiry");
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
export async function verifyIdToken(token: string, env: Env, expectedNonce: string): Promise<{ sub: string }> {
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
  return { sub: payload.sub };
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
