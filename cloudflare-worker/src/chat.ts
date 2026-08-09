import type { Env } from "./env";
import { MAX_CONTEXT_MESSAGES } from "./env";
import type { AuthedUser } from "./auth";
import { errorJson, nowSeconds } from "./http";
import {
  bindChatTaskConfirmation,
  claimChatTaskConfirmation,
  completeChatRequestIdempotency,
  completeChatTaskConfirmation,
  createChatTaskConfirmation,
  getChatRequestIdempotency,
  getChatSession,
  getChatTaskConfirmation,
  getChatTaskConfirmationForUser,
  getOwnedTask,
  insertMessage,
  listMessages,
  releaseChatRequestIdempotency,
  reopenChatTaskConfirmation,
  reserveChatRequestIdempotency,
  touchChatSession,
} from "./db";
import { checkRateLimit, consumeDailyQuota, decrementDailyUsageSafe } from "./quota";
import { runTool, TOOL_DEFINITIONS } from "./tools";
import { PAPER_AGENT_SYSTEM_PROMPT } from "./prompt";

const MAX_TOOL_ITERATIONS = 6;

interface ChatRequestBody {
  session_id?: string;
  messages?: Array<{ role: string; content: string }>;
  client_request_id?: string;
  task_confirmation_id?: string;
  task_id?: string;
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

interface TaskConfirmationArgs {
  title: string;
  analysis_type: string;
  research_question: string;
  method_document_name: string;
  dataset_name: string;
}

interface ChatLoopResult {
  status: "completed" | "confirmation_required";
  assistantText: string;
  confirmationId?: string;
}

interface StreamLifecycle {
  onResult?: (result: ChatLoopResult) => Promise<void>;
  onError?: () => Promise<void>;
}

function sseEncode(event: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}

function sseResponse(events: Array<Record<string, unknown>>): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) controller.enqueue(sseEncode(event));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
    },
  });
}

function confirmationEvent(confirmation: Awaited<ReturnType<typeof getChatTaskConfirmation>>): Record<string, unknown> | null {
  if (!confirmation) return null;
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(confirmation.tool_args_json) as Record<string, unknown>;
  } catch {
    // Use the same normalization path as a fresh tool call below.
  }
  return {
    type: "task_confirmation",
    confirmation_id: confirmation.confirmation_id,
    tool_name: confirmation.tool_name,
    ...normalizeTaskConfirmationArgs(args),
  };
}

function replayCompletedChat(responseText: string): Response {
  const events: Array<Record<string, unknown>> = [];
  if (responseText) events.push({ type: "chunk", content: responseText });
  events.push({ type: "done" });
  return sseResponse(events);
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

  if (body.task_confirmation_id) {
    return handleTaskConfirmation(env, user, sessionId, body);
  }

  const incoming = Array.isArray(body.messages) ? body.messages : [];
  const lastUser = [...incoming].reverse().find((m) => m.role === "user");
  const userContent = (lastUser?.content ?? "").trim();
  if (!userContent) return errorJson("A user message is required", 400, "EMPTY_MESSAGE");

  const clientRequestId = String(body.client_request_id ?? "").trim();
  if (clientRequestId.length > 255) {
    return errorJson("client_request_id is too long", 400, "INVALID_CLIENT_REQUEST_ID");
  }
  if (clientRequestId) {
    const reserved = await reserveChatRequestIdempotency(
      env,
      user.userId,
      sessionId,
      clientRequestId,
      nowSeconds(),
    );
    if (!reserved) {
      const previous = await getChatRequestIdempotency(env, user.userId, clientRequestId);
      if (!previous || previous.session_id !== sessionId) {
        return errorJson("client_request_id was already used for another session", 409, "CLIENT_REQUEST_CONFLICT");
      }
      if (previous.status === "processing") {
        return errorJson("The same chat request is already processing", 409, "CHAT_REQUEST_IN_PROGRESS");
      }
      if (previous.status === "completed") {
        return replayCompletedChat(previous.response_text);
      }
      const confirmation = previous.confirmation_id
        ? await getChatTaskConfirmation(env, previous.confirmation_id, sessionId, user.userId)
        : null;
      const event = confirmation && confirmation.status === "pending" && confirmation.expires_at > nowSeconds()
        ? confirmationEvent(confirmation)
        : null;
      if (event) return sseResponse([event]);
      return errorJson("The previous task confirmation is no longer available", 410, "TASK_CONFIRMATION_EXPIRED");
    }
  }

  // Rate limit (does not consume daily quota).
  const withinRate = await checkRateLimit(env, user.userId);
  if (!withinRate) {
    if (clientRequestId) await releaseChatRequestIdempotency(env, user.userId, clientRequestId);
    return errorJson("Too many requests, please slow down.", 429, "rate_limited");
  }

  // Consume one unit of the daily quota atomically. 21st conversation is rejected
  // before StepFun is ever called.
  const quota = await consumeDailyQuota(env, user.userId);
  if (!quota.allowed) {
    if (clientRequestId) await releaseChatRequestIdempotency(env, user.userId, clientRequestId);
    return errorJson(
      `Daily conversation limit reached (${quota.limit}/day).`,
      429,
      "daily_quota_exceeded"
    );
  }

  // Load prior history (authoritative from D1), then persist the new user turn.
  let history: Awaited<ReturnType<typeof listMessages>>;
  try {
    history = await listMessages(env, sessionId);
    await insertMessage(env, sessionId, "user", userContent);
    await touchChatSession(env, sessionId);
  } catch (error) {
    if (clientRequestId) await releaseChatRequestIdempotency(env, user.userId, clientRequestId);
    await decrementDailyUsageSafe(env, user.userId);
    throw error;
  }

  const contextHistory = history.slice(-MAX_CONTEXT_MESSAGES).map((m) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: m.content
  })) as ChatMessage[];

  const modelMessages: ChatMessage[] = [
    { role: "system", content: PAPER_AGENT_SYSTEM_PROMPT },
    ...contextHistory,
    { role: "user", content: userContent }
  ];

  return streamModelLoop(
    env,
    user,
    sessionId,
    modelMessages,
    true,
    shouldRequestTaskConfirmation(userContent),
    clientRequestId
      ? {
          onResult: async (result) => {
            await completeChatRequestIdempotency(
              env,
              user.userId,
              clientRequestId,
              result.status === "confirmation_required" ? "confirmation" : "completed",
              result.confirmationId ?? null,
              result.assistantText,
              nowSeconds(),
            );
          },
          onError: async () => {
            await releaseChatRequestIdempotency(env, user.userId, clientRequestId);
          },
        }
      : undefined,
  );
}

