import { MAX_CONTEXT_MESSAGES, modelProvider, type Env } from "./env";
import type { AuthedUser } from "./auth";
import { errorJson, nowSeconds } from "./http";
import type { ChatEventRow, ChatEventInput } from "./db";
import {
  bindChatTaskConfirmation,
  claimChatTaskConfirmation,
  cancelChatTaskConfirmation,
  completeChatRequestIdempotency,
  completeChatTaskConfirmation,
  createChatTaskConfirmation,
  getChatRequestIdempotency,
  getChatSession,
  getChatToolCall,
  getChatTaskConfirmation,
  getChatTaskConfirmationForUser,
  getOwnedTask,
  insertChatEvent,
  listChatEvents,
  MAX_INLINE_TOOL_RESULT_BYTES,
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
  method_document_content: string;
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

function normalizeToolArguments(argumentsJson: string): string {
  try {
    const parsed = JSON.parse(argumentsJson || "{}");
    return JSON.stringify(parsed);
  } catch {
    return "{}";
  }
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (utf8ByteLength(value) <= maxBytes) return value;
  let result = "";
  for (const character of value) {
    if (utf8ByteLength(result + character) > maxBytes) break;
    result += character;
  }
  return result;
}

function toolResultRecord(result: string, callId: string): Pick<ChatEventInput, "result_summary" | "result_object_key" | "result_bytes"> {
  const resultBytes = utf8ByteLength(result);
  if (resultBytes <= MAX_INLINE_TOOL_RESULT_BYTES) {
    return { result_summary: result, result_object_key: null, result_bytes: resultBytes };
  }
  // PAPER-04/05 will replace this deferred reference with an R2-backed object
  // store. Keep D1 bounded now and preserve the original byte count.
  const marker = "\n[full tool result deferred to an object reference]";
  const summary = `${truncateUtf8(result, MAX_INLINE_TOOL_RESULT_BYTES - utf8ByteLength(marker))}${marker}`;
  return {
    result_summary: summary,
    result_object_key: `pending-chat-result:${callId}`,
    result_bytes: resultBytes,
  };
}

function toolResultStatus(result: string): "succeeded" | "failed" {
  try {
    const parsed = JSON.parse(result) as { error?: unknown };
    return parsed && typeof parsed === "object" && typeof parsed.error === "string" ? "failed" : "succeeded";
  } catch {
    return "succeeded";
  }
}

const MAX_SSE_TOOL_SUMMARY_BYTES = 2_048;
const MAX_SSE_TOOL_ARGUMENTS_BYTES = 1_024;

function redactDisplayValue(key: string, value: unknown): unknown {
  if (/(?:secret|token|password|authorization|credential|cookie|api[_-]?key|object[_-]?key|path)/i.test(key)) {
    return "[redacted]";
  }
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redactDisplayValue(key, item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).slice(0, 40).map(([childKey, childValue]) => [
      childKey,
      redactDisplayValue(childKey, childValue),
    ]));
  }
  return typeof value === "string" ? truncateUtf8(value, 256) : value;
}

