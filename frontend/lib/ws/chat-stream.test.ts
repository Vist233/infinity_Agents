import { consumeChatEventStream, normalizeChatEvent, toFriendlyChatError } from "@/lib/ws/chat-stream";
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

  it("normalizes correlated tool calls and bounded results", () => {
    const call = normalizeChatEvent(JSON.stringify({
      type: "tool_call",
      correlation_id: "client:turn-1",
      tool_call_id: "call-1",
      tool_name: "read_paper",
      status: "pending",
      arguments_summary: JSON.stringify({ paper_id: "p1" }),
    }));
    expect(call).toMatchObject({
      type: "tool_call",
      correlation_id: "client:turn-1",
      tool_call_id: "call-1",
      tool_name: "read_paper",
      status: "pending",
    });

    const result = normalizeChatEvent(JSON.stringify({
      type: "tool_result",
      correlation_id: "client:turn-1",
      tool_call_id: "call-1",
      tool_name: "read_paper",
      status: "succeeded",
      summary: "x".repeat(20_000),
    }));
    expect(result?.type).toBe("tool_result");
    expect((result as { summary?: string }).summary?.length).toBeLessThanOrEqual(2048);
  });

  it("normalizes a durable paper processing event without treating it as assistant prose", () => {
    expect(normalizeChatEvent(JSON.stringify({
      type: "paper_processing",
      correlation_id: "client:paper-1",
      continuation_id: "continuation-1",
      resource_id: "resource-1",
      status: "extracting",
      message: "Paper processing is durable and can be resumed.",
    }))).toMatchObject({
      type: "paper_processing",
      correlation_id: "client:paper-1",
      continuation_id: "continuation-1",
      resource_id: "resource-1",
      status: "extracting",
    });
  });

  it("rejects a paper processing event without a correlation or valid lifecycle status", () => {
    expect(normalizeChatEvent(JSON.stringify({
      type: "paper_processing",
      continuation_id: "continuation-1",
      resource_id: "resource-1",
      status: "extracting",
      message: "progress",
    }))).toBeNull();
    expect(normalizeChatEvent(JSON.stringify({
      type: "paper_processing",
      correlation_id: "client:paper-1",
      continuation_id: null,
      resource_id: null,
      status: "complete",
      message: "progress",
    }))).toBeNull();
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

  it("ignores malformed structured SSE instead of treating it as assistant text", () => {
    expect(normalizeChatEvent('{"type":"tool_result"')).toBeNull();
  });

  it("does not accept a tool result without a call correlation", () => {
    expect(normalizeChatEvent(JSON.stringify({ type: "tool_result", status: "succeeded", summary: "x" }))).toBeNull();
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

describe("continuation SSE consumption", () => {
  it("parses the same bounded event contract used by the chat stream", async () => {
    const events: string[] = [];
    await consumeChatEventStream(
      new Response([
        `data: ${JSON.stringify({ type: "chunk", content: "page text" })}\n\n`,
        `data: ${JSON.stringify({ type: "done" })}\n\n`,
      ].join(""), { headers: { "content-type": "text/event-stream" } }),
      (event) => {
        if (event.type === "chunk") events.push(event.content);
      },
    );
    expect(events).toEqual(["page text"]);
  });
});
