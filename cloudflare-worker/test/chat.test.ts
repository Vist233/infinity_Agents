import { afterEach, describe, expect, it, vi } from "vitest";
import { handleChat } from "../src/chat";
import { makeEnv } from "./fake-d1";
import type { AuthedUser } from "../src/auth";

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

function makeRequest(sessionId: string, content: string): Request {
  return new Request("https://app.test/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session_id: sessionId, messages: [{ role: "user", content }] })
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
    expect(types).toContain("chunk");
    expect(types).toContain("done");
    expect(events.find((e) => e.type === "tool_call")?.tool_name).toBe("search_paper");

    const finalText = events
      .filter((e) => e.type === "chunk")
      .map((e) => e.content as string)
      .join("");
    expect(finalText).toBe("Found 1 paper.");

    // StepFun was called twice (initial + after tool result); the paper tool ran.
    expect(stepfunCalls()).toBe(2);
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("export.arxiv.org"))).toBe(true);

    // The user turn and the assistant answer were both persisted.
    const roles = db.chatMessages.map((m) => m.role);
    expect(roles).toContain("user");
    expect(roles).toContain("assistant");
    expect(db.chatMessages.find((m) => m.role === "assistant")?.content).toBe("Found 1 paper.");

    // One conversation consumed exactly one daily-quota unit.
    expect([...db.dailyUsage.values()][0]).toBe(1);
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
          JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "task_call_1", function: { name: "request_task_creation", arguments: JSON.stringify({ title: "Trait extraction", analysis_type: "trait_extraction" }) } }] }, finish_reason: "tool_calls" }] }),
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
    expect(firstEvents.map((event) => event.type)).toContain("task_confirmation");
    expect(firstEvents.map((event) => event.type)).not.toContain("done");
    const confirmation = [...db.chatTaskConfirmations.values()][0];
    expect(confirmation?.status).toBe("pending");
    expect([...db.dailyUsage.values()][0]).toBe(1);

    db.seedTask("task-1", "user-1", "Trait extraction", "queued");
    const second = await handleChat(makeConfirmationRequest("s1", confirmation.confirmation_id, "task-1"), env, USER);
    const secondEvents = await readSse(second);
    expect(secondEvents.map((event) => event.type)).toContain("done");
    expect(secondEvents.filter((event) => event.type === "chunk").map((event) => event.content).join(""))
      .toBe("任务已排队，将在后台异步执行。");
    expect(confirmation.status).toBe("completed");
    expect(stepfunCall).toBe(2);
    expect([...db.dailyUsage.values()][0]).toBe(1);
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
});
