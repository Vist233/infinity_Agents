import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getPaperResourceProgress,
  normalizePaperResourceProgress,
  resumePaperContinuation,
} from "@/lib/api/papers";

afterEach(() => {
  vi.restoreAllMocks();
});

const PROCESSING = {
  resource: {
    resource_id: "resource-1",
    status: "extracting",
    stage: "extracting",
    source_kind: "arxiv",
    page_count: null,
    image_count: null,
    error: null,
    created_at: 100,
    updated_at: 110,
    ready_at: null,
    pdf_object_key: "must-not-be-exposed",
  },
  revision: "110:100:100",
  materialize: { invocation_status: "succeeded", invocation_event_id: "event-1", invoked_at: 100, resource_ready: false },
  correlation: { continuations: [{ continuation_id: "continuation-1", original_turn_id: "client:1", status: "waiting", expires_at: 200, updated_at: 110, completed_at: null }] },
  events: [{ event_id: "event-1", stage: "materialize", outcome: "succeeded", error_code: null, created_at: 100, metadata_json: "must-not-be-exposed" }],
  resume: { available: false, continuation_id: null, method: "POST", path: null, body: null, reason_code: "PAPER_RESOURCE_NOT_READY" },
};

describe("paper progress API contract", () => {
  it("normalizes safe processing fields and discards object/audit payload details", () => {
    const progress = normalizePaperResourceProgress(PROCESSING, "resource-1");
    expect(progress).toMatchObject({
      resource: { resource_id: "resource-1", status: "extracting", stage: "extracting" },
      materialize: { invocation_status: "succeeded", resource_ready: false },
      resume: { available: false, reason_code: "PAPER_RESOURCE_NOT_READY" },
    });
    expect(progress).not.toHaveProperty("resource.pdf_object_key");
    expect(progress).not.toHaveProperty("events[0].metadata_json");
  });

  it("rejects an invalid or mismatched progress response", () => {
    expect(normalizePaperResourceProgress({ ...PROCESSING, resource: { ...PROCESSING.resource, status: "deleted" } }, "resource-1")).toBeNull();
    expect(normalizePaperResourceProgress(PROCESSING, "another-resource")).toBeNull();
  });

  it("fetches an owner-scoped progress snapshot with an encoded resource and session", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(PROCESSING), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    await getPaperResourceProgress("https://app.test", "session/1", "resource-1");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://app.test/api/paper/resources/resource-1/progress?session_id=session%2F1",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("sends only the session body when resuming the opaque continuation action", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await resumePaperContinuation("https://app.test", "session-1", "continuation/1");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://app.test/api/paper/continuations/continuation%2F1",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        body: JSON.stringify({ session_id: "session-1" }),
      }),
    );
  });
});
