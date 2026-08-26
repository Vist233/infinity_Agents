import type { Env } from "./env";
import {
  claimPaperCleanupJob,
  completePaperCleanupJob,
  failPaperCleanupJob,
  listDuePaperCleanupJobs,
  reclaimStalePaperCleanupJobs,
  recordPaperAuditEvent,
} from "./db";
import { deletePaperObjects } from "./paper-object-store";

const BATCH_SIZE = 10;

/**
 * Retry-safe scheduled cleanup for deleted Paper resources. The job contains
 * only a resource ID; the object store reconstructs the fixed server-side
 * namespace and never accepts a user-supplied key or prefix.
 */
export async function runPaperResourceCleanup(env: Env, now = Math.floor(Date.now() / 1000)): Promise<number> {
  await reclaimStalePaperCleanupJobs(env, now);
  const jobs = await listDuePaperCleanupJobs(env, now, BATCH_SIZE);
  let completed = 0;
  for (const job of jobs) {
    if (!(await claimPaperCleanupJob(env, job.cleanup_id, now))) continue;
    try {
      await deletePaperObjects(env, job.resource_id);
      await completePaperCleanupJob(env, job.cleanup_id, now);
      await recordPaperAuditEvent(env, {
        resource_id: job.resource_id,
        attempt_id: null,
        stage: "cleanup",
        outcome: "succeeded",
        error_code: null,
        metadata_json: JSON.stringify({ attempt: job.attempts + 1 }),
        created_at: now,
      });
      completed += 1;
    } catch {
      await failPaperCleanupJob(env, job.cleanup_id, "PAPER_CLEANUP_FAILED", now);
      await recordPaperAuditEvent(env, {
        resource_id: job.resource_id,
        attempt_id: null,
        stage: "cleanup",
        outcome: "failed",
        error_code: "PAPER_CLEANUP_FAILED",
        metadata_json: JSON.stringify({ attempt: job.attempts + 1 }),
        created_at: now,
      });
    }
  }
  return completed;
}
