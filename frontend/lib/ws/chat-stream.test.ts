import { normalizeChatEvent, toFriendlyChatError } from "@/lib/ws/chat-stream";
import { describe, expect, it } from "vitest";

describe("chat stream event normalization", () => {
  it("normalizes status events", () => {
    const event = normalizeChatEvent(
      JSON.stringify({ type: "status", phase: "thinking", elapsed_ms: 500, attempt: 1, max_attempts: 2 }),
    );
    expect(event).toMatchObject({ type: "status", phase: "thinking", elapsed_ms: 500 });
  });

  it("normalizes chunk events", () => {
    const event = normalizeChatEvent(JSON.stringify({ type: "chunk", content: "hello" }));
    expect(event).toEqual({ type: "chunk", content: "hello" });
  });

  it("normalizes only a structured task draft event for the To-Do card", () => {
    const event = normalizeChatEvent(JSON.stringify({
      type: "task_draft_created",
      draft: {
        draft_id: "draft-1",
        revision: 1,
        status: "awaiting_user_confirmation",
        title: "Method",
        goal_summary: "Run the workflow",
        method: { filename: "method.md", size_bytes: 10, preview: "# Method" },
        dataset: { resource_id: null },
        missing_inputs: ["dataset"],
      },
    }));
    expect(event).toMatchObject({ type: "task_draft_created", draft: { draft_id: "draft-1" } });
  });

  it("normalizes draft updates and cancellations", () => {
    expect(normalizeChatEvent(JSON.stringify({
      type: "task_draft_updated",
      draft: { draft_id: "draft-1", revision: 2 },
    }))?.type).toBe("task_draft_updated");
    expect(normalizeChatEvent(JSON.stringify({
      type: "task_draft_cancelled",
      draft_id: "draft-1",
      revision: 2,
      status: "cancelled",
    }))?.type).toBe("task_draft_cancelled");
  });

  it("normalizes the explicit confirmation event", () => {
    expect(normalizeChatEvent(JSON.stringify({
      type: "task_confirmed",
      task_id: "task-1",
      status: "queued",
      attempt_count: 0,
    }))).toMatchObject({ type: "task_confirmed", task_id: "task-1", status: "queued" });
  });

  it("normalizes the Cloudflare task confirmation card event", () => {
    expect(normalizeChatEvent(JSON.stringify({
      type: "task_confirmation",
      confirmation_id: "confirmation-1",
      tool_name: "request_task_creation",
      title: "Case 2",
      analysis_type: "biopython",
      research_question: "Calculate GC and length statistics",
      method_document_name: "case-2.md",
      method_document_content: "# Case 2\n\nCalculate GC and length statistics.",
      dataset_name: "case-2.zip",
    }))).toMatchObject({
      type: "task_confirmation",
      confirmation_id: "confirmation-1",
      title: "Case 2",
      method_document_content: "# Case 2\n\nCalculate GC and length statistics.",
    });
  });

  it("falls back to chunk when payload is plain text", () => {
    const event = normalizeChatEvent("raw text output");
    expect(event).toEqual({ type: "chunk", content: "raw text output" });
  });

  it("ignores invalid type", () => {
    const event = normalizeChatEvent(JSON.stringify({ type: "other", data: 1 }));
    expect(event).toBeNull();
  });
});

describe("friendly chat error", () => {
  it("maps paper authorization error", () => {
    expect(toFriendlyChatError("paper_not_authorized_for_session")).toContain("not available in the current session");
  });

  it("returns original message for unknown errors", () => {
    expect(toFriendlyChatError("plain error")).toBe("plain error");
  });
});
