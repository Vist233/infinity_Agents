import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { validateBrowserMutation } from "../src/auth";
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

  it("requires same-origin double-submit CSRF protection for browser mutations", async () => {
    const { env } = makeEnv();
    const missing = validateBrowserMutation(
      new Request("https://app.test/api/sessions", { method: "POST", headers: { origin: "https://app.test" } }),
      env,
    );
    expect(missing?.status).toBe(403);
    expect(await missing?.json()).toMatchObject({ error: { code: "CSRF_INVALID" } });

    const crossOrigin = validateBrowserMutation(
      new Request("https://app.test/api/sessions", {
        method: "POST",
        headers: { origin: "https://evil.test", cookie: "infinity_csrf=csrf-1", "x-csrf-token": "csrf-1" },
      }),
      env,
    );
    expect(crossOrigin?.status).toBe(403);
    expect(await crossOrigin?.json()).toMatchObject({ error: { code: "CSRF_ORIGIN_MISMATCH" } });

    const accepted = validateBrowserMutation(
      new Request("https://app.test/api/sessions", {
        method: "POST",
        headers: { origin: "https://app.test", cookie: "infinity_csrf=csrf-1", "x-csrf-token": "csrf-1" },
      }),
      env,
    );
    expect(accepted).toBeNull();
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

  it("closes the retired D1-only Worker protocol", async () => {
    const response = await worker.fetch(
      new Request("https://app.test/api/worker/v1/poll", {
        method: "POST",
        body: JSON.stringify({ available_slots: 1 }),
        headers: { "content-type": "application/json" },
      }),
      testEnv(),
    );
    expect(response.status).toBe(410);
    expect(await response.json()).toMatchObject({ error: { code: "LEGACY_WORKER_PROTOCOL_DISABLED" } });
  });

  it("routes Worker v2 through credential authentication instead of browser cookies", async () => {
    const response = await worker.fetch(
      new Request("https://app.test/api/worker/v2/heartbeat", { method: "POST" }),
      testEnv(),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "WORKER_AUTH_REQUIRED" } });
  });

  it("rejects plaintext requests through the retired Worker protocol", async () => {
    const response = await worker.fetch(
      new Request("http://app.test/api/worker/v1/health"),
      testEnv(),
    );
    expect(response.status).toBe(410);
    expect(await response.json()).toMatchObject({ error: { code: "LEGACY_WORKER_PROTOCOL_DISABLED" } });
  });

  it("does not enroll through the retired D1-only protocol", async () => {
    const response = await worker.fetch(
      new Request("https://app.test/api/worker/v1/enroll", {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "content-type": "application/json" },
      }),
      testEnv(),
    );
    expect(response.status).toBe(410);
    expect(await response.json()).toMatchObject({ error: { code: "LEGACY_WORKER_PROTOCOL_DISABLED" } });
  });

  it("falls back to the Next static export for product pages", async () => {
    const response = await worker.fetch(new Request("https://app.test/"), testEnv());
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("static asset");
  });

  it("serves the dynamic task detail shell without changing the browser URL", async () => {
    let requestedPath = "";
    const env = testEnv();
    env.ASSETS = {
      fetch: async (request: Request) => {
        requestedPath = new URL(request.url).pathname;
        return new Response("task shell");
      },
    } as unknown as typeof env.ASSETS;

    const response = await worker.fetch(new Request("https://app.test/task-center/tasks/task-123/"), env);
    expect(response.status).toBe(200);
    expect(requestedPath).toBe("/task-center/tasks/preview/");
  });
});
