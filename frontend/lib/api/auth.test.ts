import { afterEach, describe, expect, it, vi } from "vitest";
import { getCurrentUser } from "./auth";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("getCurrentUser", () => {
  it("reads the Cloudflare /api/me user envelope", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ user: { id: "user-1", email: "user@example.com", name: "User One" } }),
    });
    global.fetch = fetchMock as typeof fetch;

    await expect(getCurrentUser()).resolves.toEqual({
      id: "user-1",
      email: "user@example.com",
      name: "User One",
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/me", { credentials: "include" });
  });

  it("falls back to the local FastAPI /auth/me shape", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 404 })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ user_id: "local-user", email: "local@example.com" }),
      });
    global.fetch = fetchMock as typeof fetch;

    await expect(getCurrentUser()).resolves.toEqual({
      id: "local-user",
      email: "local@example.com",
    });
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/auth/me", { credentials: "include" });
  });
});
