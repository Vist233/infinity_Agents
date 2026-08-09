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

vi.mock("@/lib/api/auth", () => ({
  getCurrentUser: vi.fn().mockResolvedValue({ id: "user-1", email: "tester@example.com", name: "Tester" }),
  logout: vi.fn(),
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

describe("Task center", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.setItem("infinity-agents-locale-cache", "zh");
    (listTasks as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_TASKS);
  });

  afterEach(() => {
    cleanup();
    window.localStorage.removeItem("infinity-agents-locale-cache");
    vi.useRealTimers();
  });

  it("renders the direct creation card, collapsed Worker card, and task list", async () => {
    await act(async () => {
      renderPage();
    });

    expect(screen.getByTestId("task-creation-card")).toBeDefined();
    expect(screen.getByTestId("worker-enrollment-panel")).toBeDefined();
    expect(document.querySelectorAll('input[type="file"]').length).toBe(2);
    expect(screen.queryByTestId("worker-enrollment-namespace")).toBeNull();

    // Task list loaded from the API
    await waitFor(() => {
      expect(screen.getByText("DESeq2 Differential Expression")).toBeDefined();
    });
    expect(screen.getByText("成功")).toBeDefined();
  });

  it("does not submit a task before the user fills the direct card", async () => {
    await act(async () => {
      renderPage();
    });
    expect(screen.getByRole("button", { name: /创建任务/ })).toBeDefined();
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
