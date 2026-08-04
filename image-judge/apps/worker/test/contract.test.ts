import { describe, expect, it } from "vitest";
import { isAllowedDesktopRedirect } from "../src/auth";
import { signToken, verifyToken } from "../src/tokens";

describe("ImageJudge Worker contracts", () => {
  it("only accepts loopback or the documented custom-scheme desktop callback", () => {
    expect(isAllowedDesktopRedirect("http://127.0.0.1:34567/callback")).toBe(true);
    expect(isAllowedDesktopRedirect("http://localhost:34567/callback")).toBe(true);
    expect(isAllowedDesktopRedirect("imagejudge://auth/callback")).toBe(true);
    expect(isAllowedDesktopRedirect("https://evil.example/callback")).toBe(false);
  });

  it("signs and rejects tampered platform tokens", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signToken(
      { sub: "user-1", type: "access", jti: "jti-1", iat: now, exp: now + 300 },
      "test-signing-secret",
    );
    expect(await verifyToken(token, "test-signing-secret")).toMatchObject({ sub: "user-1", type: "access" });
    expect(await verifyToken(`${token}tampered`, "test-signing-secret")).toBeNull();
  });
});
