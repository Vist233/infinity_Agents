import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { verifyAccessToken, verifyIdToken } from "../src/jwt";

const ACCESS_KID = "paper-test-access-key";
const ENV = {
  ZHANG_AUTH_JWKS_URL: "https://auth.test/.well-known/jwks.json",
  ZHANG_AUTH_BASE_URL: "https://auth.test",
  ZHANG_AUTH_AUD: "infinity-agents",
  ZHANG_AUTH_CLIENT_ID: "infinity-agents",
} as Env;

let privateKey: CryptoKey;
let publicJwk: JsonWebKey & { kid: string };
const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: { keys: [publicJwk] } }), {
  status: 200,
  headers: { "content-type": "application/json" },
}));

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function encodeJson(value: unknown): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

async function signSegments(headerSegment: string, payloadSegment: string): Promise<string> {
  const input = `${headerSegment}.${payloadSegment}`;
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(input),
  );
  return `${input}.${base64Url(new Uint8Array(signature))}`;
}

async function makeToken(
  payload: Record<string, unknown> = defaultAccessPayload(),
  header: Record<string, unknown> = { alg: "ES256", typ: "JWT", kid: ACCESS_KID },
): Promise<string> {
  return signSegments(encodeJson(header), encodeJson(payload));
}

function defaultAccessPayload(): Record<string, unknown> {
  return {
    sub: "user-1",
    email: "user@example.com",
    role: "user",
    iss: "https://auth.test",
    aud: "infinity-agents",
    type: "access",
    iat: 1_700_000_000,
    exp: Math.floor(Date.now() / 1000) + 900,
    sid: "sid-1",
  };
}

beforeAll(async () => {
  const generated = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair;
  privateKey = generated.privateKey;
  publicJwk = {
    ...await crypto.subtle.exportKey("jwk", generated.publicKey) as JsonWebKey,
    kid: ACCESS_KID,
  };
  vi.stubGlobal("fetch", fetchMock);
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("Access Token JWT header contract", () => {
  it("accepts a valid ES256 access token with the matching kid", async () => {
    const token = await makeToken();
    await expect(verifyAccessToken(token, ENV)).resolves.toMatchObject({ sub: "user-1", type: "access" });
  });

  it("continues to accept a valid ES256 ID token", async () => {
    const token = await makeToken({
      iss: "https://auth.test",
      sub: "user-1",
      aud: "infinity-agents",
      nonce: "nonce-1",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 900,
    });
    await expect(verifyIdToken(token, ENV, "nonce-1")).resolves.toEqual({ sub: "user-1" });
  });

  it.each([
    ["none algorithm", { alg: "none", typ: "JWT", kid: ACCESS_KID }],
    ["HS256 algorithm", { alg: "HS256", typ: "JWT", kid: ACCESS_KID }],
    ["missing kid", { alg: "ES256", typ: "JWT" }],
  ])("rejects a header with %s before verification", async (_name, header) => {
    await expect(verifyAccessToken(await makeToken(defaultAccessPayload(), header), ENV))
      .rejects.toThrow("Invalid access token header");
  });

  it("rejects an unknown kid without trying another published key", async () => {
    await expect(verifyAccessToken(await makeToken(defaultAccessPayload(), {
      alg: "ES256",
      typ: "JWT",
      kid: "unknown-key",
    }), ENV)).rejects.toThrow("Unknown access token signing key");
  });

  it("rejects malformed header, payload, and signature", async () => {
    const valid = await makeToken();
    const [, payload, signature] = valid.split(".");
    await expect(verifyAccessToken(`not-json.${payload}.${signature}`, ENV)).rejects.toThrow("Invalid access token header");

    const validHeader = encodeJson({ alg: "ES256", typ: "JWT", kid: ACCESS_KID });
    await expect(verifyAccessToken(await signSegments(validHeader, "not-json"), ENV))
      .rejects.toThrow("Invalid access token payload");
    await expect(verifyAccessToken(`${validHeader}.${encodeJson(defaultAccessPayload())}.***`, ENV))
      .rejects.toThrow();
  });

  it.each([
    ["expired token", { exp: Math.floor(Date.now() / 1000) - 1 }, "Access token expired"],
    ["wrong issuer", { iss: "https://other.test" }, "Invalid token issuer"],
    ["wrong audience", { aud: "other-audience" }, "Invalid audience"],
    ["wrong type", { type: "refresh" }, "Invalid token type"],
  ])("rejects %s", async (_name, changes, message) => {
    await expect(verifyAccessToken(await makeToken({ ...defaultAccessPayload(), ...changes }), ENV))
      .rejects.toThrow(message);
  });
});
