import type { Env } from "./env";

const DEFAULT_BATCH_SIZE = 25;
const MAX_BATCH_SIZE = 100;
const MAX_ERROR_LENGTH = 240;
const ALLOWED_EVENT_TYPES = new Set([
  "task_queued",
  "task_claimed",
  "task_running",
  "task_succeeded",
  "task_failed",
  "task_cancelled",
]);

interface OutboxRow {
  event_id: string;
  idempotency_key: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  payload_json: string;
  attempts: number;
}

interface RelayEvent {
  event_id: string;
  idempotency_key: string;
  task_id: string;
  event_type: string;
  pool_id: "public-default";
  created_at: number;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function configuredBatchSize(env: Env): number {
  const value = Number(env.OUTBOX_RELAY_BATCH_SIZE ?? String(DEFAULT_BATCH_SIZE));
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, MAX_BATCH_SIZE) : DEFAULT_BATCH_SIZE;
}

function changed(result: D1Result<unknown>): number {
  return Number(result.meta?.changes ?? 0);
}

function errorText(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value.replace(/\s+/g, " ").slice(0, MAX_ERROR_LENGTH) || "outbox relay failed";
}

function asRelayEvent(row: OutboxRow, createdAt: number): RelayEvent {
  if (row.aggregate_type !== "task" || !ALLOWED_EVENT_TYPES.has(row.event_type)) {
    throw new Error("INVALID_OUTBOX_EVENT");
  }
  let payload: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.payload_json) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>;
  } catch {
    throw new Error("INVALID_OUTBOX_EVENT");
  }
  const taskId = typeof payload.task_id === "string" && payload.task_id ? payload.task_id : row.aggregate_id;
  const poolId = payload.pool_id ?? payload.execution_pool_id ?? "public-default";
  if (!taskId || poolId !== "public-default") throw new Error("INVALID_OUTBOX_EVENT");
  return {
    event_id: row.event_id,
    idempotency_key: row.idempotency_key,
    task_id: taskId,
    event_type: row.event_type,
    pool_id: "public-default",
    created_at: createdAt,
  };
}

async function hmacSha256Hex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function relayRequestSignature(secret: string, timestamp: string, body: string): Promise<string> {
  return hmacSha256Hex(secret, `${timestamp}\nPOST\n/v1/events\n${body}`);
}

async function publish(env: Env, event: RelayEvent): Promise<void> {
  if (!env.REDIS_RELAY_URL || !env.REDIS_RELAY_PUBLISH_SECRET) throw new Error("RELAY_NOT_CONFIGURED");
  const body = JSON.stringify(event);
  const timestamp = String(nowSeconds());
  const signature = await relayRequestSignature(env.REDIS_RELAY_PUBLISH_SECRET, timestamp, body);
  const response = await fetch(`${env.REDIS_RELAY_URL.replace(/\/$/, "")}/v1/events`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-relay-timestamp": timestamp,
      "x-relay-signature": `sha256=${signature}`,
    },
    body,
  });
  if (!response.ok) throw new Error(`RELAY_HTTP_${response.status}`);
}

async function markPublished(env: Env, row: OutboxRow, now: number): Promise<void> {
  await env.DB.prepare(
    `UPDATE outbox_events
     SET status = 'published', published_at = ?2, last_error = NULL
     WHERE event_id = ?1 AND status = 'publishing'`,
  ).bind(row.event_id, now).run();
}

async function markRetry(env: Env, row: OutboxRow, now: number, error: unknown): Promise<void> {
  const delay = Math.min(3600, 5 * (2 ** Math.min(Math.max(row.attempts, 0), 8)));
  await env.DB.prepare(
    `UPDATE outbox_events
     SET status = 'pending', next_attempt_at = ?2, last_error = ?3
     WHERE event_id = ?1 AND status = 'publishing'`,
  ).bind(row.event_id, now + delay, errorText(error)).run();
}

async function markFailed(env: Env, row: OutboxRow, error: unknown): Promise<void> {
  await env.DB.prepare(
    `UPDATE outbox_events
     SET status = 'failed', last_error = ?2
     WHERE event_id = ?1 AND status = 'publishing'`,
  ).bind(row.event_id, errorText(error)).run();
}

/** Flush a bounded batch. D1 owns the durable event; Redis is best-effort. */
export async function flushD1Outbox(env: Env, now = nowSeconds()): Promise<number> {
  if (!env.REDIS_RELAY_URL || !env.REDIS_RELAY_PUBLISH_SECRET) return 0;
  const pending = await env.DB.prepare(
    `SELECT event_id, idempotency_key, aggregate_type, aggregate_id,
            event_type, payload_json, attempts
     FROM outbox_events
     WHERE status = 'pending' AND next_attempt_at <= ?1
     ORDER BY created_at ASC, event_id ASC
     LIMIT ?2`,
  ).bind(now, configuredBatchSize(env)).all<OutboxRow>();
  let published = 0;
  for (const row of pending.results ?? []) {
    const claimed = await env.DB.prepare(
      `UPDATE outbox_events
       SET status = 'publishing', attempts = attempts + 1
       WHERE event_id = ?1 AND status = 'pending' AND next_attempt_at <= ?2`,
    ).bind(row.event_id, now).run();
    if (changed(claimed) !== 1) continue;
    try {
      const event = asRelayEvent(row, now);
      await publish(env, event);
      await markPublished(env, row, now);
      published += 1;
    } catch (error) {
      if (error instanceof Error && error.message === "INVALID_OUTBOX_EVENT") await markFailed(env, row, error);
      else await markRetry(env, row, now, error);
    }
  }
  return published;
}
