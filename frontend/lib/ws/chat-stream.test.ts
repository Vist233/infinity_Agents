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

  it("falls back to chunk when payload is plain text", () => {
    const event = normalizeChatEvent("raw text output");
    expect(event).toEqual({ type: "chunk", content: "raw text output" });
  });

  it("ignores invalid type", () => {
    const event = normalizeChatEvent(JSON.stringify({ type: "other", data: 1 }));
    expect(event).toBeNull();
  });

  it("normalizes inline task confirmation events", () => {
    expect(normalizeChatEvent(JSON.stringify({
      type: "task_confirmation",
      confirmation_id: "c1",
      tool_name: "request_task_creation",
      title: "Trait extraction",
    }))).toMatchObject({
      type: "task_confirmation",
      confirmation_id: "c1",
      title: "Trait extraction",
      analysis_type: "generic",
    });
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
