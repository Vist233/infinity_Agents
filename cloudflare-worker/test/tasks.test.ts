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

describe("task cancellation state machine", () => {
  it("cancels an unclaimed queued task immediately", async () => {
    const { env, db } = makeEnv();
    db.seedTask("task-queued", user.userId);
    const queuedTask = db.tasks.get("task-queued")!;
    queuedTask.lease_worker_id = "stale-worker";
    queuedTask.lease_expires_at = 1_800_000_000;
    queuedTask.lease_claim_id = "stale-claim";
    queuedTask.lease_namespace = "stale-namespace";
    queuedTask.lease_token_hash = "stale-token";
    const response = await handleTaskApi(
      new Request("https://app.test/api/tasks/task-queued/cancel", { method: "POST" }),
      env,
      user,
    );
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({ task_id: "task-queued", status: "cancelled" });
    expect(db.tasks.get("task-queued")).toMatchObject({
      status: "cancelled",
      active_attempt_id: null,
      lease_worker_id: null,
      lease_expires_at: null,
      lease_claim_id: null,
      lease_namespace: null,
      lease_token_hash: null,
    });
    const duplicate = await handleTaskApi(
      new Request("https://app.test/api/tasks/task-queued/cancel", { method: "POST" }),
      env,
      user,
    );
    expect(await duplicate?.json()).toMatchObject({ status: "cancelled", duplicate: true });
  });

  it("requests fenced Worker cancellation without orphaning a live Attempt", async () => {
    const { env, db } = makeEnv();
    db.seedTask("task-running", user.userId, "Running task", "running");
    const task = db.tasks.get("task-running")!;
    task.active_attempt_id = "attempt-1";
    const response = await handleTaskApi(
      new Request("https://app.test/api/tasks/task-running/cancel", { method: "POST" }),
      env,
      user,
    );
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({ task_id: "task-running", status: "running", cancel_requested: true });
    expect(task.status).toBe("running");
    expect(task.cancel_requested_at).toBeTypeOf("number");

    const duplicate = await handleTaskApi(
      new Request("https://app.test/api/tasks/task-running/cancel", { method: "POST" }),
      env,
      user,
    );
    expect(await duplicate?.json()).toMatchObject({ cancel_requested: true, duplicate: true });
  });
});

