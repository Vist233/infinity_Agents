import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, cleanup, waitFor } from "@testing-library/react";
import { LanguageProvider } from "@/lib/i18n";
import CodeAgentPage from "../page";

function renderPage() {
  window.localStorage.setItem("infinity-agents-language", "zh");
  return render(
    <LanguageProvider>
      <CodeAgentPage />
    </LanguageProvider>,
  );
}

// Mock the Task API client so the tests never hit the network.
vi.mock("@/lib/api/tasks", () => ({
  submitTaskBundle: vi.fn(),
  listTasks: vi.fn(),
  cancelTask: vi.fn(),
  listWorkerEnrollments: vi.fn().mockResolvedValue([]),
  getPublicWorkerPool: vi.fn().mockRejectedValue(Object.assign(new Error("forbidden"), { status: 403 })),
}));

// useRouter is not under test here.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

import { submitTaskBundle, listTasks } from "@/lib/api/tasks";

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

describe("Task Center workspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (listTasks as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_TASKS);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("renders task creation, collapsed Worker management, and the task list", async () => {
    await act(async () => {
      renderPage();
    });

    expect(screen.getByText("新建任务")).toBeDefined();
    expect(screen.getByText("添加 Worker")).toBeDefined();
    expect(document.querySelectorAll('input[type="file"]').length).toBe(2);

    // Task list loaded from the API
    await waitFor(() => {
      expect(screen.getByText("DESeq2 Differential Expression")).toBeDefined();
    });
    expect(document.querySelector("aside")?.textContent).toContain("DESeq2 Differential Expression");
    expect(screen.getByText("成功")).toBeDefined();
  });

  it("exposes the direct task creation entry point in Task Center", async () => {
    await act(async () => {
      renderPage();
    });
    expect(screen.getByRole("button", { name: /确认并提交/ })).toBeDefined();
    expect(submitTaskBundle).not.toHaveBeenCalled();
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
