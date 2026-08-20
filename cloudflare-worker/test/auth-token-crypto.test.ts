import { describe, expect, it } from "vitest";
import { decryptAuthToken, encryptAuthToken } from "../src/auth-token-crypto";
import { makeEnv } from "./fake-d1";
import {
  claimAuthSessionRefresh,
  getAuthSession,
  revokeAuthSession,
  revokeAuthSessionRefreshOwner,
  updateAuthSessionTokens,
} from "../src/db";

describe("auth session token encryption", () => {
  it("encrypts tokens with session-bound AAD and keeps legacy reads compatible", async () => {
    const { env } = makeEnv();
    const ciphertext = await encryptAuthToken("refresh-secret", env, "sid-1", "refresh");
    expect(ciphertext).toMatch(/^auth\.v1\./);
    expect(ciphertext).not.toContain("refresh-secret");
    await expect(decryptAuthToken(ciphertext, env, "sid-1", "refresh")).resolves.toBe("refresh-secret");
    await expect(decryptAuthToken(ciphertext, env, "sid-2", "refresh")).rejects.toThrow();
    await expect(decryptAuthToken("legacy-plaintext", env, "sid-1", "refresh")).resolves.toBe("legacy-plaintext");
  });
});

describe("legacy auth session migration", () => {
  it("rewrites active plaintext tokens and clears them on revoke", async () => {
    const row = {
      sid: "sid-legacy", user_id: "user-1", email: null,
      access_token: "legacy-access", access_expires_at: 1_900_000_000,
      refresh_token: "legacy-refresh", created_at: 1, last_used_at: 1,
      revoked_at: null as number | null,
    };
    const db = {
      prepare(sql: string) {
        let args: unknown[] = [];
        return {
          bind(...values: unknown[]) { args = values; return this; },
          async first() { return row.revoked_at == null ? { ...row } : null; },
          async run() {
            if (sql.includes("SET access_token = ?2")) {
              row.access_token = String(args[1]);
              row.refresh_token = String(args[2]);
            } else if (sql.includes("SET revoked_at")) {
              row.revoked_at = Number(args[1]);
              row.access_token = "";
              row.refresh_token = "";
            }
            return { meta: { changes: 1 } };
          },
        };
      },
    };
    const { env } = makeEnv({ DB: db as unknown as ReturnType<typeof makeEnv>["env"]["DB"] });
    await expect(getAuthSession(env, row.sid)).resolves.toMatchObject({ access_token: "legacy-access", refresh_token: "legacy-refresh" });
    expect(row.access_token).toMatch(/^auth\.v1\./);
    expect(row.refresh_token).toMatch(/^auth\.v1\./);
    await revokeAuthSession(env, row.sid);
    expect(row).toMatchObject({ access_token: "", refresh_token: "" });
    expect(row.revoked_at).toBeTypeOf("number");
  });

  it("fences concurrent refresh owners and stale provider responses", async () => {
    const row = {
      sid: "sid-refresh", refresh_owner: null as string | null,
      refresh_started_at: null as number | null, revoked_at: null as number | null,
      access_token: "old-access", refresh_token: "old-refresh",
      access_expires_at: 1, token_version: 1,
    };
    const db = {
      prepare(sql: string) {
        let args: unknown[] = [];
        return {
          bind(...values: unknown[]) { args = values; return this; },
          async run() {
            let changes = 0;
            if (sql.includes("SET refresh_owner = ?2, refresh_started_at = ?3")) {
              const [, owner, startedAt, staleBefore] = args as [string, string, number, number];
              if (row.revoked_at == null && (row.refresh_owner == null || Number(row.refresh_started_at) <= staleBefore)) {
                row.refresh_owner = owner; row.refresh_started_at = startedAt; changes = 1;
              }
            } else if (sql.includes("token_version = token_version + 1")) {
              const [, access, expiresAt, refresh, , owner] = args as [string, string, number, string, number, string];
              if (row.revoked_at == null && row.refresh_owner === owner) {
                row.access_token = access; row.access_expires_at = expiresAt;
                row.refresh_token = refresh; row.refresh_owner = null;
                row.refresh_started_at = null; row.token_version += 1; changes = 1;
              }
            } else if (sql.includes("SET revoked_at = ?3")) {
              const [, owner, revokedAt] = args as [string, string, number];
              if (row.revoked_at == null && row.refresh_owner === owner) {
                row.revoked_at = revokedAt; row.refresh_owner = null;
                row.refresh_started_at = null; changes = 1;
              }
            }
            return { meta: { changes } };
          },
        };
      },
    };
    const { env } = makeEnv({ DB: db as unknown as ReturnType<typeof makeEnv>["env"]["DB"] });

    await expect(claimAuthSessionRefresh(env, row.sid, "owner-a", 1000)).resolves.toBe(true);
    await expect(claimAuthSessionRefresh(env, row.sid, "owner-b", 1001)).resolves.toBe(false);
    await expect(updateAuthSessionTokens(env, row.sid, "stale", 2000, "stale", "owner-b")).resolves.toBe(false);
    await expect(updateAuthSessionTokens(env, row.sid, "fresh", 3000, "rotated", "owner-a")).resolves.toBe(true);
    expect(row).toMatchObject({ refresh_owner: null, access_expires_at: 3000, token_version: 2, revoked_at: null });

    await expect(claimAuthSessionRefresh(env, row.sid, "owner-c", 1002)).resolves.toBe(true);
    await revokeAuthSessionRefreshOwner(env, row.sid, "owner-b");
    expect(row.revoked_at).toBeNull();
    await revokeAuthSessionRefreshOwner(env, row.sid, "owner-c");
    expect(row.revoked_at).toBeTypeOf("number");
  });
});