/**
 * Resume a paused request_task_creation tool call after the inline card has
 * created a queued Task. The task itself is verified server-side; the client
 * cannot inject another user's task_id into the model context.
 */
async function handleTaskConfirmation(
  env: Env,
  user: AuthedUser,
  sessionId: string,
  body: ChatRequestBody,
): Promise<Response> {
  const confirmationId = String(body.task_confirmation_id ?? "").trim();
  const taskId = String(body.task_id ?? "").trim();
  if (!confirmationId || !taskId) {
    return errorJson("task_confirmation_id and task_id are required", 400, "INVALID_TASK_CONFIRMATION");
  }

  const confirmation = await getChatTaskConfirmation(env, confirmationId, sessionId, user.userId);
  if (!confirmation) return errorJson("Task confirmation not found", 404, "TASK_CONFIRMATION_NOT_FOUND");
  const now = nowSeconds();
  if (confirmation.status !== "pending") {
    return errorJson("Task confirmation has already been used", 409, "TASK_CONFIRMATION_USED");
  }
  if (confirmation.expires_at <= now && !confirmation.task_id) {
    return errorJson("Task confirmation expired", 410, "TASK_CONFIRMATION_EXPIRED");
  }

  const task = await getOwnedTask(env, taskId, user.userId);
  if (!task) {
    return errorJson("Task not found", 404, "TASK_NOT_FOUND");
  }

  if (confirmation.task_id !== taskId || task.chat_confirmation_id !== confirmationId) {
    return errorJson("Task is not bound to this confirmation", 409, "TASK_CONFIRMATION_MISMATCH");
  }

  let args: TaskConfirmationArgs = {
    title: task.title,
    analysis_type: "generic",
    research_question: "",
    method_document_name: "",
    dataset_name: "",
  };
  try {
    const parsed = JSON.parse(confirmation.tool_args_json) as Partial<TaskConfirmationArgs>;
    args = {
      title: String(parsed.title ?? task.title),
      analysis_type: String(parsed.analysis_type ?? "generic"),
      research_question: String(parsed.research_question ?? ""),
      method_document_name: String(parsed.method_document_name ?? ""),
      dataset_name: String(parsed.dataset_name ?? ""),
    };
  } catch {
    // The task was already created from the card. Use safe defaults for the
    // model continuation instead of failing the user's queued task.
  }

  const history = await listMessages(env, sessionId);
  const contextHistory = history.slice(-MAX_CONTEXT_MESSAGES).map((m) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: m.content,
  })) as ChatMessage[];
  const modelMessages: ChatMessage[] = [
    { role: "system", content: PAPER_AGENT_SYSTEM_PROMPT },
    ...contextHistory,
    {
      role: "assistant",
      content: null,
      tool_calls: [{
        id: confirmation.tool_call_id,
        type: "function",
        function: { name: confirmation.tool_name, arguments: JSON.stringify(args) },
      }],
    },
    {
      role: "tool",
      tool_call_id: confirmation.tool_call_id,
      content: JSON.stringify({
        status: "queued",
        task_id: task.task_id,
        title: task.title,
        message: "The user completed the confirmation card. The task is queued for asynchronous background execution.",
      }),
    },
  ];

  // Claim only after every operation above has succeeded. If history loading
  // fails, the card remains pending and the user can retry.
  if (!(await claimChatTaskConfirmation(env, confirmationId, taskId))) {
    return errorJson("Task confirmation has already been used", 409, "TASK_CONFIRMATION_USED");
  }

  return streamModelLoop(env, user, sessionId, modelMessages, false, false, {
    onResult: async (result) => {
      if (result.status === "completed") {
        const completed = await completeChatTaskConfirmation(env, confirmationId, taskId, nowSeconds());
        if (!completed) throw new Error("Task confirmation could not be completed");
      } else {
        // A second task request pauses the resumed loop again. Keep the
        // original confirmation retryable until the current loop completes.
        await reopenChatTaskConfirmation(env, confirmationId);
      }
    },
    onError: async () => {
      await reopenChatTaskConfirmation(env, confirmationId);
    },
  });
}

