import {
  chatReducer,
  DEFAULT_RUN_STATE,
  INITIAL_CHAT_STATE,
  deriveSessionTitle,
  getMessagesForSession,
  isDefaultSessionTitle,
} from "@/lib/chat-state";
import { describe, expect, it } from "vitest";

describe("chatReducer", () => {
  it("sets input text", () => {
    const state = chatReducer(INITIAL_CHAT_STATE, { type: "set_input", input: "hello" });
    expect(state.input).toBe("hello");
  });

  it("upserts session to top", () => {
    const next = chatReducer(INITIAL_CHAT_STATE, {
      type: "upsert_session",
      toTop: true,
      session: { session_id: "s1", title: "A", created_at: "", updated_at: "" },
    });
    expect(next.sessions[0]?.session_id).toBe("s1");
  });

  it("updates assistant content in message map", () => {
    const state1 = chatReducer(INITIAL_CHAT_STATE, {
      type: "set_session_messages",
      sessionId: "s1",
      messages: [{ role: "user", content: "hi" }],
    });
    const state2 = chatReducer(state1, {
      type: "update_session_messages",
      sessionId: "s1",
      updater: (prev) => [...prev, { role: "assistant", content: "hello" }],
    });
    expect(getMessagesForSession(state2, "s1")).toHaveLength(2);
    expect(getMessagesForSession(state2, "s1")[1].role).toBe("assistant");
  });

  it("patches run state with defaults", () => {
    const state = chatReducer(INITIAL_CHAT_STATE, {
      type: "patch_session_run_state",
      sessionId: "s1",
      patch: { running: true, phase: "thinking" },
    });
    expect(state.sessionRunMap.s1.running).toBe(true);
    expect(state.sessionRunMap.s1.attempt).toBe(DEFAULT_RUN_STATE.attempt);
  });

  it("removes session related state", () => {
    const withSession = {
      ...INITIAL_CHAT_STATE,
      sessionId: "s1",
      sessions: [{ session_id: "s1", title: "T", created_at: "", updated_at: "" }],
      sessionMessagesMap: { s1: [{ role: "user" as const, content: "x" }] },
      sessionRunMap: { s1: DEFAULT_RUN_STATE },
    };
    const next = chatReducer(withSession, { type: "remove_session", sessionId: "s1" });
    expect(next.sessions).toHaveLength(0);
    expect(next.sessionMessagesMap.s1).toBeUndefined();
    expect(next.sessionRunMap.s1).toBeUndefined();
    expect(next.sessionId).toBeNull();
  });
});

describe("title helpers", () => {
  it("derives bounded session title", () => {
    const long = "a".repeat(40);
    expect(deriveSessionTitle(long)).toHaveLength(35);
  });

  it("detects default titles", () => {
    expect(isDefaultSessionTitle("new chat")).toBe(true);
    expect(isDefaultSessionTitle("custom title")).toBe(false);
  });
});
