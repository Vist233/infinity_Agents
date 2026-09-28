import type { ToolTimelineEntry } from "@/lib/chat-state";

export interface PaperTaskCandidate {
  resourceId: string;
  continuationId: string | null;
  correlationId: string;
  toolCallId: string;
  materializeStatus: "succeeded";
  /** The tool result only proves that materialization was accepted; the API decides readiness. */
  readiness: "unknown";
}

const PAPER_MATERIALIZE_TOOL = "materialize_paper";
const SAFE_ID = /^\S{1,255}$/;

function safeId(value: unknown): string | null {
  return typeof value === "string" && SAFE_ID.test(value) ? value : null;
}

function parseMaterializeResult(summary: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(summary);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Rebuilds paper task identities from the durable tool timeline.
 * Only server-shaped successful materialize results create a candidate. The
 * returned object intentionally contains no provider, PDF, text, image, or
 * object-storage data.
 */
export function derivePaperTaskCandidates(timeline: ToolTimelineEntry[]): PaperTaskCandidate[] {
  const byResource = new Map<string, PaperTaskCandidate>();
  for (const entry of timeline) {
    if (entry.toolName !== PAPER_MATERIALIZE_TOOL || entry.status !== "succeeded") continue;
    const result = parseMaterializeResult(entry.summary);
    if (result?.mode !== "processing" && result?.mode !== "ready") continue;
    const resourceId = safeId(result?.resource_id);
    const correlationId = safeId(entry.correlationId);
    const toolCallId = safeId(entry.toolCallId);
    if (!resourceId || !correlationId || !toolCallId) continue;
    const continuationId = result?.continuation_id === undefined || result.continuation_id === null
      ? null
      : safeId(result.continuation_id);
    byResource.delete(resourceId);
    byResource.set(resourceId, {
      resourceId,
      continuationId,
      correlationId,
      toolCallId,
      materializeStatus: "succeeded",
      readiness: "unknown",
    });
  }
  return Array.from(byResource.values());
}
