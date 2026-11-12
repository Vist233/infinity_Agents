const REPLACEMENT_WAIT_MS = 1000;
const MAX_REPLACEMENT_WAIT_MS = 60_000;
const MAX_DOUBLINGS = 10;

/**
 * How long to wait before an agent that failed is replaced: `baseMs`, doubled with every failure in a row, up to a minute. An agent that finished
 * normally is replaced at once. Without the wait a broken connection makes every replacement fail at once and the run replaces agents in a storm.
 */
export function replacementWait(failedAgent: boolean, consecutiveFailures: number, baseMs: number = REPLACEMENT_WAIT_MS): number {
  if (!failedAgent) return 0;
  return Math.min(MAX_REPLACEMENT_WAIT_MS, baseMs * 2 ** Math.min(Math.max(consecutiveFailures - 1, 0), MAX_DOUBLINGS));
}