describe("task retry state machine", () => {
  const retryRequest = (taskId: string) => new Request(`https://app.test/api/tasks/${taskId}/retry`, { method: "POST" });

  it("lets the owner requeue a failed task while preserving the old Attempt", async () => {
    const { env, db } = makeEnv();
    db.seedTask("task-failed", user.userId, "Failed task", "failed");
    const task = db.tasks.get("task-failed")!;
    task.attempt_count = 1;
    task.max_attempts = 3;
    task.error_message = "old failure";
    task.finished_at = 1_800_000_000;
    db.seedTaskAttempt({ attempt_id: "attempt-old", task_id: task.task_id, status: "failed", lease_expires_at: 1_800_000_000 });

    const response = await handleTaskApi(retryRequest(task.task_id), env, user);
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({ task_id: task.task_id, status: "queued", attempt_count: 1, duplicate: false });
    expect(task.status).toBe("queued");
    expect(task.attempt_count).toBe(1);
    expect(task.error_message).toBeNull();
    expect(task.finished_at).toBeNull();
    expect(db.taskAttempts.get("attempt-old")?.status).toBe("failed");
    expect([...db.taskEvents.values()].filter((event) => event.task_id === task.task_id && event.event_type === "task_requeued")).toHaveLength(1);
    expect([...db.outboxEvents.values()].filter((event) => event.aggregate_id === task.task_id && event.event_type === "task_queued")).toHaveLength(1);

    const duplicate = await handleTaskApi(retryRequest(task.task_id), env, user);
    expect(duplicate?.status).toBe(200);
    expect(await duplicate?.json()).toMatchObject({ task_id: task.task_id, status: "queued", duplicate: true });
    expect([...db.taskEvents.values()].filter((event) => event.task_id === task.task_id && event.event_type === "task_requeued")).toHaveLength(1);
    expect([...db.outboxEvents.values()].filter((event) => event.aggregate_id === task.task_id && event.event_type === "task_queued")).toHaveLength(1);
  });

  it("repairs a failed production row with a terminal active Attempt and stale lease fields", async () => {
    const { env, db } = makeEnv();
    db.seedTask("discovery-task-ab040aea-4ca5-4113-9c43-188a004b96dd", user.userId, "Discovery task", "failed");
    const task = db.tasks.get("discovery-task-ab040aea-4ca5-4113-9c43-188a004b96dd")!;
    task.attempt_count = 1;
    task.max_attempts = 3;
    task.lease_epoch = 7;
    task.active_attempt_id = "attempt-failed-production";
    task.lease_worker_id = "worker-stale";
    task.lease_expires_at = 1_800_000_999;
    task.lease_claim_id = "claim-stale";
    task.lease_namespace = "infinity-public";
    task.lease_token_hash = "token-stale";
    db.seedTaskAttempt({
      attempt_id: task.active_attempt_id,
      task_id: task.task_id,
      status: "failed",
      lease_expires_at: 1_800_000_999,
    });

    const before = await handleTaskApi(new Request(`https://app.test/api/tasks/${task.task_id}`), env, user);
    expect(before?.status).toBe(200);
    expect(await before?.json()).toMatchObject({ status: "failed", can_retry: true });

    const response = await handleTaskApi(retryRequest(task.task_id), env, user);
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({
      task_id: task.task_id,
      status: "queued",
      attempt_count: 1,
      duplicate: false,
    });
    expect(task).toMatchObject({
      status: "queued",
      active_attempt_id: null,
      lease_worker_id: null,
      lease_expires_at: null,
      lease_claim_id: null,
      lease_namespace: null,
      lease_token_hash: null,
    });
    expect(task.lease_epoch).toBe(7);
    expect(db.taskAttempts.get("attempt-failed-production")?.status).toBe("failed");
    expect([...db.taskEvents.values()].filter((event) => event.task_id === task.task_id && event.event_type === "task_requeued")).toHaveLength(1);
    expect([...db.outboxEvents.values()].filter((event) => event.aggregate_id === task.task_id && event.event_type === "task_queued")).toHaveLength(1);
  });

  it("allows one audited retry for a maxed terminal production task", async () => {
    const { env, db } = makeEnv();
    const taskId = "discovery-task-ab040aea-4ca5-4113-9c43-188a004b96dd";
    db.seedTask(taskId, user.userId, "Discovery task at retry limit", "failed");
    const task = db.tasks.get(taskId)!;
    task.attempt_count = 3;
    task.max_attempts = 3;
    task.lease_epoch = 11;
    task.active_attempt_id = "attempt-failed-at-limit";
    task.lease_worker_id = "worker-stale";
    task.lease_expires_at = 1_800_001_111;
    task.lease_claim_id = "claim-stale";
    task.lease_namespace = "infinity-public";
    task.lease_token_hash = "token-stale";
    db.seedTaskAttempt({
      attempt_id: task.active_attempt_id,
      task_id: task.task_id,
      status: "failed",
      lease_expires_at: 1_800_001_111,
    });

    const before = await handleTaskApi(new Request(`https://app.test/api/tasks/${task.task_id}`), env, user);
    expect(before?.status).toBe(200);
    expect(await before?.json()).toMatchObject({ status: "failed", attempt_count: 3, max_attempts: 3, can_retry: true });

    const response = await handleTaskApi(retryRequest(task.task_id), env, user);
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({
      task_id: task.task_id,
      status: "queued",
      attempt_count: 3,
      duplicate: false,
    });
    expect(db.tasks.size).toBe(1);
    expect(task).toMatchObject({
      status: "queued",
      active_attempt_id: null,
      lease_worker_id: null,
      lease_expires_at: null,
      lease_claim_id: null,
      lease_namespace: null,
      lease_token_hash: null,
    });
    expect(task.lease_epoch).toBe(11);
    expect(db.taskAttempts.get("attempt-failed-at-limit")?.status).toBe("failed");

    const eventId = `task-requeued:${task.task_id}:3`;
    const event = db.taskEvents.get(eventId);
    expect(event).toMatchObject({ task_event_id: eventId, task_id: task.task_id, event_type: "task_requeued" });
    expect(JSON.parse(event!.event_data)).toMatchObject({
      reason: "manual_retry",
      retry_mode: "max_attempt_override",
      attempt_count: 3,
      max_attempts: 3,
    });
    const outbox = db.outboxEvents.get(`task-queued:retry:${task.task_id}:3`);
    expect(outbox).toBeDefined();
    expect(JSON.parse(outbox!.payload_json)).toMatchObject({ retry_mode: "max_attempt_override" });

    const duplicate = await handleTaskApi(retryRequest(task.task_id), env, user);
    expect(duplicate?.status).toBe(200);
    expect(await duplicate?.json()).toMatchObject({ task_id: task.task_id, status: "queued", attempt_count: 3, duplicate: true });
    expect([...db.taskEvents.values()].filter((event) => event.task_id === task.task_id && event.event_type === "task_requeued")).toHaveLength(1);
    expect([...db.outboxEvents.values()].filter((event) => event.aggregate_id === task.task_id && event.event_type === "task_queued")).toHaveLength(1);

    task.status = "failed";
    task.attempt_count = 4;
    task.active_attempt_id = "attempt-failed-after-override";
    db.seedTaskAttempt({ attempt_id: task.active_attempt_id, task_id: task.task_id, status: "failed", lease_expires_at: 1_800_001_222 });
    const exhausted = await handleTaskApi(retryRequest(task.task_id), env, user);
    expect(exhausted?.status).toBe(409);
    expect(await exhausted?.json()).toMatchObject({ error: { code: "TASK_RETRY_LIMIT_REACHED" } });
  });

  it("allows one audited lease-expiry recovery after the max override and rejects ordinary failures", async () => {
    const { env, db } = makeEnv();
    const taskId = "task-lease-expired-recovery";
    db.seedTask(taskId, user.userId, "Lease-expiry recovery", "failed");
    const task = db.tasks.get(taskId)!;
    task.attempt_count = 4;
    task.max_attempts = 3;
    db.seedTaskAttempt({
      attempt_id: "attempt-override-expired",
      task_id: taskId,
      status: "expired",
      lease_expires_at: 1_800_000_000,
      attempt_number: 4,
      error_code: "lease_expired",
    });
    const maxOverrideEventId = `task-requeued:${taskId}:3`;
    db.taskEvents.set(maxOverrideEventId, {
      task_event_id: maxOverrideEventId,
      task_id: taskId,
      event_type: "task_requeued",
      event_data: JSON.stringify({ retry_mode: "max_attempt_override" }),
      created_at: 1_800_000_000,
    });

    const before = await handleTaskApi(new Request(`https://app.test/api/tasks/${taskId}`), env, user);
    expect(before?.status).toBe(200);
    expect(await before?.json()).toMatchObject({
      status: "failed",
      attempt_count: 4,
      max_attempts: 3,
      can_retry: true,
      retry_reason: "lease_expired_recovery",
    });

    const response = await handleTaskApi(retryRequest(taskId), env, user);
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({
      task_id: taskId,
      status: "queued",
      attempt_count: 4,
      retry_mode: "lease_expired_recovery",
      duplicate: false,
    });
    expect(task.status).toBe("queued");
    const recoveryEventId = `task-requeued:lease-expired-recovery:${taskId}:4`;
    expect(JSON.parse(db.taskEvents.get(recoveryEventId)!.event_data)).toMatchObject({
      reason: "lease_expired",
      retry_mode: "lease_expired_recovery",
      recovery_of_attempt_id: "attempt-override-expired",
      recovery_limit: 1,
    });
    expect(db.outboxEvents.get(`task-queued:retry:lease-expired-recovery:${taskId}:4`)).toBeDefined();

    const duplicate = await handleTaskApi(retryRequest(taskId), env, user);
    expect(duplicate?.status).toBe(200);
    expect(await duplicate?.json()).toMatchObject({ task_id: taskId, status: "queued", duplicate: true });
    expect([...db.taskEvents.values()].filter((event) => event.task_id === taskId && event.event_type === "task_requeued")).toHaveLength(2);

    task.status = "failed";
    task.attempt_count = 5;
    db.seedTaskAttempt({
      attempt_id: "attempt-after-recovery",
      task_id: taskId,
      status: "failed",
      lease_expires_at: 1_800_000_000,
      attempt_number: 5,
      error_code: "execution_error",
    });
    const afterRecovery = await handleTaskApi(retryRequest(taskId), env, user);
    expect(afterRecovery?.status).toBe(409);
    expect(await afterRecovery?.json()).toMatchObject({ error: { code: "TASK_RETRY_LIMIT_REACHED" } });

    const ordinary = makeEnv();
    ordinary.db.seedTask("task-ordinary-after-override", user.userId, "Ordinary failure", "failed");
    const ordinaryTask = ordinary.db.tasks.get("task-ordinary-after-override")!;
    ordinaryTask.attempt_count = 4;
    ordinaryTask.max_attempts = 3;
    ordinary.db.seedTaskAttempt({
      attempt_id: "attempt-ordinary-failed",
      task_id: ordinaryTask.task_id,
      status: "failed",
      lease_expires_at: 1_800_000_000,
      attempt_number: 4,
      error_code: "execution_error",
    });
    const ordinaryMaxOverrideEventId = `task-requeued:${ordinaryTask.task_id}:3`;
    ordinary.db.taskEvents.set(ordinaryMaxOverrideEventId, {
      task_event_id: ordinaryMaxOverrideEventId,
      task_id: ordinaryTask.task_id,
      event_type: "task_requeued",
      event_data: JSON.stringify({ retry_mode: "max_attempt_override" }),
      created_at: 1_800_000_000,
    });
    const ordinaryResponse = await handleTaskApi(retryRequest(ordinaryTask.task_id), ordinary.env, user);
    expect(ordinaryResponse?.status).toBe(409);
    expect(await ordinaryResponse?.json()).toMatchObject({ error: { code: "TASK_RETRY_LIMIT_REACHED" } });
  });

  it("allows an administrator to retry another user's task but not an ordinary user", async () => {
    const { env, db } = makeEnv();
    db.seedTask("task-owned-by-alice", "alice", "Alice's task", "failed");

    const other = await handleTaskApi(retryRequest("task-owned-by-alice"), env, {
      userId: "bob",
      email: null,
      sid: "sid-bob",
      role: "user",
    });
    expect(other?.status).toBe(404);
    expect(await other?.json()).toMatchObject({ error: { code: "TASK_NOT_FOUND" } });

    const admin = await handleTaskApi(retryRequest("task-owned-by-alice"), env, {
      userId: "admin",
      email: null,
      sid: "sid-admin",
      role: "admin",
    });
    expect(admin?.status).toBe(200);
    expect(await admin?.json()).toMatchObject({ task_id: "task-owned-by-alice", status: "queued" });
  });

  it("accepts timeout but rejects non-retryable terminal and active states", async () => {
    const timeout = makeEnv();
    timeout.db.seedTask("task-timeout", user.userId, "Timeout task", "timeout");
    const timeoutResponse = await handleTaskApi(retryRequest("task-timeout"), timeout.env, user);
    expect(timeoutResponse?.status).toBe(200);
    expect(await timeoutResponse?.json()).toMatchObject({ status: "queued" });

    for (const status of ["queued", "succeeded", "cancelled"] as const) {
      const { env, db } = makeEnv();
      const taskId = `task-${status}`;
      db.seedTask(taskId, user.userId, "Task", status);
      const response = await handleTaskApi(retryRequest(taskId), env, user);
      expect(response?.status).toBe(409);
      expect(await response?.json()).toMatchObject({ error: { code: "TASK_NOT_RETRYABLE" } });
    }

    const active = makeEnv();
    active.db.seedTask("task-active", user.userId, "Active task", "failed");
    active.db.tasks.get("task-active")!.active_attempt_id = "attempt-live";
    const activeResponse = await handleTaskApi(retryRequest("task-active"), active.env, user);
    expect(activeResponse?.status).toBe(409);
    expect(await activeResponse?.json()).toMatchObject({ error: { code: "TASK_RETRY_ACTIVE" } });

    const leased = makeEnv();
    leased.db.seedTask("task-leased", user.userId, "Leased task", "failed");
    leased.db.tasks.get("task-leased")!.lease_worker_id = "worker-1";
    const leasedResponse = await handleTaskApi(retryRequest("task-leased"), leased.env, user);
    expect(leasedResponse?.status).toBe(409);
    expect(await leasedResponse?.json()).toMatchObject({ error: { code: "TASK_RETRY_ACTIVE" } });

    const activeAttempt = makeEnv();
    activeAttempt.db.seedTask("task-active-attempt", user.userId, "Active Attempt", "failed");
    activeAttempt.db.seedTaskAttempt({ attempt_id: "attempt-running", task_id: "task-active-attempt", status: "running", lease_expires_at: 1_800_000_000 });
    const activeAttemptResponse = await handleTaskApi(retryRequest("task-active-attempt"), activeAttempt.env, user);
    expect(activeAttemptResponse?.status).toBe(409);
    expect(await activeAttemptResponse?.json()).toMatchObject({ error: { code: "TASK_RETRY_ACTIVE" } });
  });

  it("self-heals an orphaned max-attempt marker through the formal retry API", async () => {
    const { env, db } = makeEnv();
    db.seedTask("task-orphaned-marker", user.userId, "Orphaned marker", "failed");
    const task = db.tasks.get("task-orphaned-marker")!;
    task.attempt_count = 3;
    task.max_attempts = 3;
    const eventId = "task-requeued:task-orphaned-marker:3";
    db.taskEvents.set(eventId, {
      task_event_id: eventId,
      task_id: task.task_id,
      event_type: "task_requeued",
      event_data: JSON.stringify({ reason: "manual_retry", retry_mode: "max_attempt_override", attempt_count: 3, max_attempts: 3 }),
      created_at: 1_800_000_000,
    });

    const before = await handleTaskApi(new Request(`https://app.test/api/tasks/${task.task_id}`), env, user);
    expect(before?.status).toBe(200);
    expect(await before?.json()).toMatchObject({ status: "failed", attempt_count: 3, max_attempts: 3, can_retry: true });

    const response = await handleTaskApi(retryRequest(task.task_id), env, user);
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({ task_id: task.task_id, status: "queued", attempt_count: 3, duplicate: false });
    expect(task.status).toBe("queued");
    expect(db.taskEvents.get(eventId)?.event_data).toContain("max_attempt_override");
    expect(db.outboxEvents.get(`task-queued:retry:${task.task_id}:3`)).toBeDefined();

    const duplicate = await handleTaskApi(retryRequest(task.task_id), env, user);
    expect(duplicate?.status).toBe(200);
    expect(await duplicate?.json()).toMatchObject({ task_id: task.task_id, status: "queued", attempt_count: 3, duplicate: true });
    expect(db.taskEvents.size).toBe(1);
    expect(db.outboxEvents.size).toBe(1);
  });

  it("makes concurrent double-clicks idempotent with one event and one outbox row", async () => {
    const { env, db } = makeEnv();
    db.seedTask("task-concurrent", user.userId, "Concurrent retry", "failed");
    const responses = await Promise.all([
      handleTaskApi(retryRequest("task-concurrent"), env, user),
      handleTaskApi(retryRequest("task-concurrent"), env, user),
    ]);
    expect(responses.map((response) => response?.status).sort()).toEqual([200, 200]);
    const payloads = await Promise.all(responses.map((response) => response!.json() as Promise<Record<string, unknown>>));
    expect(payloads.filter((payload) => payload.duplicate === false)).toHaveLength(1);
    expect(payloads.filter((payload) => payload.duplicate === true)).toHaveLength(1);
    expect([...db.taskEvents.values()].filter((event) => event.event_type === "task_requeued")).toHaveLength(1);
    expect([...db.outboxEvents.values()].filter((event) => event.event_type === "task_queued")).toHaveLength(1);
  });
});
