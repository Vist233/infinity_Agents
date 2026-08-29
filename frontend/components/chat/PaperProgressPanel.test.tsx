import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "@/lib/i18n";
import { PaperProgressPanel } from "@/components/chat/PaperProgressPanel";
import type { PaperTaskRuntime } from "@/hooks/use-paper-progress";
import type { PaperResourceProgressStatus } from "@/lib/api/papers";

function task(overrides: Partial<PaperTaskRuntime> = {}): PaperTaskRuntime {
  return {
    candidate: {
      resourceId: "resource-1",
      continuationId: "continuation-1",
      correlationId: "turn-1",
      toolCallId: "call-1",
      materializeStatus: "succeeded",
      readiness: "unknown",
    },
    phase: "progress",
    progress: {
      resource: {
        resource_id: "resource-1",
        status: "extracting",
        stage: "extracting",
        source_kind: "arxiv",
        title: "A safe paper",
        page_count: null,
        image_count: null,
        error: null,
        created_at: 100,
        updated_at: 110,
        ready_at: null,
      },
      revision: "extracting:110",
      materialize: { invocation_status: "succeeded", invocation_event_id: "event-1", invoked_at: 100, resource_ready: false },
      correlation: { continuations: [{ continuation_id: "continuation-1", original_turn_id: "turn-1", status: "waiting", expires_at: 200, updated_at: 110, completed_at: null }] },
      events: [{ event_id: "event-1", stage: "materialize", outcome: "succeeded", error_code: null, created_at: 100 }],
      resume: { available: false, continuation_id: null, method: "POST", path: null, body: null, reason_code: "PAPER_RESOURCE_NOT_READY" },
    },
    errorMessage: null,
    retryAttempt: 0,
    resuming: false,
    ...overrides,
  };
}

const renderPanel = (tasks: PaperTaskRuntime[], onResume = vi.fn()) => render(
  <LanguageProvider initialLanguage="zh">
    <PaperProgressPanel tasks={tasks} onResume={onResume} />
  </LanguageProvider>,
);

describe("PaperProgressPanel", () => {
  it.each([
    ["requested", "已请求"],
    ["downloading", "下载中"],
    ["extracting", "提取中"],
    ["uploading", "上传中"],
    ["ready", "已就绪"],
    ["failed", "失败"],
    ["cancelled", "已取消"],
  ] as const)("represents the server lifecycle status %s", (status, label) => {
    const base = task();
    renderPanel([task({
      progress: {
        ...base.progress!,
        resource: { ...base.progress!.resource, status: status as PaperResourceProgressStatus, stage: status as PaperResourceProgressStatus },
      },
    })]);
    expect(screen.getByTestId("paper-status-resource-1")).toHaveTextContent(label);
  });

  it("shows processing progress and never renders ready for a successful materialize invocation", () => {
    renderPanel([task()]);
    expect(screen.getByTestId("paper-task-resource-1")).toBeVisible();
    expect(screen.getByText("提取中")).toBeVisible();
    expect(screen.getByText("已提交处理")).toBeVisible();
    expect(screen.queryByRole("button", { name: "继续读取" })).toBeNull();
    expect(screen.queryByText("已就绪")).toBeNull();
  });

  it("shows a ready read action and dispatches the existing continuation contract", () => {
    const onResume = vi.fn().mockResolvedValue(undefined);
    const ready = task({
      progress: {
        ...task().progress!,
        resource: { ...task().progress!.resource, status: "ready", stage: "ready", page_count: 4, image_count: 2, ready_at: 120 },
        materialize: { ...task().progress!.materialize, resource_ready: true },
        correlation: { continuations: [{ ...task().progress!.correlation.continuations[0], status: "ready" }] },
        resume: { available: true, continuation_id: "continuation-1", method: "POST", path: "/api/paper/continuations/continuation-1", body: { session_id: "session-1" }, reason_code: null },
      },
    });
    renderPanel([ready], onResume);
    expect(screen.getByText("已就绪")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "继续读取" }));
    expect(onResume).toHaveBeenCalledWith(ready);
  });

  it("renders only the normalized safe failure and hides missing or denied resources", () => {
    const failed = task({
      progress: { ...task().progress!, resource: { ...task().progress!.resource, status: "failed", stage: "failed", error: { code: "PAPER_PARSE_FAILED", message: "安全的解析失败" } } },
    });
    renderPanel([
      failed,
      task({ candidate: { ...task().candidate, resourceId: "missing" }, phase: "absent", progress: null }),
      task({ candidate: { ...task().candidate, resourceId: "denied" }, phase: "denied", progress: null }),
    ]);
    expect(screen.getByText("安全的解析失败")).toBeVisible();
    expect(screen.getByTestId("paper-task-resource-1")).toBeVisible();
    expect(screen.queryByTestId("paper-task-missing")).toBeNull();
    expect(screen.queryByTestId("paper-task-denied")).toBeNull();
    expect(screen.queryByText(/pdf_object_key|全文|R2/)).toBeNull();
  });
});
