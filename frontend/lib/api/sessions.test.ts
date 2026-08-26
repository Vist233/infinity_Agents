import {
  createSession,
  deleteSession,
  listSessionHistory,
  listSessionMessages,
  listSessions,
  updateSessionTitle,
} from "@/lib/api/sessions";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("sessions api", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    vi.restoreAllMocks();
    global.fetch = originalFetch;
  });

  it("lists sessions", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ session_id: "s1", title: "a", created_at: "", updated_at: "" }],
    } as Response);

    const sessions = await listSessions("http://localhost:8008");
    expect(sessions).toHaveLength(1);
    expect(sessions[0].session_id).toBe("s1");
  });

  it("creates session", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ session_id: "s2", storage_mode: "sandboxed" }),
    } as Response);

    const result = await createSession("http://localhost:8008");
    expect(result.session_id).toBe("s2");
  });

  it("filters invalid message roles", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { role: "user", content: "u" },
        { role: "assistant", content: "a" },
        { role: "system", content: "ignore" },
      ],
    } as Response);

    const messages = await listSessionMessages("http://localhost:8008", "s1");
    expect(messages).toHaveLength(2);
  });

  it("hydrates only the requested session's bounded timeline and hides object keys", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        messages: [{ role: "user", content: "read" }, { role: "assistant", content: "done" }],
        events: [
          {
            session_id: "s1",
            event_id: 2,
            turn_id: "turn-1",
            event_type: "tool_call",
            tool_call_id: "call-1",
            tool_name: "read_paper",
            status: "pending",
            arguments_summary: JSON.stringify({ paper_id: "p1" }),
          },
          {
            session_id: "other-session",
            event_id: 3,
            turn_id: "turn-x",
            event_type: "tool_result",
            tool_call_id: "call-x",
            tool_name: "read_paper",
            status: "succeeded",
            summary: "foreign",
            object_key: "paper/other/source.pdf",
          },
          {
            session_id: "s1",
            event_id: 4,
            turn_id: "turn-1",
            event_type: "tool_result",
            tool_call_id: "call-1",
            tool_name: "read_paper",
            status: "succeeded",
            summary: "y".repeat(10_000),
            object_key: "paper/s1/secret.pdf",
          },
        ],
        legacy_text_only: false,
      }),
    } as Response);

    const history = await listSessionHistory("http://localhost:8008", "s1");
    expect(history.messages).toHaveLength(2);
    expect(history.timeline).toHaveLength(1);
    expect(history.timeline.every((event) => event.session_id === "s1")).toBe(true);
    expect(history.timeline[0]).toMatchObject({ status: "succeeded", summary: "y".repeat(2048) });
    expect(history.timeline[0].summary?.length).toBeLessThanOrEqual(2048);
    expect(history.timeline[0]).not.toHaveProperty("object_key");
  });

  it("marks an old text-only array response as legacy", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ role: "assistant", content: "old answer" }],
    } as Response);

    const history = await listSessionHistory("http://localhost:8008", "s1");
    expect(history.legacyTextOnly).toBe(true);
    expect(history.timeline).toEqual([]);
  });

  it("throws api error on non-2xx", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ detail: "boom" }),
      text: async () => "boom",
    } as Response);

    await expect(updateSessionTitle("http://localhost:8008", "s1", "new")).rejects.toMatchObject({
      status: 500,
      detail: "boom",
    });
  });

  it("sends delete request", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    } as Response);
    global.fetch = fetchMock;
    await deleteSession("http://localhost:8008", "s3");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:8008/api/sessions/s3",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

});
