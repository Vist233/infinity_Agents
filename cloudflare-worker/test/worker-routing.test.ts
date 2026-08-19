import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { makeEnv } from "./fake-d1";

describe("retired D1-only Worker routing", () => {
  it.each([
    "/api/worker/v1/poll",
    "/api/worker/v1/health",
  ])("rejects %s instead of touching D1", async (pathname) => {
    const { env, db } = makeEnv();
    const response = await worker.fetch(new Request(`https://app.test${pathname}`, { method: "POST" }), env);

    expect(response.status).toBe(410);
    expect(await response.json()).toMatchObject({ error: { code: "LEGACY_WORKER_PROTOCOL_DISABLED" } });
    expect(db.tasks.size).toBe(0);
    expect(db.workerOffers.size).toBe(0);
  });
});
