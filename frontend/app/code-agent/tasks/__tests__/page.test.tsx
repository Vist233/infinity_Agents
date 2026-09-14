import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "@/lib/i18n";
import TaskDetailPage from "../[task_id]/page";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useParams: () => ({ task_id: "preview" }),
  redirect: vi.fn(),
}));

vi.mock("@/lib/api/auth", () => ({
  getCurrentUser: vi.fn().mockResolvedValue({ id: "user-1", email: "tester@example.com", name: "Tester" }),
  isAuthRequestTimeoutError: (error: unknown) => error instanceof Error && error.name === "AuthRequestTimeoutError",
  logout: vi.fn(),
}));

vi.mock("@/lib/api/tasks", () => ({
  artifactDownloadUrl: (artifactId: string) => `/api/artifacts/${artifactId}`,
  cancelTask: vi.fn(),
  getJson: vi.fn(),
  getJsonWithTimeout: vi.fn(),
  isTaskRequestTimeoutError: (error: unknown) => error instanceof Error && error.name === "TaskRequestTimeoutError",
  listTasksWithTimeout: vi.fn(),
  retryTask: vi.fn(),
}));

import { getCurrentUser } from "@/lib/api/auth";
import { getJson, getJsonWithTimeout, listTasksWithTimeout, retryTask } from "@/lib/api/tasks";

describe("Task detail downloads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (getCurrentUser as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "user-1", email: "tester@example.com", name: "Tester" });
    window.localStorage.setItem("infinity-agents-language", "zh");
    window.history.replaceState({}, "", "/task-center/tasks/task-1/");
    (listTasksWithTimeout as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const task = {
      task_id: "task-1",
      title: "Case 2",
      status: "succeeded",
      attempt_count: 1,
      max_attempts: 3,
      created_at: "2026-08-10T00:00:00Z",
      result_artifact_id: "artifact-1",
    };
    const artifacts = [{
      artifact_id: "artifact-1",
      name: "case-2-artifacts.zip",
      kind: "result",
      file_size_bytes: 37325,
      checksum_sha256: "a".repeat(64),
      created_at: "2026-08-10T00:01:00Z",
    }];
    (getJson as ReturnType<typeof vi.fn>).mockResolvedValue(task);
    (getJsonWithTimeout as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url.endsWith("/events")) return Promise.resolve([]);
      return Promise.resolve(artifacts);
    });
  });

  afterEach(() => {
    cleanup();
    window.localStorage.removeItem("infinity-agents-language");
    vi.useRealTimers();
  });

  it("shows a published artifact and downloads it from the task detail", async () => {
    await act(async () => {
      render(<LanguageProvider><TaskDetailPage /></LanguageProvider>);
    });

    const download = await screen.findByRole("link", { name: "查看" });
    expect(screen.getByText("case-2-artifacts.zip")).toBeDefined();
    expect(download.getAttribute("href")).toBe("/api/artifacts/artifact-1");
    expect(download.hasAttribute("download")).toBe(true);
  });

  it("shows only login actions and no task creation to unauthenticated users", async () => {
    (getCurrentUser as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    await act(async () => {
      render(<LanguageProvider><TaskDetailPage /></LanguageProvider>);
    });

    expect(await screen.findAllByRole("button", { name: "登录 / 注册" })).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Open workspace menu" }));
    expect(screen.queryByText("新建任务")).toBeNull();
    expect(getJson).not.toHaveBeenCalled();
  });

  it("keeps authentication failures separate from the signed-out state", async () => {
    (getCurrentUser as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("offline"));

    await act(async () => {
      render(<LanguageProvider><TaskDetailPage /></LanguageProvider>);
    });

    expect(await screen.findByText(/后端服务不可用/)).toBeDefined();
    expect(screen.queryByRole("button", { name: "登录 / 注册" })).toBeNull();
    expect(getJson).not.toHaveBeenCalled();
  });

  it("turns an authentication timeout into a recoverable error instead of infinite loading", async () => {
    const timeoutError = new Error("Authentication request timed out");
    timeoutError.name = "AuthRequestTimeoutError";
    (getCurrentUser as ReturnType<typeof vi.fn>).mockRejectedValue(timeoutError);

    await act(async () => {
      render(<LanguageProvider><TaskDetailPage /></LanguageProvider>);
    });

    expect(await screen.findByRole("alert")).toHaveTextContent("登录状态检查超时，请重试或重新登录。");
    expect(screen.queryByText("处理中...")).toBeNull();
    expect(screen.getByRole("button", { name: "重试" })).toBeDefined();
    expect(screen.getByRole("button", { name: "登录 / 注册" })).toBeDefined();
    expect(getJson).not.toHaveBeenCalled();
  });

  it("renders the main task and keeps retry available while auxiliary requests stall", async () => {
    const pending = new Promise<never>(() => undefined);
    const retryableTask = {
      task_id: "task-1",
      title: "Case 2",
      status: "failed",
      can_retry: true,
      attempt_count: 1,
      max_attempts: 3,
      created_at: "2026-08-10T00:00:00Z",
    };
    (getJson as ReturnType<typeof vi.fn>).mockResolvedValue(retryableTask);
    (getJsonWithTimeout as ReturnType<typeof vi.fn>).mockReturnValue(pending);
    (listTasksWithTimeout as ReturnType<typeof vi.fn>).mockReturnValue(pending);
    (retryTask as ReturnType<typeof vi.fn>).mockResolvedValue({ task_id: "task-1", status: "queued" });

    await act(async () => {
      render(<LanguageProvider><TaskDetailPage /></LanguageProvider>);
    });

    expect(await screen.findByRole("heading", { name: "Case 2" })).toBeDefined();
    expect(screen.queryByText("处理中...")).toBeNull();
    expect(screen.getByRole("button", { name: "重试任务" })).toBeDefined();
    expect(getJsonWithTimeout).toHaveBeenCalledTimes(2);
    expect(listTasksWithTimeout).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "重试任务" }));
    await waitFor(() => expect(retryTask).toHaveBeenCalledWith("task-1"));
    await waitFor(() => expect(getJson).toHaveBeenCalledTimes(2));
  });

  it("shows auxiliary failures in their own panels", async () => {
    const timeoutError = new Error("Task detail auxiliary request timed out");
    timeoutError.name = "TaskRequestTimeoutError";
    (getJsonWithTimeout as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url.endsWith("/events")) return Promise.reject(timeoutError);
      return Promise.reject(new Error("artifact unavailable"));
    });
    (listTasksWithTimeout as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("list unavailable"));

    await act(async () => {
      render(<LanguageProvider><TaskDetailPage /></LanguageProvider>);
    });

    expect(await screen.findByText("加载事件失败：辅助请求超时，请稍后重试。")).toBeDefined();
    expect(screen.getByText("加载产物失败：artifact unavailable")).toBeDefined();
    expect(await screen.findByText(/list unavailable/)).toBeDefined();
    expect(screen.getByRole("heading", { name: "Case 2" })).toBeDefined();
  });
});
