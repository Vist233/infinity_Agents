/**
 * The only post-max recovery allowance is one requeue for the exact attempt
 * that the lease reaper marked `lease_expired` after a max-attempt override.
 * The event marker is the durable, idempotent counter; no mutable task field
 * or caller-supplied retry count can increase this limit.
 */
export const LEASE_EXPIRED_RECOVERY_LIMIT = 1;

export function taskRetryEventId(taskId: string, attemptCount: number): string {
  return `task-requeued:${taskId}:${attemptCount}`;
}

export function maxRetryOverrideEventId(taskId: string, maxAttempts: number): string {
  return taskRetryEventId(taskId, maxAttempts);
}

export function leaseExpiredRecoveryEventId(taskId: string, attemptCount: number): string {
  return `task-requeued:lease-expired-recovery:${taskId}:${attemptCount}`;
}
