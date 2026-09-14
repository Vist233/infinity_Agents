import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTH_REQUEST_TIMEOUT_MS, getCurrentUser } from "./auth";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  vi.useRealTimers();
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
    expect(fetchMock).toHaveBeenCalledWith("/api/me", {
      credentials: "include",
      signal: expect.any(AbortSignal),
    });
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
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/auth/me", {
      credentials: "include",
      signal: expect.any(AbortSignal),
    });
  });

  it("aborts a stalled /api/me request at the authentication timeout", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | null | undefined;
    const fetchMock = vi.fn((_input: string, init?: RequestInit) => {
      signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    });
    global.fetch = fetchMock as typeof fetch;

    const request = getCurrentUser();
    const rejection = expect(request).rejects.toMatchObject({
      name: "AuthRequestTimeoutError",
      message: "Authentication request timed out",
    });
    await vi.advanceTimersByTimeAsync(AUTH_REQUEST_TIMEOUT_MS);

    await rejection;
    expect(signal?.aborted).toBe(true);
  });

  it("also aborts a stalled legacy /auth/me fallback", async () => {
    vi.useFakeTimers();
    let legacySignal: AbortSignal | null | undefined;
    const fetchMock = vi.fn((_input: string, init?: RequestInit) => {
      if (fetchMock.mock.calls.length === 1) return Promise.resolve({ ok: false, status: 404 } as Response);
      legacySignal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        legacySignal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    });
    global.fetch = fetchMock as typeof fetch;

    const request = getCurrentUser();
    const rejection = expect(request).rejects.toMatchObject({
      name: "AuthRequestTimeoutError",
      message: "Authentication request timed out",
    });
    await vi.advanceTimersByTimeAsync(AUTH_REQUEST_TIMEOUT_MS);

    await rejection;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(legacySignal?.aborted).toBe(true);
  });
});
