import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "@/lib/i18n";
import TaskDetailPage from "../page";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/lib/api/auth", () => ({
  getCurrentUser: vi.fn().mockResolvedValue({ id: "user-1", email: "tester@example.com", name: "Tester" }),
  logout: vi.fn(),
}));

vi.mock("@/lib/api/tasks", () => ({
  artifactDownloadUrl: (artifactId: string) => `/api/artifacts/${artifactId}`,
  cancelTask: vi.fn(),
  getJson: vi.fn(),
  getTaskArtifacts: vi.fn(),
  listTasks: vi.fn(),
}));

import { getJson, getTaskArtifacts, listTasks } from "@/lib/api/tasks";

describe("Task detail downloads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState({}, "", "/code-agent/tasks/?task_id=task-1");
    (listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (getJson as ReturnType<typeof vi.fn>).mockResolvedValue({
      task_id: "task-1",
      title: "Case 2",
      status: "succeeded",
      attempt_count: 1,
      max_attempts: 3,
      created_at: "2026-08-10T00:00:00Z",
      result_artifact_id: "artifact-1",
    });
    (getTaskArtifacts as ReturnType<typeof vi.fn>).mockResolvedValue([{
      artifact_id: "artifact-1",
      name: "case-2-artifacts.zip",
      kind: "result",
      file_size_bytes: 37325,
      checksum_sha256: "a".repeat(64),
      created_at: "2026-08-10T00:01:00Z",
    }]);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("shows a published artifact and downloads it from the task detail", async () => {
    await act(async () => {
      render(<LanguageProvider><TaskDetailPage /></LanguageProvider>);
    });

    const download = await screen.findByTestId("download-artifact-artifact-1");
    expect(screen.getByText("case-2-artifacts.zip")).toBeDefined();
    expect(download.getAttribute("href")).toBe("/api/artifacts/artifact-1");
    expect(download.getAttribute("download")).toBe("case-2-artifacts.zip");
  });
});
