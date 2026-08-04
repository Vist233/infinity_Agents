import { describe, expect, it } from "vitest";
import { handleDesktopLogout, handleDesktopRefresh, handleDesktopToken } from "../src/imagejudge/auth";
import type { Env } from "../src/imagejudge/types";
import { s256Challenge, verifyToken } from "../src/imagejudge/tokens";

class MemoryKV {
  private values = new Map<string, string>();

  async get(key: string, type?: "json"): Promise<unknown> {
    const value = this.values.get(key);
    if (value === undefined) return null;
    return type === "json" ? JSON.parse(value) : value;
  }

  async put(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<boolean> {
    return this.values.delete(key);
  }
}

class MemoryD1 {
  sessions = new Map<string, { user_sub: string; expires_at: number; revoked: number; replaced_by?: string }>();
  users = new Map<string, { email: string; name: string }>([["user-1", { email: "demo@example.com", name: "Demo" }]]);

  prepare(sql: string) {
    const args: unknown[] = [];
    const statement = {
      bind: (...bound: unknown[]) => {
        args.push(...bound);
        return statement;
      },
      first: async <T>() => {
        if (sql.includes("SELECT revoked, expires_at FROM sessions")) {
          const row = this.sessions.get(String(args[0]));
          return (row ? { revoked: row.revoked, expires_at: row.expires_at } : null) as T | null;
        }
        if (sql.includes("SELECT email, name FROM users")) {
          return (this.users.get(String(args[0])) ?? null) as T | null;
        }
        return null as T | null;
      },
      run: async () => {
        if (sql.includes("INSERT INTO sessions")) {
          const [jti, userSub, _issuedAt, expiresAt] = args as [string, string, number, number];
          this.sessions.set(jti, { user_sub: userSub, expires_at: expiresAt, revoked: 0 });
        } else if (sql.includes("UPDATE sessions SET revoked = 1, replaced_by")) {
          const [oldJti, newJti] = args as [string, string];
          const row = this.sessions.get(oldJti);
          if (row) Object.assign(row, { revoked: 1, replaced_by: newJti });
        } else if (sql.includes("UPDATE sessions SET revoked = 1")) {
          const row = this.sessions.get(String(args[0]));
          if (row) row.revoked = 1;
        }
        return { success: true, meta: { changes: 1 } };
      },
    };
    return statement;
  }

  async batch(statements: Array<{ run: () => Promise<unknown> }>): Promise<unknown[]> {
    return Promise.all(statements.map((statement) => statement.run()));
  }
}

function makeEnv(db: MemoryD1, kv: MemoryKV): Env {
  return {
    DB: db as unknown as D1Database,
    KV: kv as unknown as KVNamespace,
    USER_LOCK: {} as DurableObjectNamespace,
    ZHANG_AUTH_ISSUER: "https://auth.zhangyvjing.com",
    OIDC_CLIENT_ID: "image-judge-desktop",
    OIDC_REDIRECT_URI: "https://infinity.zhangyvjing.com/image-judge/auth/callback",
    DASHSCOPE_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    MODEL_ID: "qwen3-vl-235b-a22b-instruct",
    DAILY_QUOTA: "30",
    ACCESS_TOKEN_TTL_SECONDS: "900",
    REFRESH_TOKEN_TTL_SECONDS: "2592000",
    MAX_IMAGE_BYTES: "10485760",
    ZHANG_AUTH_CLIENT_SECRET: "client-secret",
    TOKEN_SIGNING_SECRET: "token-signing-secret",
  };
}

function formRequest(path: string, values: Record<string, string>): Request {
  const form = new FormData();
  for (const [key, value] of Object.entries(values)) form.set(key, value);
  return new Request(`https://infinity.zhangyvjing.com/image-judge${path}`, { method: "POST", body: form });
}

describe("ImageJudge desktop token lifecycle", () => {
  it("exchanges a PKCE-bound code, rotates refresh tokens, and revokes logout", async () => {
    const db = new MemoryD1();
    const kv = new MemoryKV();
    const env = makeEnv(db, kv);
    const verifier = "verifier-".padEnd(50, "x");
    const redirectUri = "http://127.0.0.1:34567/callback";
    await kv.put("code:one-time-code", JSON.stringify({
      sub: "user-1",
      email: "demo@example.com",
      name: "Demo",
      challenge: await s256Challenge(verifier),
      redirect_uri: redirectUri,
    }));

    const tokenResponse = await handleDesktopToken(
      formRequest("/desktop/token", { code: "one-time-code", code_verifier: verifier, redirect_uri: redirectUri }),
      env,
    );
    expect(tokenResponse.status).toBe(200);
    const firstTokens = await tokenResponse.json() as { access_token: string; refresh_token: string };
    const firstRefresh = await verifyToken(firstTokens.refresh_token, env.TOKEN_SIGNING_SECRET);
    expect(firstRefresh?.type).toBe("refresh");
    expect(db.sessions.get(firstRefresh!.jti)?.revoked).toBe(0);

    const refreshResponse = await handleDesktopRefresh(
      formRequest("/desktop/refresh", { refresh_token: firstTokens.refresh_token }),
      env,
    );
    expect(refreshResponse.status).toBe(200);
    const rotated = await refreshResponse.json() as { refresh_token: string };
    expect(db.sessions.get(firstRefresh!.jti)?.revoked).toBe(1);

    const rotatedRefresh = await verifyToken(rotated.refresh_token, env.TOKEN_SIGNING_SECRET);
    expect(rotatedRefresh?.type).toBe("refresh");
    const logoutResponse = await handleDesktopLogout(
      formRequest("/desktop/logout", { refresh_token: rotated.refresh_token }),
      env,
    );
    expect(logoutResponse.status).toBe(204);
    expect(db.sessions.get(rotatedRefresh!.jti)?.revoked).toBe(1);
  });
});
