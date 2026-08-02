import { describe, expect, it } from "vitest";
import { handleLogin } from "../src/auth";
import { makeEnv } from "./fake-d1";

describe("OIDC login initiation", () => {
  it("uses authorization-code PKCE and stores only transaction data in an HttpOnly cookie", async () => {
    const { env } = makeEnv({
      APP_BASE_URL: "https://infinity.zhangyvjing.com",
      ZHANG_AUTH_BASE_URL: "https://auth.zhangyvjing.com",
    });

    const response = await handleLogin(
      new Request("https://infinity.zhangyvjing.com/auth/login?return_to=%2Fpaper"),
      env,
    );

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!);
    expect(location.origin).toBe("https://auth.zhangyvjing.com");
    expect(location.pathname).toBe("/authorize");
    expect(location.searchParams.get("response_type")).toBe("code");
    expect(location.searchParams.get("client_id")).toBe("infinity-agents");
    expect(location.searchParams.get("redirect_uri")).toBe("https://infinity.zhangyvjing.com/auth/callback");
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("code_challenge")?.length).toBeGreaterThanOrEqual(43);
    expect(location.searchParams.get("nonce")).toBeTruthy();
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).toContain("SameSite=Lax");
  });
});
