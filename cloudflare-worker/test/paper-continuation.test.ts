import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthedUser } from "../src/auth";
import type { Env } from "../src/env";
import { handleChat, handlePaperContinuation } from "../src/chat";
import { claimPaperRequestContinuation, completePaperRequestContinuation } from "../src/db";
import { materializePaper } from "../src/tools";
import { makeEnv } from "./fake-d1";

const ALICE: AuthedUser = { userId: "alice", email: "alice@example.com", sid: "sid-a" };
const BOB: AuthedUser = { userId: "bob", email: "bob@example.com", sid: "sid-b" };

function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(`data: ${frame}\n\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return { ok: true, status: 200, body: stream } as unknown as Response;
}

async function readSse(response: Response): Promise<Array<Record<string, unknown>>> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events: Array<Record<string, unknown>> = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const raw of frames) {
      const line = raw.trim();
      if (line.startsWith("data:") && line.slice(5).trim() !== "[DONE]") events.push(JSON.parse(line.slice(5).trim()));
    }
  }
  return events;
}

function chatRequest(sessionId: string, content: string, clientRequestId: string): Request {
  return new Request("https://app.test/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      session_id: sessionId,
      client_request_id: clientRequestId,
      messages: [{ role: "user", content }],
    }),
  });
}

function continuationRequest(sessionId: string, continuationId: string): Request {
  return new Request(`https://app.test/api/paper/continuations/${continuationId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session_id: sessionId }),
  });
}

class MemoryBucket {
  objects = new Map<string, Uint8Array>();

  async get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer>; size: number; httpMetadata: { contentType: string } } | null> {
    const value = this.objects.get(key);
    if (!value) return null;
    return {
      arrayBuffer: async () => value.slice().buffer,
      size: value.byteLength,
      httpMetadata: { contentType: "application/json" },
    };
  }
}

