import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("getApiBase", () => {
  it("keeps browser requests same-origin even when NEXT_PUBLIC_API_BASE is set", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_BASE", "https://api.example.com/");
    const { getApiBase } = await import("./runtime-config");
    expect(getApiBase()).toBe("");
  });
});
