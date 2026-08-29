import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPaperResourceProgress, resumePaperContinuation } from "@/lib/api/papers";
import { usePaperProgress, PAPER_PROGRESS_POLL_DELAYS_MS } from "@/hooks/use-paper-progress";
import type { ToolTimelineEntry } from "@/lib/chat-state";

vi.mock("@/lib/api/papers", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api/papers")>("@/lib/api/papers");
  return {
    ...actual,
    getPaperResourceProgress: vi.fn(),
    resumePaperContinuation: vi.fn(),
  };
});

const getProgressMock = vi.mocked(getPaperResourceProgress);
const resumeMock = vi.mocked(resumePaperContinuation);

const timeline: ToolTimelineEntry[] = [{
  correlationId: "turn-1",
  toolCallId: "call-1",
  toolName: "materialize_paper",
  status: "succeeded",
  summary: JSON.stringify({ mode: "processing", resource_id: "resource-1", continuation_id: "continuation-1" }),
}];

function progress(status: "extracting" | "ready" | "failed", resumeAvailable = false) {
  return {
    resource: {
      resource_id: "resource-1",
      status,
      stage: status,
      source_kind: "arxiv" as const,
      title: "Safe title",
      page_count: status === "ready" ? 4 : null,
      image_count: status === "ready" ? 2 : null,
      error: status === "failed" ? { code: "PAPER_PARSE_FAILED", message: "PDF parsing failed safely" } : null,
      created_at: 100,
      updated_at: 110,
      ready_at: status === "ready" ? 110 : null,
    },
    revision: `${status}:110`,
    materialize: {
      invocation_status: "succeeded" as const,
      invocation_event_id: "event-1",
      invoked_at: 100,
      resource_ready: status === "ready",
    },
    correlation: {
      continuations: [{
        continuation_id: "continuation-1",
        original_turn_id: "turn-1",
        status: resumeAvailable ? "ready" as const : "waiting" as const,
        expires_at: 200,
        updated_at: 110,
        completed_at: null,
      }],
    },
    events: [{ event_id: "event-1", stage: "materialize" as const, outcome: "succeeded" as const, error_code: null, created_at: 100 }],
    resume: resumeAvailable
      ? { available: true, continuation_id: "continuation-1", method: "POST" as const, path: "/api/paper/continuations/continuation-1", body: { session_id: "session-1" }, reason_code: null }
      : { available: false, continuation_id: null, method: "POST" as const, path: null, body: null, reason_code: "PAPER_RESOURCE_NOT_READY" },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("usePaperProgress", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    getProgressMock.mockReset();
    resumeMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("polls an active resource and stops after the server reports a terminal ready state", async () => {
    getProgressMock.mockResolvedValueOnce(progress("extracting")).mockResolvedValueOnce(progress("ready", true));
    const { result } = renderHook(() => usePaperProgress({ apiBase: "https://app.test", sessionId: "session-1", toolTimeline: timeline }));

    await act(async () => { await Promise.resolve(); });
    expect(result.current.tasks[0].progress?.resource.status).toBe("extracting");
    expect(getProgressMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(PAPER_PROGRESS_POLL_DELAYS_MS[0]);
      await Promise.resolve();
    });
    expect(result.current.tasks[0].progress?.resource.status).toBe("ready");
    expect(result.current.tasks[0].phase).toBe("progress");

    await act(async () => {
      vi.advanceTimersByTime(PAPER_PROGRESS_POLL_DELAYS_MS[PAPER_PROGRESS_POLL_DELAYS_MS.length - 1]);
      await Promise.resolve();
    });
    expect(getProgressMock).toHaveBeenCalledTimes(2);
  });

  it("treats missing and non-owner resources as absent or denied without a visible card", async () => {
    getProgressMock.mockRejectedValueOnce(Object.assign(new Error("not found"), { status: 404 }));
    const { result } = renderHook(() => usePaperProgress({ apiBase: "https://app.test", sessionId: "session-1", toolTimeline: timeline }));
    await act(async () => { await Promise.resolve(); });
    expect(result.current.tasks[0].phase).toBe("absent");
    expect(result.current.visibleTasks).toEqual([]);

    getProgressMock.mockRejectedValueOnce(Object.assign(new Error("forbidden"), { status: 403 }));
    const second = renderHook(() => usePaperProgress({ apiBase: "https://app.test", sessionId: "session-1", toolTimeline: timeline }));
    await act(async () => { await Promise.resolve(); });
    expect(second.result.current.tasks[0].phase).toBe("denied");
    expect(second.result.current.visibleTasks).toEqual([]);
  });

  it("dispatches one authenticated resume action while duplicate clicks are in flight", async () => {
    getProgressMock.mockResolvedValue(progress("ready", true));
    let resolveResume!: (response: Response) => void;
    resumeMock.mockReturnValueOnce(new Promise<Response>((resolve) => { resolveResume = resolve; }));
    const { result } = renderHook(() => usePaperProgress({ apiBase: "https://app.test", sessionId: "session-1", toolTimeline: timeline }));
    await act(async () => { await Promise.resolve(); });

    let first!: Promise<void>;
    await act(async () => {
      first = result.current.resumeTask("resource-1");
      await Promise.resolve();
    });
    expect(result.current.tasks[0].resuming).toBe(true);
    const duplicate = result.current.resumeTask("resource-1");
    expect(resumeMock).toHaveBeenCalledTimes(1);
    expect(resumeMock).toHaveBeenCalledWith("https://app.test", "session-1", "continuation-1");

    resolveResume(new Response("data: {\"type\":\"done\"}\n\n", { headers: { "content-type": "text/event-stream" } }));
    await act(async () => {
      await Promise.all([first, duplicate]);
    });
    expect(result.current.tasks[0].resuming).toBe(false);
  });

  it("keeps only the normalized server-safe failure message", async () => {
    getProgressMock.mockResolvedValue(progress("failed"));
    const { result } = renderHook(() => usePaperProgress({ apiBase: "https://app.test", sessionId: "session-1", toolTimeline: timeline }));
    await act(async () => { await Promise.resolve(); });
    expect(result.current.tasks[0].progress?.resource.error?.message).toBe("PDF parsing failed safely");
    expect(result.current.tasks[0]).not.toHaveProperty("pdf_object_key");
  });

  it("discards continuation events after the owning session generation changes", async () => {
    getProgressMock.mockResolvedValue(progress("ready", true));
    let resolveResume!: (response: Response) => void;
    resumeMock.mockReturnValueOnce(new Promise<Response>((resolve) => { resolveResume = resolve; }));
    const onContinuationEvent = vi.fn();
    const { result, rerender } = renderHook(
      ({ currentSessionId }: { currentSessionId: string }) => usePaperProgress({
        apiBase: "https://app.test",
        sessionId: currentSessionId,
        toolTimeline: timeline,
        onContinuationEvent,
      }),
      { initialProps: { currentSessionId: "session-1" } },
    );
    await act(async () => { await Promise.resolve(); });
    let oldResume!: Promise<void>;
    await act(async () => {
      oldResume = result.current.resumeTask("resource-1");
      await Promise.resolve();
    });
    await act(async () => {
      rerender({ currentSessionId: "session-2" });
      await Promise.resolve();
    });

    await act(async () => {
      resolveResume(new Response([
        `data: ${JSON.stringify({ type: "chunk", content: "must be discarded" })}\n\n`,
        `data: ${JSON.stringify({ type: "done" })}\n\n`,
      ].join(""), { headers: { "content-type": "text/event-stream" } }));
      await oldResume;
    });
    expect(onContinuationEvent).not.toHaveBeenCalled();
  });
});