function installPaperProviderMock() {
  let calls = 0;
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls += 1;
    const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: Array<Record<string, unknown>> };
    if (calls === 1) {
      return sseResponse([
        JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "materialize-call", function: { name: "materialize_paper", arguments: '{"paper_ref":"arxiv:2401.00001"}' } }] }, finish_reason: "tool_calls" }] }),
      ]);
    }
    if (calls === 2) {
      return sseResponse([
        JSON.stringify({ choices: [{ delta: { content: "现在开始下载并解析 PDF" }, finish_reason: "stop" }] }),
      ]);
    }
    expect(body.messages?.some((message) => message.role === "system" && String(message.content).includes("continue the original paper request"))).toBe(true);
    return sseResponse([
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "read-call", function: { name: "read_paper", arguments: "{\"resource_id\":\"resource-1\",\"mode\":\"text\",\"pages\":[1]}" } }] }, finish_reason: "tool_calls" }] }),
    ]);
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return { fetchMock, calls: () => calls };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PAPER-FIX-01 durable Paper continuation", () => {
  it("does not mark a processing materialization as final completion", async () => {
    const { env, db } = makeEnv();
    db.seedChatSession("s1", "alice");
    db.paperAuth.add("s1|arxiv:2401.00001");
    installPaperProviderMock();

    const events = await readSse(await handleChat(chatRequest("s1", "请下载并解析这篇论文", "paper-request-1"), env, ALICE));
    expect(events).not.toContainEqual(expect.objectContaining({ type: "done" }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "paper_processing",
      status: "processing",
      continuation_id: expect.any(String),
      resource_id: expect.any(String),
    }));
    expect(db.chatEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ event_type: "assistant_message", status: "processing" }),
    ]));
    expect(db.chatEvents.filter((event) => event.event_type === "assistant_message" && event.status === "completed")).toHaveLength(0);
    expect(db.paperRequestContinuations.size).toBe(1);
    const continuation = [...db.paperRequestContinuations.values()][0];
    expect(continuation).toMatchObject({
      session_id: "s1",
      user_id: "alice",
      turn_id: "client:paper-request-1",
      status: "waiting",
    });
    const duplicateMaterialization = JSON.parse(await materializePaper(
      env,
      "s1",
      "alice",
      "arxiv:2401.00001",
      { turnId: "client:paper-request-1", clientRequestId: "paper-request-1" },
    )) as { continuation_id?: string };
    expect(duplicateMaterialization.continuation_id).toBe(continuation.continuation_id);
    expect(db.paperRequestContinuations.size).toBe(1);
  });

  it("rejects a prose-only paper intent without a tool call as a fake success", async () => {
    const { env, db } = makeEnv();
    db.seedChatSession("s1", "alice");
    globalThis.fetch = vi.fn(async () => sseResponse([
      JSON.stringify({ choices: [{ delta: { content: "我可以帮你处理这篇论文。" }, finish_reason: "stop" }] }),
    ])) as unknown as typeof fetch;

    const events = await readSse(await handleChat(chatRequest("s1", "请帮我解析一篇论文", "paper-prose-only"), env, ALICE));
    expect(events).not.toContainEqual(expect.objectContaining({ type: "done" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "error", code: "PAPER_TOOL_CALL_REQUIRED" }));
    expect(db.chatEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ event_type: "assistant_message", status: "failed" }),
      expect.objectContaining({ event_type: "error", status: "failed" }),
    ]));
    expect(db.paperResources).toHaveLength(0);
    expect(db.paperRequestContinuations.size).toBe(0);
  });

  it("re-enters a ready resource through an owned continuation and persists the read", async () => {
    const { env, db } = makeEnv();
    db.seedChatSession("s1", "alice");
    db.paperAuth.add("s1|arxiv:2401.00001");
    const provider = installPaperProviderMock();

    const firstEvents = await readSse(await handleChat(chatRequest("s1", "请下载并解析这篇论文", "paper-request-2"), env, ALICE));
    const continuationId = String(firstEvents.find((event) => event.type === "paper_processing")?.continuation_id);
    const resourceId = String(firstEvents.find((event) => event.type === "paper_processing")?.resource_id);
    const resource = db.paperResources.get(resourceId)!;
    resource.status = "ready";
    resource.text_manifest_key = `paper/${resourceId}/text/manifest.json`;
    resource.image_manifest_key = `paper/${resourceId}/images/manifest.json`;
    resource.page_count = 1;
    const bucket = new MemoryBucket();
    bucket.objects.set(resource.text_manifest_key, new TextEncoder().encode(JSON.stringify({ resource_id: resourceId, pages: [{ page: 1 }] })));
    bucket.objects.set(`paper/${resourceId}/text/pages.jsonl`, new TextEncoder().encode('{"page":1,"text":"durable page text"}\n'));
    bucket.objects.set(resource.image_manifest_key, new TextEncoder().encode(JSON.stringify({ resource_id: resourceId, images: [] })));
    env.RESOURCE_BUCKET = bucket as unknown as Env["RESOURCE_BUCKET"];

    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: Array<Record<string, unknown>> };
      expect(body.messages?.some((message) => message.role === "system" && String(message.content).includes("continue the original paper request"))).toBe(true);
      return sseResponse([
        JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "read-call", function: { name: "read_paper", arguments: JSON.stringify({ resource_id: resourceId, mode: "text", pages: [1] }) } }] }, finish_reason: "tool_calls" }] }),
      ]);
    }) as unknown as typeof fetch;
    // The second provider response consumes the read result and must finish.
    let continuationProviderCall = 0;
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      continuationProviderCall += 1;
      const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: Array<Record<string, unknown>> };
      expect(body.messages?.some((message) => message.role === "system" && String(message.content).includes("continue the original paper request"))).toBe(true);
      if (continuationProviderCall === 1) {
        return sseResponse([
          JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "read-call", function: { name: "read_paper", arguments: JSON.stringify({ resource_id: resourceId, mode: "text", pages: [1] }) } }] }, finish_reason: "tool_calls" }] }),
        ]);
      }
      expect(body.messages?.some((message) => message.role === "tool" && String(message.content).includes("durable page text"))).toBe(true);
      return sseResponse([
        JSON.stringify({ choices: [{ delta: { content: "已读取论文第 1 页。" }, finish_reason: "stop" }] }),
      ]);
    }) as unknown as typeof fetch;

    const resumed = await readSse(await handlePaperContinuation(continuationRequest("s1", continuationId), env, ALICE));
    expect(resumed).toContainEqual(expect.objectContaining({ type: "done" }));
    expect(resumed).toContainEqual(expect.objectContaining({ type: "tool_result", tool_name: "read_paper", status: "succeeded" }));
    expect(db.paperRequestContinuations.get(continuationId)).toMatchObject({ status: "completed", active_turn_id: null });
    expect(db.chatEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ event_type: "system_status", status: "paper_continuation" }),
      expect.objectContaining({ event_type: "tool_call", tool_name: "read_paper" }),
      expect.objectContaining({ event_type: "tool_result", tool_call_id: "read-call" }),
      expect.objectContaining({ event_type: "assistant_message", content: "已读取论文第 1 页。" }),
    ]));
    expect(provider.calls()).toBe(2);
  });

  it("reclaims one stale continuation lease and rejects a live duplicate", async () => {
    const { env, db } = makeEnv();
    db.seedChatSession("s1", "alice");
    db.paperAuth.add("s1|arxiv:2401.00001");
    installPaperProviderMock();

    const firstEvents = await readSse(await handleChat(chatRequest("s1", "请下载并解析这篇论文", "paper-request-lease"), env, ALICE));
    const continuationId = String(firstEvents.find((event) => event.type === "paper_processing")?.continuation_id);
    const row = db.paperRequestContinuations.get(continuationId)!;
    const resource = db.paperResources.get(row.resource_id)!;
    resource.status = "ready";

    const now = Math.floor(Date.now() / 1000);
    row.status = "running";
    row.active_turn_id = "stale-run";
    row.lease_expires_at = now - 1;
    row.expires_at = now + 3600;

    const reclaimed = await claimPaperRequestContinuation(env, {
      continuationId,
      userId: "alice",
      sessionId: "s1",
      runTurnId: "fresh-run",
      now,
      leaseExpiresAt: now + 300,
    });
    expect(reclaimed).toMatchObject({ status: "running", active_turn_id: "fresh-run" });

    const duplicate = await claimPaperRequestContinuation(env, {
      continuationId,
      userId: "alice",
      sessionId: "s1",
      runTurnId: "duplicate-run",
      now: now + 1,
      leaseExpiresAt: now + 301,
    });
    expect(duplicate).toBeNull();
  });

  it("does not complete a running continuation after its absolute expiry", async () => {
    const { env, db } = makeEnv();
    db.seedChatSession("s1", "alice");
    db.paperAuth.add("s1|arxiv:2401.00001");
    installPaperProviderMock();

    const firstEvents = await readSse(await handleChat(chatRequest("s1", "请下载并解析这篇论文", "paper-request-expiry"), env, ALICE));
    const continuationId = String(firstEvents.find((event) => event.type === "paper_processing")?.continuation_id);
    const row = db.paperRequestContinuations.get(continuationId)!;
    db.paperResources.get(row.resource_id)!.status = "ready";
    const now = Math.floor(Date.now() / 1000);
    row.status = "ready";

    const claimed = await claimPaperRequestContinuation(env, {
      continuationId,
      userId: "alice",
      sessionId: "s1",
      runTurnId: "expiring-run",
      now,
      leaseExpiresAt: now + 300,
    });
    expect(claimed).not.toBeNull();
    row.expires_at = now - 1;

    expect(await completePaperRequestContinuation(env, {
      continuationId,
      userId: "alice",
      sessionId: "s1",
      runTurnId: "expiring-run",
      responseText: "should not complete",
      now,
    })).toBe(false);
    expect(row.status).toBe("running");
  });

  it("releases a ready continuation when the provider returns prose without a read or image tool", async () => {
    const { env, db } = makeEnv();
    db.seedChatSession("s1", "alice");
    db.paperAuth.add("s1|arxiv:2401.00001");
    installPaperProviderMock();

    const firstEvents = await readSse(await handleChat(chatRequest("s1", "请下载并解析这篇论文", "paper-request-continuation-prose"), env, ALICE));
    const continuationId = String(firstEvents.find((event) => event.type === "paper_processing")?.continuation_id);
    const row = db.paperRequestContinuations.get(continuationId)!;
    db.paperResources.get(row.resource_id)!.status = "ready";
    globalThis.fetch = vi.fn(async () => sseResponse([
      JSON.stringify({ choices: [{ delta: { content: "论文已经准备好了。" }, finish_reason: "stop" }] }),
    ])) as unknown as typeof fetch;

    const resumed = await readSse(await handlePaperContinuation(continuationRequest("s1", continuationId), env, ALICE));
    expect(resumed).not.toContainEqual(expect.objectContaining({ type: "done" }));
    expect(resumed).toContainEqual(expect.objectContaining({ type: "error", code: "PAPER_CONTINUATION_TOOL_REQUIRED" }));
    expect(db.paperRequestContinuations.get(continuationId)).toMatchObject({ status: "ready", active_turn_id: null });
  });

  it("rejects cross-user, expired, and duplicate continuation execution", async () => {
    const { env, db } = makeEnv();
    db.seedChatSession("s1", "alice");
    db.seedChatSession("s2", "bob");
    db.paperAuth.add("s1|arxiv:2401.00001");
    installPaperProviderMock();
    const firstEvents = await readSse(await handleChat(chatRequest("s1", "请下载并解析这篇论文", "paper-request-3"), env, ALICE));
    const continuationId = String(firstEvents.find((event) => event.type === "paper_processing")?.continuation_id);
    const row = db.paperRequestContinuations.get(continuationId)!;
    db.paperResources.get(row.resource_id)!.status = "ready";

    expect((await handlePaperContinuation(continuationRequest("s1", continuationId), env, BOB)).status).toBe(404);

    row.status = "ready";
    row.expires_at = Math.floor(Date.now() / 1000) - 1;
    const expired = await handlePaperContinuation(continuationRequest("s1", continuationId), env, ALICE);
    expect(expired.status).toBe(410);
    expect(await expired.json()).toMatchObject({ error: { code: "PAPER_CONTINUATION_EXPIRED" } });

    row.status = "completed";
    row.expires_at = Math.floor(Date.now() / 1000) + 3600;
    const duplicate = await handlePaperContinuation(continuationRequest("s1", continuationId), env, ALICE);
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({ error: { code: "PAPER_CONTINUATION_COMPLETED" } });
  });
});
