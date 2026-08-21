import { describe, expect, it } from "vitest";
import { getCurrentUser, logout } from "./auth";

describe("getCurrentUser", () => {
  it("returns the shared local-admin user", async () => {
    await expect(getCurrentUser()).resolves.toEqual({
      id: "local-admin",
      email: null,
      name: "Local Admin",
    });
  });
});

describe("logout", () => {
  it("is a no-op", async () => {
    await expect(logout()).resolves.toBeUndefined();
  });
});
