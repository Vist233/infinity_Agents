import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";
import { encryptAuthToken } from "../src/auth-token-crypto";
import { makeEnv } from "./fake-d1";

const ACCESS_KID = "auth-resilience-test-key";

interface SessionFixture {
  sid: string;
  user_id: string;
  email: string | null;
  access_token: string;
  access_expires_at: number;
  refresh_token: string;
  created_at: number;
  last_used_at: number;
  revoked_at: number | null;
  refresh_owner: string | null;
  refresh_started_at: number | null;
  token_version: number;
}

class AuthOutageD1 {
  roleWriteAttempts = 0;
  revokeAttempts = 0;
  migrationAttempts = 0;

  constructor(readonly session: SessionFixture) {}

  prepare(sql: string): AuthOutageStatement {
    return new AuthOutageStatement(this, sql);
  }
}

class AuthOutageStatement {
  private args: unknown[] = [];

  constructor(private readonly db: AuthOutageD1, private readonly sql: string) {}

  bind(...args: unknown[]): this {
    this.args = args;
    return this;
  }

  async first<T>(): Promise<T | null> {
    const sql = this.sql.replace(/\s+/g, " ");
    if (sql.includes("FROM auth_sessions")) {
      const [sid] = this.args as [string];
      if (sid !== this.db.session.sid || this.db.session.revoked_at !== null) return null;
      return { ...this.db.session } as T;
    }
    if (sql.includes("SELECT count FROM daily_usage")) return null;
    throw new Error(`unexpected read: ${sql}`);
  }

  async run(): Promise<{ meta: { changes: number } }> {
    const sql = this.sql.replace(/\s+/g, " ");
    if (sql.includes("UPDATE auth_sessions SET access_token = ?2")) {
      this.db.migrationAttempts += 1;
      throw new Error("D1 write unavailable");
    }
    if (sql.includes("INSERT INTO user_access_roles")) {
      this.db.roleWriteAttempts += 1;
      throw new Error("D1 write unavailable");
    }
    if (sql.includes("SET revoked_at")) {
      this.db.revokeAttempts += 1;
      throw new Error("D1 write unavailable");
    }
    throw new Error(`unexpected write: ${sql}`);
  }
}

let privateKey: CryptoKey;
let publicJwk: JsonWebKey & { kid: string };

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function encodeJson(value: unknown): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

async function signToken(payload: Record<string, unknown>): Promise<string> {
  const header = encodeJson({ alg: "ES256", typ: "JWT", kid: ACCESS_KID });
  const encodedPayload = encodeJson(payload);
  const input = `${header}.${encodedPayload}`;
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(input),
  );
  return `${input}.${base64Url(new Uint8Array(signature))}`;
}

async function sessionFor(
  env: Env,
  userId: string,
  sid: string,
  accessToken: string,
  legacy = false,
): Promise<SessionFixture> {
  const [encryptedAccess, encryptedRefresh] = await Promise.all([
    encryptAuthToken(accessToken, env, sid, "access"),
    encryptAuthToken("refresh-token", env, sid, "refresh"),
  ]);
  return {
    sid,
    user_id: userId,
    email: `${userId}@example.com`,
    access_token: legacy ? accessToken : encryptedAccess,
    access_expires_at: Math.floor(Date.now() / 1000) + 900,
    refresh_token: legacy ? "legacy-refresh-token" : encryptedRefresh,
    created_at: 1,
    last_used_at: 1,
    revoked_at: null,
    refresh_owner: null,
    refresh_started_at: null,
    token_version: 1,
  };
}

async function makeTestEnv(
  userId: string,
  sid: string,
  changes: Record<string, unknown> = {},
): Promise<{ env: Env; db: AuthOutageD1 }> {
  const { env: baseEnv } = makeEnv();
  const token = await signToken({
    sub: userId,
    email: `${userId}@example.com`,
    role: "user",
    iss: baseEnv.ZHANG_AUTH_BASE_URL,
    aud: baseEnv.ZHANG_AUTH_AUD,
    type: "access",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 900,
    sid,
    ...changes,
  });
  const session = await sessionFor(baseEnv, userId, sid, token, changes.legacy === true);
  const db = new AuthOutageD1(session);
  const env = makeEnv({ DB: db as unknown as Env["DB"] }).env;
  return { env, db };
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
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: { keys: [publicJwk] } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })));
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterAll(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("browser authentication during D1 write outages", () => {
  it("keeps /api/me available when role projection writes fail", async () => {
    const { env, db } = await makeTestEnv("auth-role-user", "auth-role-session");
    const response = await worker.fetch(new Request("https://app.test/api/me", {
      headers: { cookie: "ia_session=auth-role-session" },
    }), env);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      user: { id: "auth-role-user", email: "auth-role-user@example.com" },
      quota: { used: 0 },
    });
    expect(db.roleWriteAttempts).toBe(1);
    expect(db.revokeAttempts).toBe(0);
  });

  it("returns a bounded unauthenticated response when invalid-token revocation cannot write", async () => {
    const { env, db } = await makeTestEnv("auth-invalid-user", "auth-invalid-session", { aud: "wrong-audience" });
    const response = await worker.fetch(new Request("https://app.test/api/me", {
      headers: { cookie: "ia_session=auth-invalid-session" },
    }), env);

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "UNAUTHENTICATED" } });
    expect(db.revokeAttempts).toBe(1);
    expect(db.roleWriteAttempts).toBe(0);
  });

  it("does not retry legacy token migration on every browser poll while D1 writes fail", async () => {
    const { env, db } = await makeTestEnv("auth-legacy-user", "auth-legacy-session", { legacy: true });
    const request = () => worker.fetch(new Request("https://app.test/api/me", {
      headers: { cookie: "ia_session=auth-legacy-session" },
    }), env);

    expect((await request()).status).toBe(200);
    expect((await request()).status).toBe(200);
    expect(db.migrationAttempts).toBe(1);
    expect(db.roleWriteAttempts).toBe(1);
  });
});
