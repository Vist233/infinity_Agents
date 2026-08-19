import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { makeEnv } from "./fake-d1";

describe("retired D1-only Worker handshake", () => {
  it.each([
    "/api/worker/v1/connect",
    "/api/worker/v1/heartbeat",
    "/api/worker/v1/disconnect",
  ])("rejects %s instead of creating a D1 session", async (pathname) => {
    const { env, db } = makeEnv();
    const response = await worker.fetch(new Request(`https://app.test${pathname}`, { method: "POST" }), env);

    expect(response.status).toBe(410);
    expect(await response.json()).toMatchObject({ error: { code: "LEGACY_WORKER_PROTOCOL_DISABLED" } });
    expect(db.workerSessions.size).toBe(0);
  });
});
