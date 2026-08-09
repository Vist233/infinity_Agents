import { describe, expect, it } from "vitest";
import { workerTrustLevel } from "../src/tasks";
import type { AuthedUser } from "../src/auth";

const user: AuthedUser = { userId: "user-1", email: null, sid: "sid-1" };

describe("Worker trust assignment", () => {
  it("gives only a superuser owner-level trust", () => {
    expect(workerTrustLevel({ ...user, role: "superuser" })).toBe("owner_trusted");
    expect(workerTrustLevel({ ...user, role: "super_admin" })).toBe("owner_trusted");
  });

  it("keeps ordinary and student accounts at institution trust", () => {
    expect(workerTrustLevel({ ...user, role: "user" })).toBe("institution_trusted");
    expect(workerTrustLevel({ ...user, role: "student" })).toBe("institution_trusted");
    expect(workerTrustLevel(user)).toBe("institution_trusted");
  });
});