function streamModelLoop(
  env: Env,
  user: AuthedUser,
  sessionId: string,
  modelMessages: ChatMessage[],
  refundQuotaOnError: boolean,
  forceTaskConfirmation = false,
  lifecycle?: StreamLifecycle,
): Response {
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const startedAt = Date.now();
      const emit = (event: Record<string, unknown>) => controller.enqueue(sseEncode(event));
      const emitStatus = (phase: string, extra: Record<string, unknown> = {}) =>
        emit({ type: "status", phase, elapsed_ms: Date.now() - startedAt, attempt: 1, max_attempts: 1, ...extra });

      try {
        emitStatus("thinking");
        const result = await runToolLoop(
          env,
          sessionId,
          user.userId,
          modelMessages,
          emit,
          emitStatus,
          forceTaskConfirmation,
        );
        if (result.assistantText.trim()) {
          await insertMessage(env, sessionId, "assistant", result.assistantText);
          await touchChatSession(env, sessionId);
        }
        if (lifecycle?.onResult) {
          await lifecycle.onResult(result);
        }
        if (result.status === "completed") emit({ type: "done" });
      } catch (error) {
        if (lifecycle?.onError) {
          try {
            await lifecycle.onError();
          } catch {
            // Preserve the original model error for the client.
          }
        }
        if (refundQuotaOnError) await decrementDailyUsageSafe(env, user.userId);
        emit({ type: "error", message: error instanceof Error ? error.message : "Chat failed" });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
    },
  });
}

/**
 * Drive the StepFun tool-calling loop. Streams assistant text via `emit` chunk
 * events and surfaces tool_call events. Returns the final assistant text.
 */
