import type { Env } from "./env";

const DEFAULT_BATCH_SIZE = 25;
const MAX_ERROR_LENGTH = 240;

type ExpiredLeaseRow = {
  task_id: string;
  active_attempt_id: string;
  worker_id: string;
  fencing_epoch: number;
  attempt_count: number;
  max_attempts: number;
  cancel_requested_at: number | null;
};

function changed(result: unknown): number {
  return Number((result as { meta?: { changes?: number } } | null | undefined)?.meta?.changes ?? 0);
}

function boundedError(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, MAX_ERROR_LENGTH);
}

/**
 * Return expired D1 leases to the public queue or close them terminally.
 *
 * This is the only scheduler-side recovery path. It is deliberately a D1
 * batch: the Attempt transition, Task transition, Event, and Outbox hint are
 * committed together, so a dead Worker cannot leave a permanently claimed
 * task or an unannounced retry.
 */
export async function recoverExpiredLeases(env: Pick<Env, "DB">, now = Math.floor(Date.now() / 1000)): Promise<number> {
  const rows = await env.DB.prepare(
    `SELECT t.task_id, t.active_attempt_id, a.worker_id, a.fencing_epoch,
            t.attempt_count, t.max_attempts, t.cancel_requested_at
     FROM tasks t
     JOIN task_attempts a ON a.attempt_id = t.active_attempt_id
     WHERE t.execution_pool_id = 'public-default'
       AND t.status IN ('claimed', 'running')
       AND a.status IN ('claimed', 'running')
       AND NOT EXISTS (
         SELECT 1 FROM artifact_uploads u
         WHERE u.attempt_id = a.attempt_id AND u.status = 'open'
           AND u.finalize_owner IS NOT NULL
           AND u.finalize_started_at > ?1 - 3600
       )
       AND t.lease_expires_at <= ?1
       AND a.lease_expires_at <= ?1
     ORDER BY t.lease_expires_at ASC, t.task_id ASC
     LIMIT ?2`,
  ).bind(now, DEFAULT_BATCH_SIZE).all<ExpiredLeaseRow>();

  let recovered = 0;
  for (const row of rows.results ?? []) {
    const cancelled = row.cancel_requested_at != null;
    const retry = !cancelled && row.attempt_count < row.max_attempts;
    const nextStatus = cancelled ? "cancelled" : retry ? "queued" : "failed";
    const eventType = cancelled ? "task_cancelled" : retry ? "task_queued" : "task_failed";
    const message = cancelled
      ? "Task cancelled after the Worker lease expired"
      : retry
        ? "Worker lease expired; task returned to the public queue"
        : "Worker lease expired; maximum attempts reached";
    const payload = JSON.stringify({
      task_id: row.task_id,
      attempt_id: row.active_attempt_id,
      worker_id: row.worker_id,
      fencing_epoch: row.fencing_epoch,
      status: nextStatus,
      pool_id: "public-default",
      reason: "lease_expired",
    });
    const results = await env.DB.batch([
      env.DB.prepare(
        `UPDATE task_attempts
         SET status = 'expired', error_code = 'lease_expired',
             error_message = ?2, updated_at = ?3, finished_at = ?3
         WHERE attempt_id = ?1 AND task_id = ?4
           AND status IN ('claimed', 'running') AND lease_expires_at <= ?3`,
      ).bind(row.active_attempt_id, boundedError(message), now, row.task_id),
      env.DB.prepare(
        `UPDATE tasks
         SET status = ?2, error_message = ?3,
             active_attempt_id = NULL, lease_worker_id = NULL,
             lease_token_hash = NULL, lease_expires_at = NULL,
             updated_at = ?4,
             finished_at = CASE WHEN ?2 IN ('queued') THEN NULL ELSE ?4 END
         WHERE task_id = ?1 AND active_attempt_id = ?5
           AND status IN ('claimed', 'running') AND lease_expires_at <= ?4
           AND EXISTS (
             SELECT 1 FROM task_attempts
             WHERE attempt_id = ?5 AND status = 'expired'
           )`,
      ).bind(row.task_id, nextStatus, boundedError(message), now, row.active_attempt_id),
      env.DB.prepare(
        `INSERT INTO task_events (task_event_id, task_id, event_type, event_data, created_at)
         SELECT ?1, ?2, ?3, ?4, ?5
         WHERE EXISTS (
           SELECT 1 FROM tasks WHERE task_id = ?2 AND status = ?6
             AND active_attempt_id IS NULL AND updated_at = ?5
         )`,
      ).bind(crypto.randomUUID(), row.task_id, eventType, payload, now, nextStatus),
      env.DB.prepare(
        `INSERT INTO outbox_events
          (event_id, idempotency_key, aggregate_type, aggregate_id, event_type,
           payload_json, status, attempts, next_attempt_at, created_at)
         SELECT ?1, ?2, 'task', ?3, ?4, ?5, 'pending', 0, ?6, ?6
         WHERE EXISTS (
           SELECT 1 FROM tasks WHERE task_id = ?3 AND status = ?7
             AND active_attempt_id IS NULL AND updated_at = ?6
         )`,
      ).bind(crypto.randomUUID(), `task-lease-expired:${row.active_attempt_id}:${nextStatus}`, row.task_id, eventType, payload, now, nextStatus),
    ]);
    if (changed(results[1]) === 1) recovered += 1;
  }
  return recovered;
}
