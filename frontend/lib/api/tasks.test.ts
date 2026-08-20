import { afterEach, describe, expect, it, vi } from "vitest";
import { createTask } from "./tasks";

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
});