async function runToolLoop(
  env: Env,
  sessionId: string,
  userId: string,
  messages: ChatMessage[],
  emit: (event: Record<string, unknown>) => void,
  emitStatus: (phase: string, extra?: Record<string, unknown>) => void,
  forceTaskConfirmation = false,
): Promise<ChatLoopResult> {
  let finalText = "";

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration += 1) {
    const { content, toolCalls, finishReason } = await streamCompletion(
      env,
      messages,
      emit,
      emitStatus,
      forceTaskConfirmation && iteration === 0,
    );

    // A clear task intent must not get stuck in a clarification-only answer.
    // If the provider ignores tool_choice, synthesize the same safe pending
    // confirmation instead of creating a task or asking the user to restart.
    if (forceTaskConfirmation && iteration === 0 && !toolCalls.some((call) => call.function.name === "request_task_creation")) {
      emit({ type: "tool_call", tool_name: "request_task_creation" });
      emitStatus("tool_running", { tool_name: "request_task_creation" });
      return await pauseForTaskConfirmation(
        env,
        sessionId,
        userId,
        crypto.randomUUID(),
        inferTaskConfirmationArgs(messages),
        content,
        emit,
      );
    }

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
        if (call.function.name === "request_task_creation") {
          return await pauseForTaskConfirmation(env, sessionId, userId, call.id, args, content, emit);
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

  return { status: "completed", assistantText: finalText };
}

function normalizeTaskConfirmationArgs(args: Record<string, unknown>): TaskConfirmationArgs {
  const bounded = (value: unknown, fallback: string, max: number) => {
    const text = String(value ?? fallback).trim();
    return (text || fallback).slice(0, max);
  };
  return {
    title: bounded(args.title, "Analysis background task", 255),
    analysis_type: bounded(args.analysis_type, "generic", 80),
    research_question: bounded(args.research_question, "", 2000),
    method_document_name: bounded(args.method_document_name, "", 255),
    dataset_name: bounded(args.dataset_name, "", 255),
  };
}

/**
 * One streaming call to StepFun's OpenAI-compatible chat completions endpoint.
 * Emits `chunk` events for content deltas and accumulates any tool calls.
 */
async function streamCompletion(
  env: Env,
  messages: ChatMessage[],
  emit: (event: Record<string, unknown>) => void,
  emitStatus: (phase: string, extra?: Record<string, unknown>) => void,
  forceTaskConfirmation = false,
): Promise<{ content: string; toolCalls: ToolCall[]; finishReason: string }> {
  const requestCompletion = (withToolChoice: boolean) => fetch(
    `${env.STEPFUN_BASE_URL.replace(/\/$/, "")}/chat/completions`,
    {
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
        ...(withToolChoice
          ? { tool_choice: { type: "function", function: { name: "request_task_creation" } } }
          : {}),
        stream: true
      })
    },
  );

  let upstream: Response;
  try {
    upstream = await requestCompletion(forceTaskConfirmation);
  } catch (error) {
    if (!forceTaskConfirmation) throw error;
    // Some OpenAI-compatible providers reject tool_choice even though they
    // accept tools. Retry without the optional hint; runToolLoop still
    // synthesizes the safe confirmation card if the model asks questions.
    upstream = await requestCompletion(false);
  }

  if ((!upstream.ok || !upstream.body) && forceTaskConfirmation) {
    await upstream.text().catch(() => "");
    upstream = await requestCompletion(false);
  }

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

async function pauseForTaskConfirmation(
  env: Env,
  sessionId: string,
  userId: string,
  toolCallId: string,
  args: Record<string, unknown>,
  content: string,
  emit: (event: Record<string, unknown>) => void,
): Promise<ChatLoopResult> {
  const confirmation = normalizeTaskConfirmationArgs(args);
  const confirmationId = crypto.randomUUID();
  const createdAt = nowSeconds();
  await createChatTaskConfirmation(env, {
    confirmation_id: confirmationId,
    session_id: sessionId,
    user_id: userId,
    tool_name: "request_task_creation",
    tool_call_id: toolCallId,
    tool_args_json: JSON.stringify(confirmation),
    created_at: createdAt,
    expires_at: createdAt + 30 * 60,
  });
  const handoffText = content.trim()
    ? content
    : "我已理解你的需求，请在下面的确认卡中补充材料；提交后我会把任务放到后台执行。";
  if (!content.trim()) emit({ type: "chunk", content: handoffText });
  emit({
    type: "task_confirmation",
    confirmation_id: confirmationId,
    tool_name: "request_task_creation",
    ...confirmation,
  });
  return { status: "confirmation_required", assistantText: handoffText, confirmationId };
}

function inferTaskConfirmationArgs(messages: ChatMessage[]): Record<string, unknown> {
  const lastUser = [...messages].reverse().find((message) => message.role === "user");
  const request = String(lastUser?.content ?? "").replace(/\s+/g, " ").trim();
  const title = request ? request.slice(0, 255) : "Analysis background task";
  return {
    title,
    analysis_type: /性状|trait/i.test(request) ? "trait_extraction" : "generic",
    research_question: request,
  };
}

function shouldRequestTaskConfirmation(userContent: string): boolean {
  const text = userContent.replace(/\s+/g, " ").trim();
  if (!text) return false;
  if (/(?:不要|无需|不用|不想|别|禁止).{0,12}(?:创建|新建|提交|执行|运行|开始|安排|建立)/i.test(text)) return false;
  if (/(?:怎么|如何|什么|哪里|查看|进入|介绍|说明).{0,12}(?:任务|分析|作业)|(?:任务|分析|作业).{0,12}(?:怎么|如何|是什么|中心)/i.test(text)) return false;
  return /(?:创建|新建|提交|执行|运行|开始|安排|建立).{0,24}(?:任务|分析|作业|数据集)|(?:任务|分析|作业).{0,24}(?:后台|异步|创建|提交|执行)|\b(?:create|submit|run|start|background|async)\b.{0,32}\b(?:task|job|analysis)\b/i.test(text);
}
