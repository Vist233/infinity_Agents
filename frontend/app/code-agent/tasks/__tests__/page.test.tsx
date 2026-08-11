import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "@/lib/i18n";
import TaskDetailPage from "../[task_id]/page";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useParams: () => ({ task_id: "task-1" }),
  redirect: vi.fn(),
}));

vi.mock("@/lib/api/auth", () => ({
  getCurrentUser: vi.fn().mockResolvedValue({ id: "user-1", email: "tester@example.com", name: "Tester" }),
  logout: vi.fn(),
}));

vi.mock("@/lib/api/tasks", () => ({
  artifactDownloadUrl: (artifactId: string) => `/api/artifacts/${artifactId}`,
  cancelTask: vi.fn(),
  downloadArtifact: vi.fn().mockResolvedValue(undefined),
  getJson: vi.fn(),
  getTaskArtifacts: vi.fn(),
  listTasks: vi.fn(),
}));

import { downloadArtifact, getJson, listTasks } from "@/lib/api/tasks";

describe("Task detail downloads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.setItem("infinity-agents-language", "zh");
    window.history.replaceState({}, "", "/code-agent/tasks/?task_id=task-1");
    (listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([]);
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
    (getJson as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url.endsWith("/events")) return Promise.resolve([]);
      if (url.endsWith("/artifacts")) return Promise.resolve(artifacts);
      return Promise.resolve(task);
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

    const download = await screen.findByRole("button", { name: "查看" });
    expect(screen.getByText("case-2-artifacts.zip")).toBeDefined();
    await act(async () => {
      fireEvent.click(download);
    });
    expect(downloadArtifact).toHaveBeenCalledWith("artifact-1", "case-2-artifacts.zip");
  });
});
