import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { makeEnv } from "./fake-d1";

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function workerHeaders(credential: string, sessionId: string): HeadersInit {
  return { authorization: `Bearer ${credential}`, "x-worker-session": sessionId };
}

function seedSession(db: ReturnType<typeof makeEnv>["db"], input: {
  worker_id: string;
  namespace: string;
  user_id: string;
  worker_kind: "public" | "user";
  owner_user_id: string | null;
  session_id: string;
}) {
  const now = Math.floor(Date.now() / 1000);
  db.workerSessions.set(`${input.worker_id}|${input.namespace}`, {
    worker_id: input.worker_id,
    namespace: input.namespace,
    session_id: input.session_id,
    instance_id: `${input.worker_id}-instance-12345678`,
    user_id: input.user_id,
    version: "test",
    capabilities_json: "[]",
    connected_at: now,
    last_seen_at: now,
    lease_expires_at: now + 90,
    disconnected_at: null,
    worker_kind: input.worker_kind,
    pool_id: input.worker_kind === "public" ? "public-default" : null,
    owner_user_id: input.owner_user_id,
  });
}

async function seedWorker(db: ReturnType<typeof makeEnv>["db"], input: {
  worker_id: string;
  namespace: string;
  user_id: string;
  worker_kind: "public" | "user";
  owner_user_id: string | null;
  pool_id?: string | null;
  credential: string;
  session_id: string;
}) {
  db.seedPersistentWorker({
    worker_id: input.worker_id,
    namespace: input.namespace,
    user_id: input.user_id,
    credential_hash: await sha256(input.credential),
    status: "active",
    revoked_at: null,
    credential_expires_at: null,
    trust_level: "owner_trusted",
    worker_kind: input.worker_kind,
    owner_user_id: input.owner_user_id,
    pool_id: input.pool_id ?? null,
  });
  seedSession(db, input);
}

describe("owner-first public Worker routing", () => {
  it("gives an idle owner Worker the first offer and keeps other users out", async () => {
    const { env, db } = makeEnv();
    await seedWorker(db, {
      worker_id: "alice-worker",
      namespace: "alice",
      user_id: "alice",
      worker_kind: "user",
      owner_user_id: "alice",
      credential: "wc-alice",
      session_id: "alice-session-12345678",
    });
    await seedWorker(db, {
      worker_id: "public-a",
      namespace: "infinity-public",
      user_id: "system:public-workers",
      worker_kind: "public",
      owner_user_id: null,
      pool_id: "public-default",
      credential: "wc-public-a",
      session_id: "public-session-12345678",
    });
    db.seedTask("alice-task", "alice", "Alice task");
    db.seedTask("bob-task", "bob", "Bob task");

    const ownerPoll = await worker.fetch(
      new Request("https://app.test/api/worker/v1/poll", {
        method: "POST",
        headers: { ...workerHeaders("wc-alice", "alice-session-12345678"), "content-type": "application/json" },
        body: JSON.stringify({ available_slots: 1 }),
      }),
      env,
    );
    expect(ownerPoll.status).toBe(200);
    expect(await ownerPoll.json()).toMatchObject({ offers: [{ task_id: "alice-task" }] });

    const publicPoll = await worker.fetch(
      new Request("https://app.test/api/worker/v1/poll", {
        method: "POST",
        headers: { ...workerHeaders("wc-public-a", "public-session-12345678"), "content-type": "application/json" },
        body: JSON.stringify({ available_slots: 1 }),
      }),
      env,
    );
    expect(publicPoll.status).toBe(200);
    expect(await publicPoll.json()).toMatchObject({ offers: [{ task_id: "bob-task" }] });
    expect([...db.workerOffers.values()].some((offer) => offer.task_id === "alice-task" && offer.worker_kind === "public")).toBe(false);
  });

  it("falls back to a public Worker while the owner Worker is busy", async () => {
    const { env, db } = makeEnv();
    await seedWorker(db, {
      worker_id: "alice-worker",
      namespace: "alice",
      user_id: "alice",
      worker_kind: "user",
      owner_user_id: "alice",
      credential: "wc-alice-busy",
      session_id: "alice-busy-session-12345678",
    });
    await seedWorker(db, {
      worker_id: "public-b",
      namespace: "infinity-public",
      user_id: "system:public-workers",
      worker_kind: "public",
      owner_user_id: null,
      pool_id: "public-default",
      credential: "wc-public-b",
      session_id: "public-busy-session-12345678",
    });
    db.seedTask("alice-busy-task", "alice", "Alice busy task");
    db.seedWorkerAttempt({
      attempt_id: "existing-attempt",
      task_id: "other-task",
      worker_id: "alice-worker",
      namespace: "alice",
      status: "running",
      lease_expires_at: Math.floor(Date.now() / 1000) + 120,
    });

    const response = await worker.fetch(
      new Request("https://app.test/api/worker/v1/poll", {
        method: "POST",
        headers: { ...workerHeaders("wc-public-b", "public-busy-session-12345678"), "content-type": "application/json" },
        body: JSON.stringify({ available_slots: 1 }),
      }),
      env,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ offers: [{ task_id: "alice-busy-task" }] });
  });
});
