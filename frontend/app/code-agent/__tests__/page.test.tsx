import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LanguageProvider } from "@/lib/i18n";
import CodeAgentPage from "../page";

function renderPage() {
  return render(
    <LanguageProvider>
      <CodeAgentPage />
    </LanguageProvider>,
  );
}

// Mock the Task API client so the tests never hit the network.
vi.mock("@/lib/api/tasks", () => ({
  getDefaultProject: vi.fn(),
  uploadMethodSource: vi.fn(),
  uploadDataset: vi.fn(),
  createTaskSpec: vi.fn(),
  createDatasetSnapshot: vi.fn(),
  createTask: vi.fn(),
  listTasks: vi.fn(),
  cancelTask: vi.fn(),
}));

// useRouter is not under test here.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

import {
  getDefaultProject,
  uploadMethodSource,
  uploadDataset,
  createTaskSpec,
  createDatasetSnapshot,
  createTask,
  listTasks,
} from "@/lib/api/tasks";

const MOCK_TASKS = [
  {
    task_id: "task-1",
    task_spec_id: "spec-1",
    dataset_snapshot_id: "ds-1",
    project_id: "proj-1",
    title: "DESeq2 Differential Expression",
    status: "succeeded" as const,
    attempt_count: 1,
    max_attempts: 3,
    created_at: "2026-08-07T01:00:00Z",
  },
];

describe("CodeAgent main page (task creation + list)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (listTasks as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_TASKS);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("renders the new-task form and the task list", async () => {
    await act(async () => {
      renderPage();
    });

    // New task card
    expect(screen.getByText("执行文档")).toBeDefined();
    expect(screen.getByText("数据集")).toBeDefined();
    expect(screen.getByText("创建任务")).toBeDefined();

    // Task list loaded from the API
    await waitFor(() => {
      expect(screen.getByText("DESeq2 Differential Expression")).toBeDefined();
    });
    expect(screen.getByText("成功")).toBeDefined();
  });

  it("disables creation until both files are selected and runs the API chain", async () => {
    (getDefaultProject as ReturnType<typeof vi.fn>).mockResolvedValue({
      project_id: "proj-default",
      name: "Default Project",
    });
    (createTaskSpec as ReturnType<typeof vi.fn>).mockResolvedValue({ task_spec_id: "spec-9", revision: 1, status: "draft" });
    (uploadMethodSource as ReturnType<typeof vi.fn>).mockResolvedValue({ method_source_id: "ms-9", project_id: "proj-default" });
    (uploadDataset as ReturnType<typeof vi.fn>).mockResolvedValue({
      stored_path: "/tmp/uploaded-datasets/data.zip",
      file_hash_sha256: "abc",
      file_size_bytes: 10,
    });
    (createDatasetSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue({ dataset_snapshot_id: "ds-9" });
    (createTask as ReturnType<typeof vi.fn>).mockResolvedValue({ task_id: "task-9", status: "queued" });

    const user = userEvent.setup();
    await act(async () => {
      renderPage();
    });

    const createButton = screen.getByRole("button", { name: /创建任务/ });
    expect((createButton as HTMLButtonElement).disabled).toBe(true);

    const [methodInput, datasetInput] = screen.getAllByRole("button").length >= 0
      ? (document.querySelectorAll('input[type="file"]') as NodeListOf<HTMLInputElement>)
      : [];
    await act(async () => {
      await user.upload(methodInput, new File(["<html></html>"], "workflow.html", { type: "text/html" }));
      await user.upload(datasetInput, new File(["zipdata"], "data.zip", { type: "application/zip" }));
    });

    expect((screen.getByRole("button", { name: /创建任务/ }) as HTMLButtonElement).disabled).toBe(false);

    await act(async () => {
      await user.click(screen.getByRole("button", { name: /创建任务/ }));
    });

    await waitFor(() => {
      expect(createTask).toHaveBeenCalledTimes(1);
    });
    expect(getDefaultProject).toHaveBeenCalledTimes(1);
    expect(createTaskSpec).toHaveBeenCalledTimes(1);
    expect(uploadMethodSource).toHaveBeenCalledTimes(1);
    expect(uploadDataset).toHaveBeenCalledTimes(1);
    expect(createDatasetSnapshot).toHaveBeenCalledTimes(1);

    const taskPayload = (createTask as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(taskPayload.method_source_id).toBe("ms-9");
    expect(taskPayload.dataset_snapshot_id).toBe("ds-9");
    expect(taskPayload.project_id).toBe("proj-default");

    // Success banner appears
    await waitFor(() => {
      expect(screen.getByText("任务已创建并提交执行。")).toBeDefined();
    });
  });

  it("shows an error banner when the task list fails to load", async () => {
    (listTasks as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("boom"));

    await act(async () => {
      renderPage();
    });

    await waitFor(() => {
      expect(screen.getByText(/boom/)).toBeDefined();
    });
  });
});
