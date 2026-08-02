import {
  createSession,
  deleteSession,
  listSessionMessages,
  listSessionUploadedPapers,
  listSessions,
  updateSessionTitle,
  uploadSessionPaper,
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

  it("returns no uploaded papers (upload disabled in v1)", async () => {
    const papers = await listSessionUploadedPapers("http://localhost:8008", "s1");
    expect(papers).toHaveLength(0);
  });

  it("rejects paper upload (unsupported in v1)", async () => {
    const file = new File(["%PDF-1.4"], "paper.pdf", { type: "application/pdf" });
    await expect(uploadSessionPaper("http://localhost:8008", "s1", file)).rejects.toMatchObject({
      status: 400,
      detail: "upload_unsupported",
    });
  });
});
