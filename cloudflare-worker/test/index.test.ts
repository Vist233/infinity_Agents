import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { makeEnv } from "./fake-d1";

function testEnv() {
  const { env } = makeEnv();
  env.ASSETS = {
    fetch: async () => new Response("static asset", { headers: { "content-type": "text/plain" } }),
  } as unknown as typeof env.ASSETS;
  return env;
}

describe("Infinity Edge route composition", () => {
  it("keeps the public health endpoint", async () => {
    const response = await worker.fetch(new Request("https://app.test/health"), testEnv());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", service: "infinity-agents-edge" });
  });

  it("starts the PaperAgent OIDC flow with PKCE", async () => {
    const response = await worker.fetch(
      new Request("https://app.test/auth/login?return_to=%2Fcode-agent"),
      testEnv(),
    );
    expect(response.status).toBe(302);
    const location = response.headers.get("location");
    expect(location).toBeTruthy();
    const authorize = new URL(location!);
    expect(authorize.pathname).toBe("/authorize");
    expect(authorize.searchParams.get("response_type")).toBe("code");
    expect(authorize.searchParams.get("scope")).toBe("openid profile email offline_access");
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(response.headers.get("set-cookie")).toContain("ia_oauth_state=");
  });

  it("routes ImageJudge health through its isolated namespace", async () => {
    const response = await worker.fetch(new Request("https://app.test/image-judge/healthz"), testEnv());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      service: "infinity-agents-edge",
      component: "image-judge",
    });
  });

  it("protects PaperAgent sessions independently of static assets", async () => {
    const response = await worker.fetch(new Request("https://app.test/api/sessions"), testEnv());
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "UNAUTHENTICATED" } });
  });

  it("falls back to the Next static export for product pages", async () => {
    const response = await worker.fetch(new Request("https://app.test/"), testEnv());
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("static asset");
  });
});
