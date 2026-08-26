import { describe, expect, it } from "vitest";
import { getSessionMessages } from "../src/sessions";
import { insertChatEvent } from "../src/db";
import type { AuthedUser } from "../src/auth";
import { makeEnv } from "./fake-d1";

const USER: AuthedUser = { userId: "user-1", email: "demo@example.com", sid: "sid-1" };

describe("session history timeline", () => {
  it("returns safe collapsed events and text messages for an owned session", async () => {
    const { env, db } = makeEnv();
    db.seedChatSession("s1", "user-1");
    await insertChatEvent(env, {
      session_id: "s1", turn_id: "turn-1", event_type: "user_message", role: "user", content: "read", status: "completed", created_at: 1,
    });
    await insertChatEvent(env, {
      session_id: "s1", turn_id: "turn-1", event_type: "tool_call", role: "assistant", tool_call_id: "call-1", tool_name: "read_paper", tool_arguments_json: '{"paper_id":"p1"}', status: "pending", created_at: 2,
    });
    await insertChatEvent(env, {
      session_id: "s1", turn_id: "turn-1", event_type: "tool_result", role: "tool", tool_call_id: "call-1", result_summary: "x".repeat(4_000), result_object_key: "paper/s1/secret.pdf", result_bytes: 10_000, status: "succeeded", created_at: 3,
    });
    await insertChatEvent(env, {
      session_id: "s1", turn_id: "turn-1", event_type: "assistant_message", role: "assistant", content: "done", status: "completed", created_at: 4,
    });

    const response = await getSessionMessages(env, USER, "s1");
    expect(response.status).toBe(200);
    const body = await response.json() as { messages: Array<{ role: string; content: string }>; events: Array<Record<string, unknown>> };
    expect(body.messages).toEqual([{ role: "user", content: "read" }, { role: "assistant", content: "done" }]);
    expect(body.events).toHaveLength(1);
    expect(body.events[0]).toMatchObject({ event_type: "tool_call", tool_call_id: "call-1", tool_name: "read_paper", status: "succeeded" });
    expect(String(body.events[0].summary).length).toBeLessThanOrEqual(2048);
    expect(body.events[0]).not.toHaveProperty("object_key");
    expect(body.events[0]).not.toHaveProperty("tool_arguments_json");
  });

  it("does not return another user's session timeline", async () => {
    const { env, db } = makeEnv();
    db.seedChatSession("s1", "someone-else");
    const response = await getSessionMessages(env, USER, "s1");
    expect(response.status).toBe(404);
  });

  it("keeps old text-only history readable and explicitly labeled", async () => {
    const { env, db } = makeEnv();
    db.seedChatSession("s1", "user-1");
    db.addMessage("s1", "assistant", "old answer");
    const response = await getSessionMessages(env, USER, "s1");
    const body = await response.json() as { messages: unknown[]; events: unknown[]; legacy_text_only: boolean };
    expect(body.messages).toEqual([{ role: "assistant", content: "old answer" }]);
    expect(body.events).toEqual([]);
    expect(body.legacy_text_only).toBe(true);
  });
});
