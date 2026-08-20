import { describe, expect, it } from "vitest";
import { handleTaskApi } from "../src/tasks";
import type { AuthedUser } from "../src/auth";
import { makeEnv } from "./fake-d1";

const encryptionKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const admin: AuthedUser = { userId: "admin-1", email: "admin@example.com", sid: "sid-admin", role: "superuser" };
const ordinary: AuthedUser = { userId: "user-1", email: "user@example.com", sid: "sid-user", role: "user" };

async function call(path: string, env: Parameters<typeof handleTaskApi>[1], user: AuthedUser, init?: RequestInit) {
  const response = await handleTaskApi(new Request(`https://app.test${path}`, init), env, user);
  if (!response) throw new Error(`No route for ${path}`);
  return response;
}

describe("public Worker pool administration", () => {
  it("issues a server-controlled public-pool credential without a Namespace form", async () => {
    const { env, db } = makeEnv({ WORKER_CREDENTIAL_ENCRYPTION_KEY: encryptionKey });
    const response = await call("/api/worker-enrollments", env, ordinary, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(201);
    const payload = await response.json() as { worker_id: string; namespace: string };
    const row = db.workers.get(payload.worker_id);
    expect(row).toMatchObject({ pool_id: "public-default", namespace: "infinity-public", created_by: "user-1", status: "active" });
  });

  it("allows only verified superusers to provision persistent public Workers", async () => {
    const { env, db } = makeEnv({ WORKER_CREDENTIAL_ENCRYPTION_KEY: encryptionKey });

    const denied = await call("/api/admin/public-worker-pool", env, ordinary);
    expect(denied.status).toBe(403);

    const initial = await call("/api/admin/public-worker-pool", env, admin);
    expect(initial.status).toBe(200);
    expect(await initial.json()).toMatchObject({
      pool: { pool_id: "public-default", namespace: "infinity-public", worker_count: 0 },
      workers: [],
    });

    const first = await call("/api/admin/public-workers", env, admin, { method: "POST" });
    const firstPayload = await first.json() as { worker_id: string; namespace: string; worker_credential: string; worker_kind: string };
    expect(first.status).toBe(201);
    expect(firstPayload.worker_kind).toBe("public");
    expect(firstPayload.namespace).toBe("infinity-public");
    expect(firstPayload.worker_credential).toMatch(/^wc_/);

    const second = await call("/api/admin/public-workers", env, admin, { method: "POST" });
    const secondPayload = await second.json() as { worker_id: string; worker_credential: string };
    expect(second.status).toBe(201);
    expect(secondPayload.worker_id).not.toBe(firstPayload.worker_id);
    expect(secondPayload.worker_credential).not.toBe(firstPayload.worker_credential);

    const third = await call("/api/admin/public-workers", env, admin, { method: "POST" });
    const thirdPayload = await third.json() as { worker_id: string; namespace: string; worker_credential: string };
    expect(third.status).toBe(201);
    expect(thirdPayload.worker_id).not.toBe(firstPayload.worker_id);
    expect(thirdPayload.worker_id).not.toBe(secondPayload.worker_id);
    expect(thirdPayload.namespace).toBe(firstPayload.namespace);
    expect(thirdPayload.worker_credential).not.toBe(firstPayload.worker_credential);

    const listed = await call("/api/admin/public-worker-pool", env, admin);
    const listedPayload = await listed.json() as { workers: Array<Record<string, unknown>> };
    expect(listedPayload.workers).toHaveLength(3);
    expect(listedPayload.workers[0]).not.toHaveProperty("worker_credential");
    expect(db.workers.size).toBe(3);

    const recovered = await call(`/api/admin/public-workers/${encodeURIComponent(firstPayload.worker_id)}/credential`, env, admin);
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject({ worker_credential: firstPayload.worker_credential });

    const rotated = await call(`/api/admin/public-workers/${encodeURIComponent(firstPayload.worker_id)}/rotate`, env, admin, { method: "POST" });
    expect(rotated.status).toBe(200);
    expect((await rotated.json() as { worker_credential: string }).worker_credential).not.toBe(firstPayload.worker_credential);
    const revoked = await call(`/api/admin/public-workers/${encodeURIComponent(firstPayload.worker_id)}/revoke`, env, admin, { method: "POST" });
    expect(revoked.status).toBe(200);
    expect(db.workers.get(firstPayload.worker_id)).toMatchObject({ status: "revoked" });
    const recoveredAfterRevoke = await call(`/api/admin/public-workers/${encodeURIComponent(firstPayload.worker_id)}/credential`, env, admin);
    expect(recoveredAfterRevoke.status).toBe(404);
    expect(db.workerAdminEvents.map((event) => event.action)).toEqual([
      "created",
      "created",
      "created",
      "credential_recovered",
      "credential_rotated",
      "revoked",
    ]);
  });

  it("does not allow ordinary users to create public registrations", async () => {
    const { env } = makeEnv({ WORKER_CREDENTIAL_ENCRYPTION_KEY: encryptionKey });
    const response = await call("/api/admin/public-workers", env, ordinary, { method: "POST" });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "WORKER_ADMIN_FORBIDDEN" } });
  });

  it("creates one local public Worker with a durable encrypted credential", async () => {
    const { env, db } = makeEnv({ WORKER_CREDENTIAL_ENCRYPTION_KEY: encryptionKey });
    const response = await call("/api/admin/public-workers", env, admin, { method: "POST" });
    const payload = await response.json() as {
      worker_id: string;
      namespace: string;
      worker_credential: string;
      persistent: boolean;
      one_time: boolean;
    };

    expect(response.status).toBe(201);
    expect(payload.worker_id).toMatch(/^public-worker-/);
    expect(payload.namespace).toBe("infinity-public");
    expect(payload.worker_credential).toMatch(/^wc_/);
    expect(payload.persistent).toBe(true);
    expect(payload.one_time).toBe(false);
    expect(db.workers.get(payload.worker_id)).toMatchObject({
      pool_id: "public-default",
      credential_ciphertext: expect.stringMatching(/^v1\./),
    });
  });
});
