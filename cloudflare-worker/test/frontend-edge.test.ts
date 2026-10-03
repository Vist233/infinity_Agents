import { describe, it, expect, vi } from "vitest";
import edge from "../src/frontend-edge";
import type { Env } from "../src/env";

function env(): Env {
  return { ASSETS: { fetch: vi.fn(async () => new Response("static page")) } } as unknown as Env;
}

describe("frontend with ImageJudge compatibility", () => {
  it("serves static product entry points", async () => {
    const bindings = env();
    for (const path of ["/", "/task-center/", "/papers/", "/image-judge/"]) {
      const response = await edge.fetch(new Request(`https://infinity.zhangyvjing.com${path}`), bindings);
      expect(await response.text()).toBe("static page");
    }
  });
  it("rejects old cloud protocols without accessing assets or the database", async () => {
    const bindings = env();
    for (const path of ["/api/tasks/direct", "/api/worker/v2/connect", "/api/paper-processor/connect", "/api/discovery/papers", "/api/chat"]) {
      const response = await edge.fetch(new Request(`https://infinity.zhangyvjing.com${path}`, { method: "POST" }), bindings);
      expect(response.status).toBe(410);
      expect(await response.json()).toMatchObject({ error: "LOCAL_RUNTIME_REQUIRED" });
    }
    expect(bindings.ASSETS.fetch).not.toHaveBeenCalled();
  });
  it("preserves ImageJudge health and authentication boundaries", async () => {
    const bindings = env();
    const health = await edge.fetch(new Request("https://infinity.zhangyvjing.com/image-judge/healthz"), bindings);
    expect(health.status).toBe(200);
    const authorize = await edge.fetch(new Request("https://infinity.zhangyvjing.com/image-judge/desktop/authorize"), bindings);
    expect(authorize.status).toBe(503);
    expect(bindings.ASSETS.fetch).not.toHaveBeenCalled();
  });
  it("does not export the old scheduled dispatcher", () => {
    expect("scheduled" in edge).toBe(false);
  });
});
