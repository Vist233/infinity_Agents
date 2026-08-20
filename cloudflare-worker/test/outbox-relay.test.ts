import { describe, expect, it, vi } from "vitest";
import { flushD1Outbox } from "../src/outbox-relay";
import { makeEnv } from "./fake-d1";

type OutboxRow = {
  event_id: string;
  idempotency_key: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  payload_json: string;
  status: string;
  attempts: number;
  publishing_started_at?: number | null;
  publishing_owner?: string | null;
};

class OutboxDb {
  constructor(public rows: OutboxRow[]) {}

  prepare(sql: string) {
    const db = this;
    let args: unknown[] = [];
    return {
      bind(...values: unknown[]) {
        args = values;
        return this;
      },
      async all<T>() {
        return { results: db.rows.filter((row) => row.status === "pending") as T[], success: true, meta: { changes: 0 } };
      },
      async run() {
        if (sql.includes("stale publishing claim recovered")) {
          const cutoff = Number(args[1]);
          let changes = 0;
          for (const candidate of db.rows) {
            if (candidate.status === "publishing" && (candidate.publishing_started_at == null || candidate.publishing_started_at <= cutoff)) {
              candidate.status = "pending";
              candidate.publishing_started_at = null;
              candidate.publishing_owner = null;
              changes += 1;
            }
          }
          return { success: true, meta: { changes } };
        }
        const eventId = String(args[0]);
        const row = db.rows.find((candidate) => candidate.event_id === eventId);
        if (!row) return { success: true, meta: { changes: 0 } };
        if (sql.includes("SET status = 'publishing'")) {
          if (row.status !== "pending") return { success: true, meta: { changes: 0 } };
          row.status = "publishing";
          row.attempts += 1;
          row.publishing_started_at = Number(args[1]);
          row.publishing_owner = String(args[2]);
          return { success: true, meta: { changes: 1 } };
        }
        if (sql.includes("SET status = 'published'")) {
          if (row.status !== "publishing" || row.publishing_owner !== String(args[2])) return { success: true, meta: { changes: 0 } };
          row.status = "published";
          row.publishing_started_at = null;
          row.publishing_owner = null;
          return { success: true, meta: { changes: 1 } };
        }
        if (sql.includes("SET status = 'failed'")) {
          if (row.status !== "publishing" || row.publishing_owner !== String(args[2])) return { success: true, meta: { changes: 0 } };
          row.status = "failed";
          row.publishing_owner = null;
          return { success: true, meta: { changes: 1 } };
        }
        if (row.status !== "publishing" || row.publishing_owner !== String(args[3])) return { success: true, meta: { changes: 0 } };
        row.status = "pending";
        row.publishing_owner = null;
        return { success: true, meta: { changes: 1 } };
      },
    };
  }
}

describe("D1 outbox to Redis Relay", () => {
  it("claims, signs, publishes, and releases a fixed task hint", async () => {
    const db = new OutboxDb([{
      event_id: "event-1",
      idempotency_key: "task-queued:task-1",
      aggregate_type: "task",
      aggregate_id: "task-1",
      event_type: "task_queued",
      payload_json: JSON.stringify({ task_id: "task-1", pool_id: "public-default", status: "queued" }),
      status: "pending",
      attempts: 0,
    }]);
    const { env } = makeEnv({
      DB: db as unknown as typeof env.DB,
      REDIS_RELAY_URL: "https://relay.test",
      REDIS_RELAY_PUBLISH_SECRET: "relay-secret",
    });
    const calls: Request[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(new Request(input, init));
      return new Response(JSON.stringify({ accepted: true, duplicate: false }), { status: 200 });
    });

    await expect(flushD1Outbox(env, 1_700_000_000)).resolves.toBe(1);
    expect(db.rows[0].status).toBe("published");
    expect(db.rows[0].attempts).toBe(1);
    expect(calls).toHaveLength(1);
    const body = await calls[0].json() as Record<string, unknown>;
    expect(body).toEqual({
      event_id: "event-1",
      idempotency_key: "task-queued:task-1",
      task_id: "task-1",
      event_type: "task_queued",
      pool_id: "public-default",
      created_at: 1_700_000_000,
    });
    expect(calls[0].headers.get("x-relay-signature")).toMatch(/^sha256=[a-f0-9]{64}$/);
    vi.unstubAllGlobals();
  });

  it("marks an unsupported outbox aggregate failed instead of sending arbitrary data", async () => {
    const db = new OutboxDb([{
      event_id: "event-invalid",
      idempotency_key: "invalid-1",
      aggregate_type: "user",
      aggregate_id: "user-1",
      event_type: "user_secret",
      payload_json: JSON.stringify({ password: "must-not-leave-d1" }),
      status: "pending",
      attempts: 0,
    }]);
    const { env } = makeEnv({
      DB: db as unknown as typeof env.DB,
      REDIS_RELAY_URL: "https://relay.test",
      REDIS_RELAY_PUBLISH_SECRET: "relay-secret",
    });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(flushD1Outbox(env, 1_700_000_000)).resolves.toBe(0);
    expect(db.rows[0].status).toBe("failed");
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("recovers an expired publishing claim and republishes it once", async () => {
    const db = new OutboxDb([{
      event_id: "event-stale",
      idempotency_key: "task-queued:task-stale",
      aggregate_type: "task",
      aggregate_id: "task-stale",
      event_type: "task_queued",
      payload_json: JSON.stringify({ task_id: "task-stale", pool_id: "public-default" }),
      status: "publishing",
      attempts: 1,
      publishing_started_at: 1_699_999_000,
    }]);
    const { env } = makeEnv({
      DB: db as unknown as ReturnType<typeof makeEnv>["env"]["DB"],
      REDIS_RELAY_URL: "https://relay.test",
      REDIS_RELAY_PUBLISH_SECRET: "relay-secret",
    });
    const fetchSpy = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    await expect(flushD1Outbox(env, 1_700_000_000)).resolves.toBe(1);
    expect(db.rows[0]).toMatchObject({ status: "published", attempts: 2, publishing_started_at: null });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("does not let a stale publisher finish a newer claim", async () => {
    const row: OutboxRow = {
      event_id: "event-race",
      idempotency_key: "task-queued:task-race",
      aggregate_type: "task",
      aggregate_id: "task-race",
      event_type: "task_queued",
      payload_json: JSON.stringify({ task_id: "task-race", pool_id: "public-default" }),
      status: "pending",
      attempts: 0,
    };
    const db = new OutboxDb([row]);
    const { env } = makeEnv({
      DB: db as unknown as ReturnType<typeof makeEnv>["env"]["DB"],
      REDIS_RELAY_URL: "https://relay.test",
      REDIS_RELAY_PUBLISH_SECRET: "relay-secret",
    });
    vi.stubGlobal("fetch", async () => {
      row.publishing_owner = "newer-owner";
      return new Response("{}", { status: 200 });
    });
    await expect(flushD1Outbox(env, 1_700_000_000)).resolves.toBe(0);
    expect(row).toMatchObject({ status: "publishing", publishing_owner: "newer-owner" });
    vi.unstubAllGlobals();
  });
});
