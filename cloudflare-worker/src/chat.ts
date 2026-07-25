import type { Env } from "./env";
import { MAX_CONTEXT_MESSAGES } from "./env";
import type { AuthedUser } from "./auth";
import { errorJson } from "./http";
import { getChatSession, insertMessage, listMessages, touchChatSession } from "./db";
import { checkRateLimit, consumeDailyQuota, decrementDailyUsageSafe } from "./quota";
import { runTool, TOOL_DEFINITIONS } from "./tools";
import { PAPER_AGENT_SYSTEM_PROMPT } from "./prompt";

const MAX_TOOL_ITERATIONS = 6;

interface ChatRequestBody {
  session_id?: string;
  messages?: Array<{ role: string; content: string }>;
  client_request_id?: string;
}

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

function sseEncode(event: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}

export async function handleChat(request: Request, env: Env, user: AuthedUser): Promise<Response> {
  let body: ChatRequestBody;
  try {
    body = await request.json();
  } catch {
    return errorJson("Body must be JSON", 400, "BAD_JSON");
  }

  const sessionId = body.session_id;
  if (!sessionId) return errorJson("session_id is required", 400, "MISSING_SESSION");

  const owned = await getChatSession(env, sessionId, user.userId);
  if (!owned) return errorJson("Session not found", 404, "NOT_FOUND");

  const incoming = Array.isArray(body.messages) ? body.messages : [];
  const lastUser = [...incoming].reverse().find((m) => m.role === "user");
  const userContent = (lastUser?.content ?? "").trim();
  if (!userContent) return errorJson("A user message is required", 400, "EMPTY_MESSAGE");

  // Rate limit (does not consume daily quota).
  const withinRate = await checkRateLimit(env, user.userId);
  if (!withinRate) {
    return errorJson("Too many requests, please slow down.", 429, "rate_limited");
  }

  // Consume one unit of the daily quota atomically. 21st conversation is rejected
  // before StepFun is ever called.
  const quota = await consumeDailyQuota(env, user.userId);
  if (!quota.allowed) {
    return errorJson(
      `Daily conversation limit reached (${quota.limit}/day).`,
      429,
      "daily_quota_exceeded"
    );
  }

  // Load prior history (authoritative from D1), then persist the new user turn.
  const history = await listMessages(env, sessionId);
  await insertMessage(env, sessionId, "user", userContent);
  await touchChatSession(env, sessionId);

  const contextHistory = history.slice(-MAX_CONTEXT_MESSAGES).map((m) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: m.content
  })) as ChatMessage[];

  const modelMessages: ChatMessage[] = [
    { role: "system", content: PAPER_AGENT_SYSTEM_PROMPT },
    ...contextHistory,
    { role: "user", content: userContent }
  ];

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const startedAt = Date.now();
      const emit = (event: Record<string, unknown>) => controller.enqueue(sseEncode(event));
      const emitStatus = (phase: string, extra: Record<string, unknown> = {}) =>
        emit({ type: "status", phase, elapsed_ms: Date.now() - startedAt, attempt: 1, max_attempts: 1, ...extra });

      let assistantText = "";
      let quotaRefunded = false;
      try {
        emitStatus("thinking");
        assistantText = await runToolLoop(env, sessionId, modelMessages, emit, emitStatus);
        if (assistantText.trim()) {
          await insertMessage(env, sessionId, "assistant", assistantText);
          await touchChatSession(env, sessionId);
        }
        emit({ type: "done" });
      } catch (error) {
        // Refund the quota unit on hard failure so users aren't charged for errors.
        if (!quotaRefunded) {
          await decrementDailyUsageSafe(env, user.userId);
          quotaRefunded = true;
        }
        emit({ type: "error", message: error instanceof Error ? error.message : "Chat failed" });
      } finally {
        controller.close();
      }
    }
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive"
    }
  });
}

/**
 * Drive the StepFun tool-calling loop. Streams assistant text via `emit` chunk
 * events and surfaces tool_call events. Returns the final assistant text.
 */
async function runToolLoop(
  env: Env,
  sessionId: string,
  messages: ChatMessage[],
  emit: (event: Record<string, unknown>) => void,
  emitStatus: (phase: string, extra?: Record<string, unknown>) => void
): Promise<string> {
  let finalText = "";

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration += 1) {
    const { content, toolCalls, finishReason } = await streamCompletion(env, messages, emit, emitStatus);

    if (toolCalls.length > 0) {
      // Record the assistant's tool-call turn, then execute each tool.
      messages.push({ role: "assistant", content: content || null, tool_calls: toolCalls });
      for (const call of toolCalls) {
        emit({ type: "tool_call", tool_name: call.function.name });
        emitStatus("tool_running", { tool_name: call.function.name });
        let args: Record<string, unknown> = {};
        try {
          args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
        } catch {
          args = {};
        }
        const result = await runTool(env, sessionId, call.function.name, args);
        messages.push({ role: "tool", tool_call_id: call.id, content: result });
      }
      // Loop again so the model can consume tool results.
      continue;
    }

    finalText = content;
    if (finishReason !== "tool_calls") {
      break;
    }
  }

  return finalText;
}

/**
 * One streaming call to StepFun's OpenAI-compatible chat completions endpoint.
 * Emits `chunk` events for content deltas and accumulates any tool calls.
 */
async function streamCompletion(
  env: Env,
  messages: ChatMessage[],
  emit: (event: Record<string, unknown>) => void,
  emitStatus: (phase: string, extra?: Record<string, unknown>) => void
): Promise<{ content: string; toolCalls: ToolCall[]; finishReason: string }> {
  const upstream = await fetch(`${env.STEPFUN_BASE_URL.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.STEPFUN_API_KEY}`,
      "content-type": "application/json",
      accept: "text/event-stream"
    },
    body: JSON.stringify({
      model: env.STEPFUN_MODEL,
      messages,
      tools: TOOL_DEFINITIONS,
      stream: true
    })
  });

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => "");
    throw new Error(`Model request failed (${upstream.status}) ${detail.slice(0, 200)}`);
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let finishReason = "";
  const toolAcc = new Map<number, { id: string; name: string; args: string }>();
  let firstContent = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";
    for (const raw of events) {
      const line = raw.trim();
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      let parsed: any;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }
      const choice = parsed.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta ?? {};

      if (typeof delta.content === "string" && delta.content.length > 0) {
        if (!firstContent) {
          firstContent = true;
          emitStatus("responding");
        }
        content += delta.content;
        emit({ type: "chunk", content: delta.content });
      }

      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const index = typeof tc.index === "number" ? tc.index : 0;
          const existing = toolAcc.get(index) ?? { id: "", name: "", args: "" };
          if (tc.id) existing.id = tc.id;
          if (tc.function?.name) existing.name = tc.function.name;
          if (tc.function?.arguments) existing.args += tc.function.arguments;
          toolAcc.set(index, existing);
        }
      }

      if (choice.finish_reason) {
        finishReason = choice.finish_reason;
      }
    }
  }

  const toolCalls: ToolCall[] = [...toolAcc.values()]
    .filter((t) => t.name)
    .map((t) => ({
      id: t.id || crypto.randomUUID(),
      type: "function",
      function: { name: t.name, arguments: t.args || "{}" }
    }));

  return { content, toolCalls, finishReason: finishReason || (toolCalls.length > 0 ? "tool_calls" : "stop") };
}
