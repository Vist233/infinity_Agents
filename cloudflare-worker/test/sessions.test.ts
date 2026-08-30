import { describe, expect, it } from "vitest";
import { getSessionMessages } from "../src/sessions";
import { createPaperRequestContinuation, createPaperResource, insertChatEvent, linkPaperResource } from "../src/db";
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

  it("projects a paper task only from a durable correlated materialize result", async () => {
    const { env, db } = makeEnv();
    db.seedChatSession("s1", "user-1");
    const resource = await createPaperResource(env, {
      resource_id: "resource-1",
      session_id: "s1",
      user_id: "user-1",
      source_kind: "arxiv",
      source_ref: "1706.03762",
      canonical_ref: "1706.03762",
      title: "Attention Is All You Need",
    });
    expect(await linkPaperResource(env, "s1", resource.resource_id, "user-1", "read")).toBe(true);
    const continuation = await createPaperRequestContinuation(env, {
      continuationId: "continuation-1",
      sessionId: "s1",
      userId: "user-1",
      turnId: "turn-paper-1",
      clientRequestId: "request-paper-1",
      resource,
      now: 10,
    });
    await insertChatEvent(env, {
      session_id: "s1", turn_id: "turn-paper-1", event_type: "tool_call", role: "assistant",
      tool_call_id: "materialize-call", tool_name: "materialize_paper", tool_arguments_json: '{"paper_ref":"arxiv:1706.03762"}', status: "processing", created_at: 11,
    });
    await insertChatEvent(env, {
      session_id: "s1", turn_id: "turn-paper-1", event_type: "tool_result", role: "tool",
      tool_call_id: "materialize-call", result_summary: JSON.stringify({ mode: "processing", resource_id: resource.resource_id, continuation_id: continuation.continuation_id }), status: "succeeded", created_at: 12,
    });
    await insertChatEvent(env, {
      session_id: "s1", turn_id: "turn-paper-1", event_type: "assistant_message", role: "assistant",
      content: "现在开始下载并解析 PDF。", status: "processing", created_at: 13,
    });
    await insertChatEvent(env, {
      session_id: "s1", turn_id: "turn-prose-only", event_type: "assistant_message", role: "assistant",
      content: "resource_id=not-a-real-task; processing", status: "completed", created_at: 14,
    });

    const response = await getSessionMessages(env, USER, "s1");
    expect(response.status).toBe(200);
    const body = await response.json() as { paper_tasks: Array<Record<string, unknown>> };
    expect(body.paper_tasks).toEqual([{
      resource_id: "resource-1",
      continuation_id: "continuation-1",
      correlation_id: "turn-paper-1",
      tool_call_id: "materialize-call",
      materialize_status: "succeeded",
      readiness: "unknown",
    }]);
    expect(JSON.stringify(body)).not.toContain("object_key");
    expect(JSON.stringify(body)).not.toContain("source_ref");
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
