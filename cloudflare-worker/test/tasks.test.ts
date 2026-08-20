import { describe, expect, it } from "vitest";
import { configuredTaskUploadLimit, DEFAULT_TASK_UPLOAD_LIMIT_BYTES, handleTaskApi, WORKER_ONLINE_WINDOW_SECONDS, taskSubmissionSourceError, workerPresence } from "../src/tasks";
import type { AuthedUser } from "../src/auth";
import { makeEnv } from "./fake-d1";

const user: AuthedUser = { userId: "user-1", email: null, sid: "sid-1" };

describe("persistent Worker presence", () => {
  const now = 1_800_000_000;

  it("keeps a recently heartbeating active registration online", () => {
    expect(workerPresence("active", now - WORKER_ONLINE_WINDOW_SECONDS, now)).toBe("online");
  });

  it("shows an active registration as offline after the heartbeat window", () => {
    expect(workerPresence("active", now - WORKER_ONLINE_WINDOW_SECONDS - 1, now)).toBe("offline");
  });

  it("distinguishes a saved Worker that has never connected", () => {
    expect(workerPresence("active", null, now)).toBe("never_seen");
    expect(workerPresence("revoked", now, now)).toBe("offline");
  });
});

describe("task submission source contract", () => {
  it("rejects a caller-supplied Task Center flag on the generic route", () => {
    expect(taskSubmissionSourceError({ submission_source: "task_center" }, false)).toBe("TASK_SOURCE_REQUIRED");
    expect(taskSubmissionSourceError({ chat_confirmation_id: false }, false)).toBe("TASK_SOURCE_REQUIRED");
  });

  it("allows direct submission only through the dedicated route", () => {
    expect(taskSubmissionSourceError({ chat_confirmation_id: false, submission_source: "task_center" }, true)).toBeNull();
    expect(taskSubmissionSourceError({ chat_confirmation_id: "confirmation-1" }, true)).toBe("TASK_CONFIRMATION_CONFLICT");
  });
});

describe("task input size contract", () => {
  it("keeps the default per-file input limit at 25 MB", () => {
    expect(DEFAULT_TASK_UPLOAD_LIMIT_BYTES).toBe(25 * 1024 * 1024);
  });

  it("never allows configuration to raise the hard 25 MB input cap", () => {
    expect(configuredTaskUploadLimit(100 * 1024 * 1024)).toBe(25 * 1024 * 1024);
    expect(configuredTaskUploadLimit(5 * 1024 * 1024)).toBe(5 * 1024 * 1024);
    expect(configuredTaskUploadLimit("invalid")).toBe(25 * 1024 * 1024);
  });
});

describe("browser task isolation", () => {
  it("does not expose one user's task to another user", async () => {
    const { env, db } = makeEnv();
    db.seedTask("task-alice", "alice");

    const own = await handleTaskApi(
      new Request("https://app.test/api/tasks/task-alice"),
      env,
      { userId: "alice", email: null, sid: "sid-alice" },
    );
    const other = await handleTaskApi(
      new Request("https://app.test/api/tasks/task-alice"),
      env,
      { userId: "bob", email: null, sid: "sid-bob" },
    );

    expect(own?.status).toBe(200);
    expect(other?.status).toBe(404);
    expect(await other?.json()).toMatchObject({ error: { code: "TASK_NOT_FOUND" } });
  });
});
