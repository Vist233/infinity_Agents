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

  it("lists uploaded papers", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ paper_id: "upload_x", original_filename: "x.pdf" }],
    } as Response);

    const papers = await listSessionUploadedPapers("http://localhost:8008", "s1");
    expect(papers).toHaveLength(1);
    expect(papers[0].paper_id).toBe("upload_x");
  });

  it("uploads session paper with multipart form", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ paper_id: "upload_y", original_filename: "y.pdf" }),
    } as Response);
    global.fetch = fetchMock;

    const file = new File(["%PDF-1.4"], "paper.pdf", { type: "application/pdf" });
    const uploaded = await uploadSessionPaper("http://localhost:8008", "s1", file);

    expect(uploaded.paper_id).toBe("upload_y");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:8008/api/sessions/s1/uploads/papers",
      expect.objectContaining({
        method: "POST",
        body: expect.any(FormData),
      }),
    );
  });
});
