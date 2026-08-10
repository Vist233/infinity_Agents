import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { makeEnv } from "./fake-d1";

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function headers(credential: string, sessionId?: string): HeadersInit {
  return {
    authorization: `Bearer ${credential}`,
    ...(sessionId ? { "x-worker-session": sessionId } : {}),
  };
}

describe("persistent Worker reverse handshake", () => {
  it("allows one active instance and rejects a second instance for the same credential", async () => {
    const { env, db } = makeEnv();
    const credential = "wc-test-credential";
    db.seedPersistentWorker({
      worker_id: "worker-a",
      namespace: "infinity",
      user_id: "user-1",
      credential_hash: await sha256(credential),
      status: "active",
      revoked_at: null,
      credential_expires_at: null,
      trust_level: "institution_trusted",
    });

    const first = await worker.fetch(
      new Request("https://app.test/api/worker/v1/connect", {
        method: "POST",
        headers: { ...headers(credential), "content-type": "application/json" },
        body: JSON.stringify({ worker_id: "worker-a", namespace: "infinity", instance_id: "instance-a-12345678" }),
      }),
      env,
    );
    expect(first.status).toBe(201);
    const firstPayload = await first.json() as { session_id: string };

    const second = await worker.fetch(
      new Request("https://app.test/api/worker/v1/connect", {
        method: "POST",
        headers: { ...headers(credential), "content-type": "application/json" },
        body: JSON.stringify({ worker_id: "worker-a", namespace: "infinity", instance_id: "instance-b-12345678" }),
      }),
      env,
    );
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ error: { code: "WORKER_ALREADY_CONNECTED" } });

    const health = await worker.fetch(
      new Request("https://app.test/api/worker/v1/health", { headers: headers(credential, firstPayload.session_id) }),
      env,
    );
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ connected: true, worker_id: "worker-a" });
  });

  it("requires the session after a persistent Worker connects", async () => {
    const { env, db } = makeEnv();
    const credential = "wc-test-credential-2";
    db.seedPersistentWorker({
      worker_id: "worker-b",
      namespace: "infinity",
      user_id: "user-1",
      credential_hash: await sha256(credential),
      status: "active",
      revoked_at: null,
      credential_expires_at: null,
      trust_level: "institution_trusted",
    });
    const response = await worker.fetch(
      new Request("https://app.test/api/worker/v1/health", { headers: headers(credential) }),
      env,
    );
    expect(response.status).toBe(428);
    expect(await response.json()).toMatchObject({ error: { code: "WORKER_SESSION_REQUIRED" } });
  });
});
