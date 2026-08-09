import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, cleanup, waitFor } from "@testing-library/react";
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
  freezeTaskSpec: vi.fn(),
  createDatasetSnapshot: vi.fn(),
  createTask: vi.fn(),
  listTasks: vi.fn(),
  cancelTask: vi.fn(),
}));

// useRouter is not under test here.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

import { createTask, listTasks } from "@/lib/api/tasks";

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

describe("Task center (history-only surface)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (listTasks as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_TASKS);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("renders the confirmation-only notice and the task list", async () => {
    await act(async () => {
      renderPage();
    });

    expect(screen.getByText("任务只能从 Analysis 确认卡提交")).toBeDefined();
    expect(document.querySelectorAll('input[type="file"]').length).toBe(0);

    // Task list loaded from the API
    await waitFor(() => {
      expect(screen.getByText("DESeq2 Differential Expression")).toBeDefined();
    });
    expect(screen.getByText("成功")).toBeDefined();
  });

  it("does not expose a second direct task creation entry point", async () => {
    await act(async () => {
      renderPage();
    });
    expect(screen.queryByRole("button", { name: /创建任务/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /确认并提交/ })).toBeNull();
    expect(createTask).not.toHaveBeenCalled();
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
