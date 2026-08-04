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
});

describe("friendly chat error", () => {
  it("maps paper authorization error", () => {
    expect(toFriendlyChatError("paper_not_authorized_for_session")).toContain("当前会话可访问范围");
  });

  it("returns original message for unknown errors", () => {
    expect(toFriendlyChatError("plain error")).toBe("plain error");
  });
});
