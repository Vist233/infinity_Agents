import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TASK_ACTION_TIMEOUT_MS,
  TASK_DETAIL_AUX_TIMEOUT_MS,
  createTask,
  getJsonWithTimeout,
  getWorkerCredential,
  retryTask,
  rotateWorkerCredential,
} from "./tasks";

const input = {
  project_id: "project-1",
  task_spec_id: "spec-1",
  dataset_snapshot_id: "dataset-1",
  title: "case-2",
  method_source_id: "method-1",
  idempotency_key: "task-center-test-1",
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("createTask route selection", () => {
  it("uses the direct Task Center route and disables Agent confirmation", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ task_id: "task-1", status: "queued" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await createTask({ ...input, chat_confirmation_id: false, submission_source: "task_center", direct: true });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/tasks/direct",
      expect.objectContaining({ method: "POST" }),
    );
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({
      agent_confirmation: false,
      submission_source: "task_center",
      chat_confirmation_id: false,
    });
  });

  it("keeps Agent confirmation submissions on the generic route", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ task_id: "task-2", status: "queued" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await createTask({ ...input, chat_confirmation_id: "confirmation-1" });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/tasks",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("does not send Namespace as a client-controlled credential parameter", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(
      new Response(JSON.stringify({ worker_id: "worker-1", worker_credential: "credential" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ));
    vi.stubGlobal("fetch", fetchMock);

    await getWorkerCredential("worker-1");
    await rotateWorkerCredential("worker-1");

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/worker-enrollments/worker-1/credential");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/worker-enrollments/worker-1/rotate");
  });

  it("uses the authenticated task retry endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ task_id: "task-failed", status: "queued", attempt_count: 1 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await retryTask("task/failed");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/tasks/task%2Ffailed/retry",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("aborts a stalled auxiliary task request at its bounded timeout", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | null | undefined;
    const fetchMock = vi.fn((_input: unknown, init?: RequestInit) => {
      signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const request = getJsonWithTimeout("/api/tasks/task-1/events");
    const rejection = expect(request).rejects.toMatchObject({
      name: "TaskRequestTimeoutError",
      message: "Task detail auxiliary request timed out",
    });
    await vi.advanceTimersByTimeAsync(TASK_DETAIL_AUX_TIMEOUT_MS);

    await rejection;
    expect(signal?.aborted).toBe(true);
  });

  it("aborts a stalled task retry POST at its bounded action timeout", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | null | undefined;
    const fetchMock = vi.fn((_input: unknown, init?: RequestInit) => {
      signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const request = retryTask("task-1");
    const rejection = expect(request).rejects.toMatchObject({
      name: "TaskRequestTimeoutError",
      message: "Task retry request timed out",
    });
    await vi.advanceTimersByTimeAsync(TASK_ACTION_TIMEOUT_MS);

    await rejection;
    expect(signal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/tasks/task-1/retry",
      expect.objectContaining({ method: "POST", signal: expect.any(AbortSignal) }),
    );
  });
});
