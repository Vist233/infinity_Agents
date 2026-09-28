import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("getApiBase", () => {
  it("uses an explicit API base when configured", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_BASE", "https://api.example.com/");
    const { getApiBase } = await import("./runtime-config");
    expect(getApiBase()).toBe("https://api.example.com");
  });

  it("disables relative API calls in a static frontend", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_BASE", "");
    vi.stubEnv("NEXT_PUBLIC_STATIC_FRONTEND", "1");
    const { canUseBrowserApi } = await import("./runtime-config");
    expect(canUseBrowserApi()).toBe(false);
  });

  it("rejects an HTTP API base for a static frontend", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_BASE", "http://localhost:8000");
    vi.stubEnv("NEXT_PUBLIC_STATIC_FRONTEND", "1");
    const { canUseBrowserApi } = await import("./runtime-config");
    expect(canUseBrowserApi()).toBe(false);
  });

  it("allows an explicitly provisioned HTTPS API base", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_BASE", "https://api.example.com");
    vi.stubEnv("NEXT_PUBLIC_STATIC_FRONTEND", "1");
    const { canUseBrowserApi } = await import("./runtime-config");
    expect(canUseBrowserApi()).toBe(true);
  });
});
