import { describe, expect, it } from "vitest";
import {
  insertChatEvent,
  listChatEvents,
  listLegacyMessages,
  MAX_INLINE_TOOL_RESULT_BYTES,
} from "../src/db";
import { makeEnv } from "./fake-d1";

const eventBase = {
  session_id: "s1",
  turn_id: "turn-1",
  created_at: 1_700_000_000,
};

describe("chat_events repository", () => {
  it("keeps an empty migrated database empty and supports chronological reads", async () => {
    const { env, db } = makeEnv();
    db.applyChatEventsMigration();
    expect(db.chatEvents).toEqual([]);

    db.seedChatSession("s1", "user-1");
    await insertChatEvent(env, {
      ...eventBase,
      event_type: "user_message",
      role: "user",
      content: "Find papers",
    });
    await insertChatEvent(env, {
      ...eventBase,
      turn_id: "turn-1",
      event_type: "assistant_message",
      role: "assistant",
      content: "I will search.",
      created_at: 1_700_000_001,
    });

    await expect(listChatEvents(env, "s1")).resolves.toMatchObject([
      { event_type: "user_message", role: "user", content: "Find papers" },
      { event_type: "assistant_message", role: "assistant", content: "I will search." },
    ]);
  });

  it("backfills multiple legacy sessions deterministically and keeps old text history readable", async () => {
    const { env, db } = makeEnv();
    db.seedChatSession("s1", "user-1");
    db.seedChatSession("s2", "user-2");
    db.addMessage("s1", "user", "first");
    db.addMessage("s2", "assistant", "second");
    db.addMessage("s1", "assistant", "third");

    db.applyChatEventsMigration();
    db.applyChatEventsMigration();

    expect(db.chatEvents).toMatchObject([
      { session_id: "s1", turn_id: "legacy:1", event_type: "user_message", role: "user", status: "legacy" },
      { session_id: "s2", turn_id: "legacy:2", event_type: "assistant_message", role: "assistant", status: "legacy" },
      { session_id: "s1", turn_id: "legacy:3", event_type: "assistant_message", role: "assistant", status: "legacy" },
    ]);
    expect(db.chatEvents).toHaveLength(3);
    await expect(listLegacyMessages(env, "s1")).resolves.toEqual([
      expect.objectContaining({ role: "user", content: "first" }),
      expect.objectContaining({ role: "assistant", content: "third" }),
    ]);
  });

  it("rejects duplicate tool-call IDs within one session", async () => {
    const { env, db } = makeEnv();
    db.seedChatSession("s1", "user-1");
    const call = {
      ...eventBase,
      event_type: "tool_call" as const,
      role: "assistant" as const,
      tool_call_id: "call-1",
      tool_name: "search_paper",
      tool_arguments_json: '{"query":"attention"}',
    };
    await insertChatEvent(env, call);
    await expect(insertChatEvent(env, { ...call, turn_id: "turn-2" })).rejects.toThrow("Duplicate tool call ID");
  });

  it("writes a tool result once and makes a retry idempotent", async () => {
    const { env, db } = makeEnv();
    db.seedChatSession("s1", "user-1");
    await insertChatEvent(env, {
      ...eventBase,
      event_type: "tool_call",
      role: "assistant",
      tool_call_id: "call-once",
      tool_name: "search_paper",
      tool_arguments_json: "{}",
    });
    const result = {
      ...eventBase,
      event_type: "tool_result" as const,
      role: "tool" as const,
      tool_call_id: "call-once",
      result_summary: "first",
      status: "succeeded",
    };
    await insertChatEvent(env, result);
    await insertChatEvent(env, { ...result, result_summary: "retry" });
    expect(db.chatEvents.filter((event) => event.event_type === "tool_result")).toHaveLength(1);
    expect(db.chatEvents.find((event) => event.event_type === "tool_result")?.result_summary).toBe("first");
  });

  it("rejects a result whose call belongs to another session", async () => {
    const { env, db } = makeEnv();
    db.seedChatSession("s1", "user-1");
    db.seedChatSession("s2", "user-2");
    await insertChatEvent(env, {
      ...eventBase,
      event_type: "tool_call",
      role: "assistant",
      tool_call_id: "foreign-call",
      tool_name: "search_paper",
      tool_arguments_json: "{}",
    });
    await expect(insertChatEvent(env, {
      ...eventBase,
      session_id: "s2",
      event_type: "tool_result",
      role: "tool",
      tool_call_id: "foreign-call",
      result_summary: "must not cross sessions",
    })).rejects.toThrow("Tool call not found for session");
  });

  it("rejects a foreign session before insertion", async () => {
    const { env } = makeEnv();
    await expect(insertChatEvent(env, {
      ...eventBase,
      session_id: "not-owned-or-missing",
      event_type: "user_message",
      role: "user",
      content: "do not insert",
    })).rejects.toThrow("Chat session not found");
  });

  it("rejects invalid event types and role/event pairs", async () => {
    const { env, db } = makeEnv();
    db.seedChatSession("s1", "user-1");
    await expect(insertChatEvent(env, {
      ...eventBase,
      event_type: "not-an-event" as never,
      role: "user",
      content: "invalid",
    })).rejects.toThrow("Invalid chat event type");
    await expect(insertChatEvent(env, {
      ...eventBase,
      event_type: "user_message",
      role: "assistant",
      content: "invalid role",
    })).rejects.toThrow("Invalid chat event role");
  });

  it("does not accept an oversized tool result as an inline payload", async () => {
    const { env, db } = makeEnv();
    db.seedChatSession("s1", "user-1");
    await expect(insertChatEvent(env, {
      ...eventBase,
      event_type: "tool_result",
      role: "tool",
      tool_call_id: "call-1",
      result_summary: "x".repeat(MAX_INLINE_TOOL_RESULT_BYTES + 1),
    })).rejects.toThrow("Inline tool result exceeds");
  });
});