function safeDisplayText(value: string, maxBytes: number): string {
  const redacted = value
    .replace(/(?:r2:\/\/|paper\/|file:\/\/|\/(?:tmp|var|home|Users)\/)[^\s"']+/gi, "[redacted-reference]");
  return truncateUtf8(redacted, maxBytes);
}

function safeToolArgumentsSummary(argumentsJson: string): string {
  try {
    return safeDisplayText(JSON.stringify(redactDisplayValue("", JSON.parse(argumentsJson || "{}"))), MAX_SSE_TOOL_ARGUMENTS_BYTES);
  } catch {
    return "[invalid arguments]";
  }
}

function safeToolResultSummary(result: string): string {
  try {
    return safeDisplayText(JSON.stringify(redactDisplayValue("", JSON.parse(result))), MAX_SSE_TOOL_SUMMARY_BYTES);
  } catch {
    return safeDisplayText(result, MAX_SSE_TOOL_SUMMARY_BYTES);
  }
}

function emitToolCallEvent(
  emit: (event: Record<string, unknown>) => void,
  turnId: string,
  call: ToolCall,
  status: "pending" | "processing",
): void {
  emit({
    type: "tool_call",
    correlation_id: truncateUtf8(turnId, 255),
    tool_call_id: truncateUtf8(call.id, 255),
    tool_name: truncateUtf8(call.function.name, 255),
    status,
    arguments_summary: safeToolArgumentsSummary(call.function.arguments),
  });
}

function emitToolResultEvent(
  emit: (event: Record<string, unknown>) => void,
  turnId: string,
  call: ToolCall,
  result: string,
): void {
  emit({
    type: "tool_result",
    correlation_id: truncateUtf8(turnId, 255),
    tool_call_id: truncateUtf8(call.id, 255),
    tool_name: truncateUtf8(call.function.name, 255),
    status: toolResultStatus(result),
    summary: safeToolResultSummary(result),
  });
}

async function persistToolCallEvents(
  env: Env,
  sessionId: string,
  turnId: string,
  content: string,
  toolCalls: ToolCall[],
): Promise<void> {
  for (const [index, call] of toolCalls.entries()) {
    await insertChatEvent(env, {
      session_id: sessionId,
      turn_id: turnId,
      event_type: "tool_call",
      role: "assistant",
      content: index === 0 ? (content || null) : null,
      tool_call_id: call.id,
      tool_name: call.function.name,
      tool_arguments_json: normalizeToolArguments(call.function.arguments),
      status: "pending",
      created_at: nowSeconds(),
    });
  }
}

async function persistToolResultEvent(
  env: Env,
  sessionId: string,
  turnId: string,
  callId: string,
  result: string,
): Promise<void> {
  await insertChatEvent(env, {
    session_id: sessionId,
    turn_id: turnId,
    event_type: "tool_result",
    role: "tool",
    tool_call_id: callId,
    ...toolResultRecord(result, callId),
    status: toolResultStatus(result),
    created_at: nowSeconds(),
  });
}

async function persistTerminalError(env: Env, sessionId: string, turnId: string): Promise<void> {
  try {
    await insertChatEvent(env, {
      session_id: sessionId,
      turn_id: turnId,
      event_type: "error",
      role: "system",
      content: "Chat turn failed",
      status: "failed",
      created_at: nowSeconds(),
    });
  } catch {
    // Preserve the original failure if the terminal D1 write also fails.
  }
}

/** Rebuild provider-valid messages from the durable event ledger. */
export function rebuildModelMessages(events: ChatEventRow[]): ChatMessage[] {
  const sessionId = events[0]?.session_id;
  const groups = new Map<string, ChatEventRow[]>();
  for (const event of [...events].sort((left, right) => left.event_id - right.event_id)) {
    if (sessionId && event.session_id !== sessionId) continue;
    const group = groups.get(event.turn_id) ?? [];
    group.push(event);
    groups.set(event.turn_id, group);
  }

  const renderedGroups: ChatMessage[][] = [];
  for (const group of groups.values()) {
    const messages: ChatMessage[] = [];
    for (const event of group) {
      if (event.event_type === "user_message" && event.role === "user" && event.content != null) {
        messages.push({ role: "user", content: event.content });
      }
    }

    type ToolSegment = { calls: ChatEventRow[]; results: ChatEventRow[]; sawResult: boolean };
    const segments: ToolSegment[] = [];
    let current: ToolSegment | null = null;
    for (const event of group) {
      if (event.event_type === "tool_call" && event.role === "assistant") {
        if (current?.sawResult) {
          segments.push(current);
          current = null;
        }
        current ??= { calls: [], results: [], sawResult: false };
        current.calls.push(event);
      } else if (event.event_type === "tool_result" && event.role === "tool") {
        current ??= { calls: [], results: [], sawResult: false };
        current.results.push(event);
        current.sawResult = true;
      }
    }
    if (current) segments.push(current);

    for (const segment of segments) {
      const resultByCall = new Map<string, ChatEventRow>();
      for (const result of segment.results) {
        if (result.tool_call_id && !resultByCall.has(result.tool_call_id)) resultByCall.set(result.tool_call_id, result);
      }
      const complete = segment.calls.length > 0
        && segment.calls.every((call) => Boolean(call.tool_call_id && resultByCall.has(call.tool_call_id)));
      if (!complete) continue;

      const toolCalls = segment.calls
        .filter((call) => call.tool_call_id && call.tool_name)
        .map((call) => ({
          id: call.tool_call_id as string,
          type: "function" as const,
          function: {
            name: call.tool_name as string,
            arguments: normalizeToolArguments(call.tool_arguments_json ?? "{}"),
          },
        }));
      if (toolCalls.length !== segment.calls.length) continue;
      messages.push({
        role: "assistant",
        content: segment.calls.find((call) => call.content != null)?.content ?? null,
        tool_calls: toolCalls,
      });
      for (const call of toolCalls) {
        const result = resultByCall.get(call.id);
        if (!result) continue;
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: result.result_summary ?? "[tool result unavailable]",
        });
      }
    }

    for (const event of group) {
      if (event.event_type === "assistant_message" && event.role === "assistant" && event.content != null) {
        messages.push({ role: "assistant", content: event.content });
      }
    }
    if (messages.length > 0) renderedGroups.push(messages);
  }

  const selected: ChatMessage[] = [];
  let used = 0;
  for (let index = renderedGroups.length - 1; index >= 0; index -= 1) {
    const group = renderedGroups[index];
    if (selected.length > 0 && used + group.length > MAX_CONTEXT_MESSAGES) break;
    selected.unshift(...group);
    used += group.length;
  }
  return [{ role: "system", content: PAPER_AGENT_SYSTEM_PROMPT }, ...selected];
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
  const turnId = clientRequestId ? `client:${clientRequestId}` : crypto.randomUUID();
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

  // Load prior canonical history (authoritative from D1), then persist the new
  // user event before the first provider completion request.
  try {
    await listChatEvents(env, sessionId);
    await insertChatEvent(env, {
      session_id: sessionId,
      turn_id: turnId,
      event_type: "user_message",
      role: "user",
      content: userContent,
      status: "completed",
      created_at: nowSeconds(),
    });
    await touchChatSession(env, sessionId);
  } catch (error) {
    await persistTerminalError(env, sessionId, turnId);
    if (clientRequestId) await releaseChatRequestIdempotency(env, user.userId, clientRequestId);
    await decrementDailyUsageSafe(env, user.userId);
    throw error;
  }

  const modelMessages = rebuildModelMessages(await listChatEvents(env, sessionId));

  return streamModelLoop(
    env,
    user,
    sessionId,
    turnId,
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

export async function handleCancelChatTaskConfirmation(request: Request, env: Env, user: AuthedUser): Promise<Response> {
  let body: { confirmation_id?: string };
  try {
    body = await request.json() as { confirmation_id?: string };
  } catch {
    return errorJson("Body must be JSON", 400, "BAD_JSON");
  }
  const confirmationId = String(body.confirmation_id ?? "").trim();
  if (!confirmationId) return errorJson("confirmation_id is required", 400, "INVALID_TASK_CONFIRMATION");
  const cancelled = await cancelChatTaskConfirmation(env, confirmationId, user.userId);
  if (!cancelled) return errorJson("Task confirmation is no longer pending", 409, "TASK_CONFIRMATION_USED");
  return new Response(JSON.stringify({ confirmation_id: confirmationId, status: "cancelled" }), {
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
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
    method_document_content: "",
    dataset_name: "",
  };
  try {
    const parsed = JSON.parse(confirmation.tool_args_json) as Partial<TaskConfirmationArgs>;
    args = {
      title: String(parsed.title ?? task.title),
      analysis_type: String(parsed.analysis_type ?? "generic"),
      research_question: String(parsed.research_question ?? ""),
      method_document_name: String(parsed.method_document_name ?? ""),
      method_document_content: String(parsed.method_document_content ?? ""),
      dataset_name: String(parsed.dataset_name ?? ""),
    };
  } catch {
    // The task was already created from the card. Use safe defaults for the
    // model continuation instead of failing the user's queued task.
  }

  // Claim only after every operation above has succeeded. If history loading
  // fails, the card remains pending and the user can retry.
  if (!(await claimChatTaskConfirmation(env, confirmationId, taskId))) {
    return errorJson("Task confirmation has already been used", 409, "TASK_CONFIRMATION_USED");
  }

  const taskResult = JSON.stringify({
    status: task.status,
    task_id: task.task_id,
    title: task.title,
    message: task.status === "queued"
      ? "The user completed the confirmation card. The task is queued for asynchronous background execution."
      : `The user completed the confirmation card. The task status is ${task.status}. Report that status accurately; do not describe it as queued unless the status is queued.`,
  });
  const originalCall = await getChatToolCall(env, sessionId, confirmation.tool_call_id);
  const resumeTurnId = `confirmation:${confirmationId}`;
  try {
    // Compatibility for confirmations created before PAPER-03: reconstruct
    // the call event from this known pending confirmation, then record its
    // result exactly once.
    if (!originalCall) {
      await insertChatEvent(env, {
        session_id: sessionId,
        turn_id: resumeTurnId,
        event_type: "tool_call",
        role: "assistant",
        tool_call_id: confirmation.tool_call_id,
        tool_name: confirmation.tool_name,
        tool_arguments_json: normalizeToolArguments(JSON.stringify(args)),
        status: "pending",
        created_at: nowSeconds(),
      });
    }
    await persistToolResultEvent(
      env,
      sessionId,
      originalCall?.turn_id ?? resumeTurnId,
      confirmation.tool_call_id,
      taskResult,
    );
  } catch (error) {
    await reopenChatTaskConfirmation(env, confirmationId);
    throw error;
  }

  const modelMessages = rebuildModelMessages(await listChatEvents(env, sessionId));

  return streamModelLoop(env, user, sessionId, resumeTurnId, modelMessages, false, false, {
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
  turnId: string,
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
        emit({
          type: "status",
          phase,
          correlation_id: truncateUtf8(turnId, 255),
          elapsed_ms: Date.now() - startedAt,
          attempt: 1,
          max_attempts: 1,
          ...extra,
        });

      try {
        emitStatus("thinking");
        const result = await runToolLoop(
          env,
          sessionId,
          user.userId,
          turnId,
          modelMessages,
          emit,
          emitStatus,
          forceTaskConfirmation,
        );
        if (result.assistantText.trim() || result.status === "completed") {
          await insertChatEvent(env, {
            session_id: sessionId,
            turn_id: turnId,
            event_type: "assistant_message",
            role: "assistant",
            content: result.assistantText || null,
            status: "completed",
            created_at: nowSeconds(),
          });
          await touchChatSession(env, sessionId);
        }
        if (lifecycle?.onResult) {
          await lifecycle.onResult(result);
        }
        if (result.status === "completed") emit({ type: "done" });
      } catch (error) {
        await persistTerminalError(env, sessionId, turnId);
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
  turnId: string,
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
      const synthesizedCall: ToolCall = {
        id: crypto.randomUUID(),
        type: "function",
        function: { name: "request_task_creation", arguments: JSON.stringify(inferTaskConfirmationArgs(messages)) },
      };
      await persistToolCallEvents(env, sessionId, turnId, content, [synthesizedCall]);
      emitToolCallEvent(emit, turnId, synthesizedCall, "pending");
      emitToolCallEvent(emit, turnId, synthesizedCall, "processing");
      emitStatus("tool_running", { tool_name: "request_task_creation" });
      return await pauseForTaskConfirmation(
        env,
        sessionId,
        userId,
        synthesizedCall.id,
        inferTaskConfirmationArgs(messages),
        content,
        emit,
      );
    }

    if (toolCalls.length > 0) {
      // Record every assistant tool call before executing any of them. This
      // preserves provider ordering even when streamed chunks arrive out of order.
      await persistToolCallEvents(env, sessionId, turnId, content, toolCalls);
      messages.push({ role: "assistant", content: content || null, tool_calls: toolCalls });
      for (const call of toolCalls) {
        emitToolCallEvent(emit, turnId, call, "pending");
        emitToolCallEvent(emit, turnId, call, "processing");
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

        let result: string;
        try {
          result = await runTool(env, sessionId, userId, call.function.name, args);
        } catch (error) {
          const failedResult = JSON.stringify({ error: "tool_execution_failed" });
          await persistToolResultEvent(env, sessionId, turnId, call.id, failedResult);
          emitToolResultEvent(emit, turnId, call, failedResult);
          messages.push({ role: "tool", tool_call_id: call.id, content: failedResult });
          throw error;
        }
        await persistToolResultEvent(env, sessionId, turnId, call.id, result);
        emitToolResultEvent(emit, turnId, call, result);
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
    method_document_content: bounded(args.method_document_content, "", 32_000),
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
  const provider = modelProvider(env);
  const requestCompletion = (withToolChoice: boolean) => fetch(
    `${provider.baseUrl}/chat/completions`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${provider.apiKey}`,
        "content-type": "application/json",
        accept: "text/event-stream"
      },
      body: JSON.stringify({
        model: provider.model,
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

  const processEvent = (raw: string) => {
    const line = raw.trim();
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (data === "[DONE]") return;
    let parsed: any;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    const choice = parsed.choices?.[0];
    if (!choice) return;
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

    if (choice.finish_reason) finishReason = choice.finish_reason;
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";
    for (const raw of events) processEvent(raw);
  }

  buffer += decoder.decode();
  if (buffer.trim()) processEvent(buffer);

  const toolCalls: ToolCall[] = [...toolAcc.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, t]) => t)
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
