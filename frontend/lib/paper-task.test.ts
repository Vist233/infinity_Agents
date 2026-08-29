import { describe, expect, it } from "vitest";
import { derivePaperTaskCandidates } from "@/lib/paper-task";
import type { ToolTimelineEntry } from "@/lib/chat-state";

const materialize = (overrides: Partial<ToolTimelineEntry> = {}): ToolTimelineEntry => ({
  correlationId: "turn-1",
  toolCallId: "call-1",
  toolName: "materialize_paper",
  status: "succeeded",
  summary: JSON.stringify({ mode: "processing", resource_id: "resource-1", continuation_id: "continuation-1" }),
  ...overrides,
});

describe("durable Paper task correlation", () => {
  it("creates an accepted task without treating a successful materialize as ready", () => {
    const [candidate] = derivePaperTaskCandidates([materialize()]);

    expect(candidate).toMatchObject({
      resourceId: "resource-1",
      continuationId: "continuation-1",
      correlationId: "turn-1",
      toolCallId: "call-1",
      materializeStatus: "succeeded",
      readiness: "unknown",
    });
    expect(candidate).not.toHaveProperty("pdf_object_key");
    expect(candidate).not.toHaveProperty("full_text");
  });

  it("does not invent a task from prose-only, failed, malformed, or non-paper tool results", () => {
    const timeline: ToolTimelineEntry[] = [
      materialize({ toolCallId: "prose", summary: "开始下载并解析 PDF" }),
      materialize({ toolCallId: "failed", status: "failed", summary: JSON.stringify({ error: "failed" }) }),
      materialize({ toolCallId: "malformed", summary: JSON.stringify({ mode: "processing" }) }),
      materialize({ toolCallId: "search", toolName: "search_paper" }),
    ];

    expect(derivePaperTaskCandidates(timeline)).toEqual([]);
  });

  it("keeps the newest accepted correlation for the same resource and never derives readiness from mode", () => {
    const candidates = derivePaperTaskCandidates([
      materialize(),
      materialize({
        correlationId: "turn-2",
        toolCallId: "call-2",
        summary: JSON.stringify({ mode: "ready", resource_id: "resource-1", continuation_id: "continuation-2" }),
      }),
    ]);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      correlationId: "turn-2",
      toolCallId: "call-2",
      continuationId: "continuation-2",
      readiness: "unknown",
    });
  });
});
