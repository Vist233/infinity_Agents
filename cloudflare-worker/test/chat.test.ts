import { afterEach, describe, expect, it, vi } from "vitest";
import { handleCancelChatTaskConfirmation, handleChat, rebuildModelMessages } from "../src/chat";
import { makeEnv } from "./fake-d1";
import type { AuthedUser } from "../src/auth";
import type { ChatEventRow } from "../src/db";

const ARXIV_XML = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2401.00001</id>
    <title>Attention Is Somewhat All You Need</title>
    <summary>A study of attention mechanisms in sequence models.</summary>
    <published>2024-01-01T00:00:00Z</published>
    <author><name>Ada Lovelace</name></author>
    <link title="pdf" href="https://arxiv.org/pdf/2401.00001"/>
  </entry>
</feed>`;

function textResponse(body: string): Response {
  return {
    ok: true,
    status: 200,
    text: async () => body,
    json: async () => JSON.parse(body)
  } as unknown as Response;
}

function errorResponse(status: number, body: string, retryAfter?: string): Response {
  return {
    ok: false,
    status,
    headers: new Headers(retryAfter ? { "retry-after": retryAfter } : undefined),
    text: async () => body,
  } as unknown as Response;
}

function jsonResponse(body: object): Response {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
    json: async () => body
  } as unknown as Response;
}

/** Build a StepFun-style SSE streaming Response from an array of frame strings. */
function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(encoder.encode(`data: ${frame}\n\n`));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    }
  });
  return { ok: true, status: 200, body: stream } as unknown as Response;
}

function interruptedResponse(): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new Error("upstream stream interrupted"));
    },
  });
  return { ok: true, status: 200, body: stream } as unknown as Response;
}

/**
 * Two-turn StepFun mock: the first completion asks to call search_paper, the
 * second (after the tool result is fed back) streams the final answer.
 */
function installStepFunMock() {
  let stepfunCall = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);

    if (url.includes("stepfun.test")) {
      stepfunCall += 1;
      if (stepfunCall === 1) {
        return sseResponse([
          JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_1",
                      function: { name: "search_paper", arguments: '{"query":"attention"}' }
                    }
                  ]
                },
                finish_reason: "tool_calls"
              }
            ]
          })
        ]);
      }
      return sseResponse([
        JSON.stringify({ choices: [{ delta: { content: "Found " }, finish_reason: null }] }),
        JSON.stringify({ choices: [{ delta: { content: "1 paper." }, finish_reason: "stop" }] })
      ]);
    }

    // Paper-tool upstreams.
    if (url.includes("export.arxiv.org")) return textResponse(ARXIV_XML);
    if (url.includes("esearch.fcgi")) return jsonResponse({ esearchresult: { idlist: [] } });
    return textResponse("");
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return { fetchMock, stepfunCalls: () => stepfunCall };
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
      if (!line.startsWith("data:")) continue;
      events.push(JSON.parse(line.slice(5).trim()));
    }
  }
  return events;
}

const USER: AuthedUser = { userId: "user-1", email: "demo@example.com", sid: "sid-1" };

function makeRequest(sessionId: string, content: string, clientRequestId?: string): Request {
  return new Request("https://app.test/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      session_id: sessionId,
      messages: [{ role: "user", content }],
      ...(clientRequestId ? { client_request_id: clientRequestId } : {}),
    })
  });
}

function makeConfirmationRequest(sessionId: string, confirmationId: string, taskId: string): Request {
  return new Request("https://app.test/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      session_id: sessionId,
      task_confirmation_id: confirmationId,
      task_id: taskId,
      messages: [],
    }),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("handleChat", () => {
  it("uses the mainland Kimi chat-completions contract", async () => {
    const { env, db } = makeEnv({
      MODEL_BASE_URL: "https://api.moonshot.cn/v1",
      MODEL_ID: "kimi-k2.6",
      MODEL_API_KEY: "kimi-test-key",
    });
    db.seedChatSession("kimi-session", "user-1");
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://api.moonshot.cn/v1/chat/completions");
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer kimi-test-key");
      const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string; stream?: boolean };
      expect(body).toMatchObject({ model: "kimi-k2.6", stream: true });
      return sseResponse([
        JSON.stringify({ choices: [{ delta: { content: "国内站" }, finish_reason: "stop" }] }),
      ]);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const response = await handleChat(makeRequest("kimi-session", "hello"), env, USER);
    expect(response.status).toBe(200);
      const events = await readSse(response);
    expect(events.filter((event) => event.type === "chunk").map((event) => event.content).join("")).toBe("国内站");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("runs the StepFun tool loop end-to-end and streams the final answer", async () => {
    const { env, db } = makeEnv();
    db.seedChatSession("s1", "user-1");
    const { fetchMock, stepfunCalls } = installStepFunMock();

    const response = await handleChat(makeRequest("s1", "find attention papers"), env, USER);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const events = await readSse(response);
    const types = events.map((e) => e.type);

    // The loop surfaces a tool call, then streams content and finishes.
    expect(types).toContain("tool_call");
    expect(types).toContain("tool_result");
    expect(types).toContain("chunk");
    expect(types).toContain("done");
    expect(events.find((e) => e.type === "status")).toMatchObject({ correlation_id: expect.any(String) });
    expect(events.find((e) => e.type === "tool_call" && e.status === "processing")).toMatchObject({
      correlation_id: expect.any(String),
      tool_call_id: "call_1",
      tool_name: "search_paper",
      status: "processing",
    });
    expect(events.find((e) => e.type === "tool_result")).toMatchObject({
      correlation_id: expect.any(String),
      tool_call_id: "call_1",
      tool_name: "search_paper",
      status: "succeeded",
    });
    expect(events.find((e) => e.type === "tool_result")).not.toHaveProperty("object_key");

    const finalText = events
      .filter((e) => e.type === "chunk")
      .map((e) => e.content as string)
      .join("");
    expect(finalText).toBe("Found 1 paper.");

    // StepFun was called twice (initial + after tool result); the paper tool ran.
    expect(stepfunCalls()).toBe(2);
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("export.arxiv.org"))).toBe(true);

    // The user turn, exact tool call/result, and assistant answer are persisted
    // in the canonical event ledger; legacy chat_messages is not dual-written.
    expect(db.chatMessages).toHaveLength(0);
    expect(db.chatEvents.map((event) => event.event_type)).toEqual([
      "user_message",
      "tool_call",
      "tool_result",
      "assistant_message",
    ]);
    expect(db.chatEvents.find((event) => event.event_type === "tool_call")).toMatchObject({
      tool_call_id: "call_1",
      tool_name: "search_paper",
      tool_arguments_json: '{"query":"attention"}',
      status: "pending",
    });
    expect(db.chatEvents.find((event) => event.event_type === "tool_result")).toMatchObject({
      tool_call_id: "call_1",
      status: "succeeded",
    });
    expect(db.chatEvents.find((event) => event.event_type === "assistant_message")?.content).toBe("Found 1 paper.");

    // One conversation consumed exactly one daily-quota unit.
    expect([...db.dailyUsage.values()][0]).toBe(1);
  });

  it("synthesizes materialize_paper after a paper-intent provider repeats search_paper", async () => {
    const { env, db } = makeEnv();
    db.seedChatSession("paper-search-loop", "user-1");
    let providerCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("stepfun.test")) {
        providerCalls += 1;
        return sseResponse([
          JSON.stringify({
            choices: [{
              delta: {
                tool_calls: [{
                  index: 0,
                  id: `search-${providerCalls}`,
                  function: { name: "search_paper", arguments: '{"query":"attention"}' },
                }],
              },
              finish_reason: "tool_calls",
            }],
          }),
        ]);
      }
      if (url.includes("export.arxiv.org")) return textResponse(ARXIV_XML);
      if (url.includes("esearch.fcgi")) return jsonResponse({ esearchresult: { idlist: [] } });
      return textResponse("");
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const events = await readSse(await handleChat(
      makeRequest("paper-search-loop", "搜索一篇开放获取论文，下载并解析 PDF", "paper-search-loop-request"),
      env,
      USER,
    ));

    expect(providerCalls).toBe(6);
    expect(events).not.toContainEqual(expect.objectContaining({ type: "done" }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "paper_processing",
      status: "processing",
      resource_id: expect.any(String),
      continuation_id: expect.any(String),
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "tool_call",
      tool_name: "materialize_paper",
      status: "processing",
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "tool_result",
      tool_name: "materialize_paper",
      status: "succeeded",
    }));
    expect(db.paperResources.size).toBe(1);
    expect(db.paperRequestContinuations.size).toBe(1);
    expect(db.chatEvents.filter((event) => event.event_type === "tool_call").map((event) => event.tool_name))
      .toEqual(["search_paper", "search_paper", "search_paper", "search_paper", "search_paper", "search_paper", "materialize_paper"]);
  });

  it("fails a paper-intent search loop when only an abstract-only PubMed candidate is available", async () => {
    const { env, db } = makeEnv();
    db.seedChatSession("paper-no-materialize", "user-1");
    let providerCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("stepfun.test")) {
        providerCalls += 1;
        return sseResponse([
          JSON.stringify({
            choices: [{
              delta: {
                tool_calls: [{
                  index: 0,
                  id: `pubmed-search-${providerCalls}`,
                  function: { name: "search_paper", arguments: '{"query":"attention"}' },
                }],
              },
              finish_reason: "tool_calls",
            }],
          }),
        ]);
      }
      if (url.includes("export.arxiv.org")) return textResponse("<feed></feed>");
      if (url.includes("esearch.fcgi")) return jsonResponse({ esearchresult: { idlist: ["111"] } });
      if (url.includes("esummary.fcgi")) return jsonResponse({ result: { "111": { title: "Abstract-only paper", authors: [], pubdate: "2024" } } });
      return textResponse("");
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const events = await readSse(await handleChat(
      makeRequest("paper-no-materialize", "搜索一篇论文，下载并解析 PDF", "paper-no-materialize-request"),
      env,
      USER,
    ));

    expect(providerCalls).toBe(6);
    expect(events).not.toContainEqual(expect.objectContaining({ type: "done" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "error", code: "PAPER_MATERIALIZE_REQUIRED" }));
    expect(db.paperResources.size).toBe(0);
    expect(db.chatEvents.filter((event) => event.event_type === "tool_call" && event.tool_name === "materialize_paper"))
      .toHaveLength(0);
    expect(db.chatEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ event_type: "assistant_message", status: "failed" }),
      expect.objectContaining({ event_type: "error", status: "failed" }),
    ]));
  });

  it("rejects a session the user does not own", async () => {
    const { env, db } = makeEnv();
    db.seedChatSession("s1", "someone-else");
    installStepFunMock();

    const response = await handleChat(makeRequest("s1", "hi"), env, USER);
    expect(response.status).toBe(404);
  });

  it("returns 429 and does not call StepFun once the daily quota is exhausted", async () => {
    const { env, db } = makeEnv({ DAILY_QUOTA: "1" });
    db.seedChatSession("s1", "user-1");
    const { stepfunCalls } = installStepFunMock();

    const first = await handleChat(makeRequest("s1", "one"), env, USER);
    await readSse(first); // drain the first (allowed) conversation
    const callsAfterFirst = stepfunCalls();

    const second = await handleChat(makeRequest("s1", "two"), env, USER);
    expect(second.status).toBe(429);
    // The over-limit request never reaches StepFun.
    expect(stepfunCalls()).toBe(callsAfterFirst);
  });

  it("retries a transient overloaded model response before executing the paper tool loop", async () => {
    const { env, db } = makeEnv();
    db.seedChatSession("retry-model", "user-1");
    let providerCalls = 0;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("stepfun.test")) {
        providerCalls += 1;
        if (providerCalls === 1) return errorResponse(429, '{"error":"overloaded"}');
        if (providerCalls > 2) {
          return sseResponse([
            JSON.stringify({ choices: [{ delta: { content: "Found a paper after retry." }, finish_reason: "stop" }] }),
          ]);
        }
        return sseResponse([
          JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "search-after-retry", function: { name: "search_paper", arguments: '{"query":"attention"}' } }] }, finish_reason: "tool_calls" }] }),
        ]);
      }
      if (url.includes("export.arxiv.org")) return textResponse(ARXIV_XML);
      if (url.includes("esearch.fcgi")) return jsonResponse({ esearchresult: { idlist: [] } });
      return textResponse("");
    }) as unknown as typeof fetch;

    const events = await readSse(await handleChat(
      makeRequest("retry-model", "搜索 attention 论文", "retry-model-request"),
      env,
      USER,
    ));

    expect(providerCalls).toBeGreaterThanOrEqual(2);
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_result", tool_name: "search_paper", status: "succeeded" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "done" }));
  });

  it("pauses task creation for an inline confirmation and resumes with the queued task result", async () => {
    const { env, db } = makeEnv();
    db.seedChatSession("s1", "user-1");
    let stepfunCall = 0;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(input).includes("stepfun.test")) return textResponse("");
      stepfunCall += 1;
      if (stepfunCall === 1) {
        return sseResponse([
          JSON.stringify({ choices: [{ delta: { content: "我先准备任务确认卡。" }, finish_reason: null }] }),
          JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "task_call_1", function: { name: "request_task_creation", arguments: JSON.stringify({ title: "Trait extraction", analysis_type: "trait_extraction", method_document_content: "# Extract traits\n\n1. Read the input.\n2. Write a report." }) } }] }, finish_reason: "tool_calls" }] }),
        ]);
      }
      const requestBody = JSON.parse(String(init?.body ?? "{}")) as { messages?: Array<{ role: string; content: string | null }> };
      expect(requestBody.messages?.some((message) => message.role === "tool" && String(message.content).includes("task-1"))).toBe(true);
      return sseResponse([
        JSON.stringify({ choices: [{ delta: { content: "任务已排队，将在后台异步执行。" }, finish_reason: "stop" }] }),
      ]);
    }) as unknown as typeof fetch;

    const first = await handleChat(makeRequest("s1", "创建一个性状提取任务"), env, USER);
    const firstEvents = await readSse(first);
    expect(firstEvents.map((event) => event.type)).toEqual([
      "status",
      "status",
      "chunk",
      "tool_call",
      "tool_call",
      "status",
      "task_confirmation",
    ]);
    expect(firstEvents.map((event) => event.type)).not.toContain("done");
    expect(firstEvents.find((event) => event.type === "task_confirmation")).toMatchObject({
      method_document_content: "# Extract traits\n\n1. Read the input.\n2. Write a report.",
    });
    const confirmation = [...db.chatTaskConfirmations.values()][0];
    expect(confirmation?.status).toBe("pending");
    expect([...db.dailyUsage.values()][0]).toBe(1);

    db.seedTask("task-1", "user-1", "Trait extraction", "queued", confirmation.confirmation_id);
    const second = await handleChat(makeConfirmationRequest("s1", confirmation.confirmation_id, "task-1"), env, USER);
    const secondEvents = await readSse(second);
    expect(secondEvents.map((event) => event.type)).toContain("done");
    expect(secondEvents.filter((event) => event.type === "chunk").map((event) => event.content).join(""))
      .toBe("任务已排队，将在后台异步执行。");
    expect(confirmation.status).toBe("completed");
    expect(stepfunCall).toBe(2);
    expect([...db.dailyUsage.values()][0]).toBe(1);
  });

  it("lets the user dismiss a pending confirmation without creating a task", async () => {
    const { env, db } = makeEnv();
    db.seedChatSession("s1", "user-1");
    installStepFunMock();
    const first = await handleChat(makeRequest("s1", "我要创建一个异步分析任务"), env, USER);
    await readSse(first);
    const confirmation = [...db.chatTaskConfirmations.values()][0];
    expect(confirmation?.status).toBe("pending");

    const response = await handleCancelChatTaskConfirmation(
      new Request("https://app.test/api/chat/task-confirmation/cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmation_id: confirmation.confirmation_id }),
      }),
      env,
      USER,
    );
    expect(response.status).toBe(200);
    expect(confirmation.status).toBe("expired");
    expect(db.tasks.size).toBe(0);
  });

  it("forces a confirmation card for explicit task intent when the model only asks questions", async () => {
    const { env, db } = makeEnv();
    db.seedChatSession("s1", "user-1");
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(input).includes("stepfun.test")) return textResponse("");
      const body = JSON.parse(String(init?.body ?? "{}")) as { tool_choice?: unknown };
      expect(body.tool_choice).toEqual({ type: "function", function: { name: "request_task_creation" } });
      return sseResponse([
        JSON.stringify({ choices: [{ delta: { content: "请先告诉我更多细节。" }, finish_reason: "stop" }] }),
      ]);
    }) as unknown as typeof fetch;

    const response = await handleChat(makeRequest("s1", "我要创建一个异步分析任务"), env, USER);
    const events = await readSse(response);
    expect(events.find((event) => event.type === "tool_call")?.tool_name).toBe("request_task_creation");
    expect(events.map((event) => event.type)).toContain("task_confirmation");
    expect([...db.chatTaskConfirmations.values()][0]?.status).toBe("pending");
  });

  it("replays an existing confirmation instead of spending quota on a retried client request", async () => {
    const { env, db } = makeEnv();
    db.seedChatSession("s1", "user-1");
    let stepfunCall = 0;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (!String(input).includes("stepfun.test")) return textResponse("");
      stepfunCall += 1;
      return sseResponse([
        JSON.stringify({ choices: [{ delta: { content: "请在下面确认任务信息。" }, finish_reason: "stop" }] }),
      ]);
    }) as unknown as typeof fetch;

    const first = await handleChat(makeRequest("s1", "我要创建一个异步分析任务", "request-1"), env, USER);
    const firstEvents = await readSse(first);
    const confirmation = [...db.chatTaskConfirmations.values()][0];
    expect(firstEvents.map((event) => event.type)).toContain("task_confirmation");
    expect(confirmation).toBeTruthy();

    const retry = await handleChat(makeRequest("s1", "我要创建一个异步分析任务", "request-1"), env, USER);
    const retryEvents = await readSse(retry);
    expect(retryEvents.map((event) => event.type)).toEqual(["task_confirmation"]);
    expect(stepfunCall).toBe(1);
    expect([...db.dailyUsage.values()][0]).toBe(1);
  });

  it("retries without tool_choice when a provider rejects the optional hint", async () => {
    const { env, db } = makeEnv();
    db.seedChatSession("s1", "user-1");
    const requestBodies: Array<Record<string, unknown>> = [];
    let stepfunCall = 0;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(input).includes("stepfun.test")) return textResponse("");
      stepfunCall += 1;
      requestBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      if (stepfunCall === 1) {
        return {
          ok: false,
          status: 400,
          text: async () => "tool_choice is unsupported",
        } as unknown as Response;
      }
      return sseResponse([
        JSON.stringify({ choices: [{ delta: { content: "我已准备好任务确认卡。" }, finish_reason: "stop" }] }),
      ]);
    }) as unknown as typeof fetch;

    const response = await handleChat(makeRequest("s1", "我要创建一个异步分析任务"), env, USER);
    const events = await readSse(response);
    expect(requestBodies[0]?.tool_choice).toEqual({ type: "function", function: { name: "request_task_creation" } });
    expect(requestBodies[1]?.tool_choice).toBeUndefined();
    expect(events.map((event) => event.type)).toContain("task_confirmation");
    expect([...db.chatTaskConfirmations.values()][0]?.status).toBe("pending");
  });

  it("persists multiple tool calls in index order even when stream chunks arrive out of order", async () => {
    const { env, db } = makeEnv();
    db.seedChatSession("s1", "user-1");
    let stepfunCall = 0;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.includes("stepfun.test")) {
        if (url.includes("export.arxiv.org")) return textResponse(ARXIV_XML);
        return jsonResponse({ esearchresult: { idlist: [] } });
      }
      stepfunCall += 1;
      if (stepfunCall === 1) {
        return sseResponse([
          JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 1, id: "call-1", function: { name: "search_paper", arguments: '{"query":"one"}' } }] }, finish_reason: null }] }),
          JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call-0", function: { name: "search_paper", arguments: '{ "query": "zero" }' } }] }, finish_reason: null }] }),
          JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
        ]);
      }
      const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: Array<Record<string, unknown>> };
      const assistant = body.messages?.find((message) => message.role === "assistant" && Array.isArray(message.tool_calls));
      expect((assistant?.tool_calls as Array<{ id: string }>).map((call) => call.id)).toEqual(["call-0", "call-1"]);
      const results = body.messages?.filter((message) => message.role === "tool");
      expect(results?.map((result) => result.tool_call_id)).toEqual(["call-0", "call-1"]);
      return sseResponse([JSON.stringify({ choices: [{ delta: { content: "两个结果已整理。" }, finish_reason: "stop" }] })]);
    }) as unknown as typeof fetch;

    const response = await handleChat(makeRequest("s1", "find two papers"), env, USER);
    await readSse(response);
    expect(stepfunCall).toBe(2);
    expect(db.chatEvents.filter((event) => event.event_type === "tool_call").map((event) => event.tool_call_id))
      .toEqual(["call-0", "call-1"]);
  });

  it("rebuilds a durable tool call/result pair for the next request after refresh", async () => {
    const { env, db } = makeEnv();
    db.seedChatSession("s1", "user-1");
    installStepFunMock();
    await readSse(await handleChat(makeRequest("s1", "find attention papers"), env, USER));

    const replay = { body: null as { messages?: Array<Record<string, unknown>> } | null };
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("stepfun.test")) {
        replay.body = JSON.parse(String(init?.body ?? "{}")) as { messages?: Array<Record<string, unknown>> };
        return sseResponse([JSON.stringify({ choices: [{ delta: { content: "已从历史工具结果继续。" }, finish_reason: "stop" }] })]);
      }
      return textResponse("");
    }) as unknown as typeof fetch;

    await readSse(await handleChat(makeRequest("s1", "continue", "refresh-1"), env, USER));
    const assistant = replay.body?.messages?.find((message) => message.role === "assistant" && Array.isArray(message.tool_calls));
    expect(assistant).toMatchObject({ tool_calls: [{ id: "call_1", function: { name: "search_paper", arguments: '{"query":"attention"}' } }] });
    expect(replay.body?.messages?.some((message) => message.role === "tool" && message.tool_call_id === "call_1")).toBe(true);
  });

  it("replays a completed idempotent request without calling the provider again", async () => {
    const { env, db } = makeEnv();
    db.seedChatSession("s1", "user-1");
    const { stepfunCalls } = installStepFunMock();
    await readSse(await handleChat(makeRequest("s1", "find attention papers", "same-request"), env, USER));
    const eventCount = db.chatEvents.length;

    const retry = await handleChat(makeRequest("s1", "find attention papers", "same-request"), env, USER);
    expect((await readSse(retry)).map((event) => event.type)).toEqual(["chunk", "done"]);
    expect(stepfunCalls()).toBe(2);
    expect(db.chatEvents).toHaveLength(eventCount);
  });

  it("records a failed tool result and terminal error, then releases the idempotency guard", async () => {
    const { env, db } = makeEnv();
    db.seedChatSession("s1", "user-1");
    db.failNextPaperCacheRead = true;
    const { stepfunCalls } = installStepFunMock();

    const response = await handleChat(makeRequest("s1", "find attention papers", "tool-failure"), env, USER);
    const events = await readSse(response);
    expect(events.some((event) => event.type === "error")).toBe(true);
    expect(db.chatEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ event_type: "tool_result", status: "failed", tool_call_id: "call_1" }),
      expect.objectContaining({ event_type: "error", status: "failed" }),
    ]));
    expect(db.chatRequestIdempotency.size).toBe(0);
    expect(stepfunCalls()).toBe(1);
  });

  it("releases idempotency and records a terminal event when the first D1 event write fails", async () => {
    const { env, db } = makeEnv();
    db.seedChatSession("s1", "user-1");
    db.failNextChatEventInsert = true;

    await expect(handleChat(makeRequest("s1", "hello", "d1-failure"), env, USER)).rejects.toThrow("D1 write failed");
    expect(db.chatRequestIdempotency.size).toBe(0);
    expect(db.chatEvents).toEqual([expect.objectContaining({ event_type: "error", status: "failed" })]);
  });

  it("records a terminal error for an interrupted provider stream", async () => {
    const { env, db } = makeEnv();
    db.seedChatSession("s1", "user-1");
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("stepfun.test")) return interruptedResponse();
      return textResponse("");
    }) as unknown as typeof fetch;

    const response = await handleChat(makeRequest("s1", "hello", "stream-failure"), env, USER);
    const events = await readSse(response);
    expect(events.some((event) => event.type === "error")).toBe(true);
    expect(db.chatEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ event_type: "user_message" }),
      expect.objectContaining({ event_type: "error", status: "failed" }),
    ]));
    expect(db.chatRequestIdempotency.size).toBe(0);
  });

  it("records one terminal error when the provider repeats a tool-call ID", async () => {
    const { env, db } = makeEnv();
    db.seedChatSession("s1", "user-1");
    let stepfunCall = 0;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (!String(input).includes("stepfun.test")) return textResponse("");
      stepfunCall += 1;
      return sseResponse([
        JSON.stringify({ choices: [{ delta: { tool_calls: [
          { index: 0, id: "duplicate-call", function: { name: "search_paper", arguments: '{"query":"one"}' } },
          { index: 1, id: "duplicate-call", function: { name: "search_paper", arguments: '{"query":"two"}' } },
        ] }, finish_reason: "tool_calls" }] }),
      ]);
    }) as unknown as typeof fetch;

    const response = await handleChat(makeRequest("s1", "duplicate call", "duplicate-call-request"), env, USER);
    expect((await readSse(response)).some((event) => event.type === "error")).toBe(true);
    expect(db.chatEvents.filter((event) => event.event_type === "tool_call")).toHaveLength(1);
    expect(db.chatEvents.filter((event) => event.event_type === "error")).toHaveLength(1);
    expect(stepfunCall).toBe(1);
  });

  it("does not replay an incomplete historical tool call or a foreign session result", async () => {
    const incomplete: ChatEventRow[] = [
      { event_id: 1, session_id: "s1", turn_id: "turn-1", event_type: "user_message", role: "user", content: "question", tool_call_id: null, tool_name: null, tool_arguments_json: null, result_summary: null, result_object_key: null, result_sha256: null, result_bytes: null, status: "completed", created_at: 1 },
      { event_id: 2, session_id: "s1", turn_id: "turn-1", event_type: "tool_call", role: "assistant", content: null, tool_call_id: "call-1", tool_name: "search_paper", tool_arguments_json: '{"query":"q"}', result_summary: null, result_object_key: null, result_sha256: null, result_bytes: null, status: "pending", created_at: 2 },
      { event_id: 3, session_id: "s2", turn_id: "turn-1", event_type: "tool_result", role: "tool", content: null, tool_call_id: "call-1", tool_name: null, tool_arguments_json: null, result_summary: "foreign", result_object_key: null, result_sha256: null, result_bytes: 7, status: "succeeded", created_at: 3 },
    ];
    const messages = rebuildModelMessages(incomplete);
    expect(messages).toEqual([
      { role: "system", content: expect.any(String) },
      { role: "user", content: "question" },
    ]);
  });
});
