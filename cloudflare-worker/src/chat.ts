import { MAX_CONTEXT_MESSAGES, modelProvider, type Env } from "./env";
import type { AuthedUser } from "./auth";
import { errorJson, nowSeconds } from "./http";
import type { ChatEventRow, ChatEventInput, OwnedPaperRequestContinuation } from "./db";
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
  getOwnedPaperRequestContinuation,
  insertChatEvent,
  listChatEvents,
  listOwnedPaperRequestContinuationsForTurn,
  MAX_INLINE_TOOL_RESULT_BYTES,
  PAPER_CONTINUATION_LEASE_SECONDS,
  releaseChatRequestIdempotency,
  releasePaperRequestContinuation,
  reopenChatTaskConfirmation,
  reserveChatRequestIdempotency,
  claimPaperRequestContinuation,
  completePaperRequestContinuation,
  syncPaperRequestContinuation,
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
  status: "completed" | "confirmation_required" | "paper_processing" | "failed";
  assistantText: string;
  confirmationId?: string;
  paperContinuationId?: string;
  paperResourceId?: string;
  errorCode?: string;
}

interface StreamLifecycle {
  onResult?: (result: ChatLoopResult) => Promise<void>;
  onError?: () => Promise<void>;
}

interface PaperContinuationContext {
  continuationId: string;
  resourceId: string;
}

interface StreamOptions {
  forceTaskConfirmation?: boolean;
  paperIntent?: boolean;
  paperMaterializationIntent?: boolean;
  paperContinuation?: PaperContinuationContext;
  clientRequestId?: string | null;
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

async function persistTerminalError(
  env: Env,
  sessionId: string,
  turnId: string,
  content = "Chat turn failed",
): Promise<void> {
  try {
    await insertChatEvent(env, {
      session_id: sessionId,
      turn_id: turnId,
      event_type: "error",
      role: "system",
      content,
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
    for (const event of group) {
      if (event.event_type === "system_status" && event.role === "system" && event.content != null) {
        messages.push({ role: "system", content: event.content });
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

const PAPER_TOOL_NAMES = new Set(["search_paper", "materialize_paper", "read_paper", "analyze_paper_image"]);
const MODEL_RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_MODEL_ATTEMPTS = 3;

/** Detect a paper/full-text intent without trusting the provider's prose. */
export function isPaperIntent(content: string): boolean {
  return /(?:论文|文献|paper|pdf|全文|pubmed|arxiv|doi|下载.{0,24}(?:解析|阅读)|解析.{0,24}pdf)/i.test(content);
}

/** Full-text requests require a durable resource, not just a search result. */
export function isPaperMaterializationIntent(content: string): boolean {
  return isPaperIntent(content) && /(?:下载|解析|全文|pdf|download|parse|full[- ]?text|materiali[sz]|extract)/i.test(content);
}

/**
 * A deictic request such as "read the already parsed paper" names no new
 * paper and may legitimately have no resource in this session. Let the model
 * explain that state instead of turning a truthful no-resource answer into a
 * synthetic tool-call failure. Explicit papers and download/full-text intents
 * retain the strict Paper tool contract.
 */
export function isExistingPaperReferenceIntent(content: string): boolean {
  return isPaperIntent(content)
    && /(?:已(?:解析|下载|物化)|already[- ]?(?:parsed|downloaded|materialized)|当前会话.{0,20}(?:论文|资源)|this session.{0,40}(?:paper|resource))/i.test(content)
    && /(?:读取|查看|列出|read|view|list|第一页|图片|image)/i.test(content)
    && !/(?:重新|再次|重新下载|download).{0,24}(?:pdf|论文|paper)|解析.{0,24}(?:pdf|全文|full[- ]?text)/i.test(content);
}

interface PaperToolPayload {
  mode?: string;
  status?: string;
  resource_id?: string;
  continuation_id?: string;
  error?: string;
}

function parsePaperToolPayload(result: string): PaperToolPayload | null {
  try {
    const value = JSON.parse(result) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    return {
      ...(typeof record.mode === "string" ? { mode: record.mode } : {}),
      ...(typeof record.status === "string" ? { status: record.status } : {}),
      ...(typeof record.resource_id === "string" ? { resource_id: record.resource_id } : {}),
      ...(typeof record.continuation_id === "string" ? { continuation_id: record.continuation_id } : {}),
      ...(typeof record.error === "string" ? { error: record.error } : {}),
    };
  } catch {
    return null;
  }
}

const CANONICAL_ARXIV_REF = /^arxiv:(?:\d{4}\.\d{4,5}|[a-z-]+\/\d{7})(?:v\d+)?$/i;
const CANONICAL_PUBMED_PMC_REF = /^pubmed:PMC\d+$/i;

function safePaperOpaqueId(value: unknown): value is string {
  return typeof value === "string" && /^\S{1,255}$/.test(value);
}

function normalizeMaterializablePaperRef(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const clean = value.trim();
  if (CANONICAL_ARXIV_REF.test(clean)) return clean;
  if (CANONICAL_PUBMED_PMC_REF.test(clean)) {
    const [, identifier] = clean.split(":", 2);
    return `pubmed:${identifier.toUpperCase()}`;
  }
  return null;
}

/** Select only a canonical, explicitly materializable ref from search output. */
function firstMaterializableSearchRef(result: string): string | null {
  try {
    const value = JSON.parse(result) as unknown;
    if (!Array.isArray(value)) return null;
    for (const item of value) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const record = item as Record<string, unknown>;
      const availability = record.availability;
      if (!availability || typeof availability !== "object" || Array.isArray(availability)
        || (availability as Record<string, unknown>).kind !== "materializable") continue;
      const paperRef = normalizeMaterializablePaperRef(record.paper_ref ?? record.ref);
      const ref = normalizeMaterializablePaperRef(record.ref);
      if (record.ref != null && !ref) continue;
      if (paperRef && (!ref || ref === paperRef)) return paperRef;
    }
  } catch {
    // A malformed or prose-only tool result is never a materialization input.
  }
  return null;
}

function paperContinuationEvent(row: OwnedPaperRequestContinuation): Record<string, unknown> {
  const status = row.resource_status === "ready" && ["ready", "running"].includes(row.status)
    ? "ready"
    : row.status === "failed" || row.resource_status === "failed"
      ? "failed"
      : row.status === "cancelled" || ["cancelled", "deleted"].includes(row.resource_status)
        ? "cancelled"
        : "processing";
  return {
    type: "paper_processing",
    correlation_id: truncateUtf8(row.turn_id, 255),
    continuation_id: row.continuation_id,
    resource_id: row.resource_id,
    status,
    message: status === "ready"
      ? "Paper is ready; continue the original request to read text or analyze an image."
      : status === "failed"
        ? "Paper processing failed; inspect the resource status before retrying."
        : status === "cancelled"
          ? "Paper processing was cancelled."
          : "Paper processing is still in progress; this request remains resumable.",
  };
}

async function replayPaperContinuations(
  env: Env,
  sessionId: string,
  userId: string,
  turnId: string,
): Promise<Response | null> {
  const rows = await listOwnedPaperRequestContinuationsForTurn(env, sessionId, userId, turnId);
  if (rows.length === 0) return null;
  const events: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    const current = await syncPaperRequestContinuation(env, {
      continuationId: row.continuation_id,
      sessionId,
      userId,
      now: nowSeconds(),
    });
    if (current) events.push(paperContinuationEvent(current));
  }
  return sseResponse(events);
}

function paperContinuationErrorResponse(row: OwnedPaperRequestContinuation | null, now: number): Response {
  if (!row) return errorJson("Paper continuation not found", 404, "PAPER_CONTINUATION_NOT_FOUND");
  if (row.expires_at <= now || row.status === "expired") {
    return errorJson("Paper continuation expired", 410, "PAPER_CONTINUATION_EXPIRED");
  }
  if (row.status === "completed") {
    return errorJson("Paper continuation has already completed", 409, "PAPER_CONTINUATION_COMPLETED");
  }
  if (row.status === "failed" || row.resource_status === "failed") {
    return errorJson("Paper resource processing failed", 409, "PAPER_RESOURCE_FAILED");
  }
  if (row.status === "cancelled" || row.resource_status === "cancelled" || row.resource_status === "deleted") {
    return errorJson("Paper continuation was cancelled", 409, "PAPER_CONTINUATION_CANCELLED");
  }
  if (row.status === "waiting" || row.resource_status !== "ready") {
    return errorJson("Paper resource is not ready", 409, "PAPER_CONTINUATION_NOT_READY");
  }
  return errorJson("Paper continuation is already running", 409, "PAPER_CONTINUATION_IN_PROGRESS");
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
  const paperIntent = isPaperIntent(userContent);
  const paperMaterializationIntent = isPaperMaterializationIntent(userContent);
  const existingPaperReferenceIntent = isExistingPaperReferenceIntent(userContent);

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
        const replay = await replayPaperContinuations(env, sessionId, user.userId, `client:${clientRequestId}`);
        if (replay) return replay;
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
    {
      forceTaskConfirmation: shouldRequestTaskConfirmation(userContent),
      paperIntent: paperIntent && !existingPaperReferenceIntent,
      paperMaterializationIntent: paperMaterializationIntent && !existingPaperReferenceIntent,
      clientRequestId: clientRequestId || null,
    },
    clientRequestId
      ? {
          onResult: async (result) => {
            if (result.status === "failed") {
              await releaseChatRequestIdempotency(env, user.userId, clientRequestId);
              return;
            }
            if (result.status === "paper_processing") return;
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
 * Resume the original paper request after its D1/R2 resource becomes ready.
 * The client submits only the session and opaque continuation ID; resource
 * ownership, readiness, lease fencing, and the next Paper action are derived
 * and checked on the server.
 */
export async function handlePaperContinuation(request: Request, env: Env, user: AuthedUser): Promise<Response> {
  if (request.method !== "POST") return errorJson("Method not allowed", 405, "METHOD_NOT_ALLOWED");
  const match = new URL(request.url).pathname.match(/^\/api\/paper\/continuations\/([^/]+)$/);
  if (!match) return errorJson("Paper continuation not found", 404, "PAPER_CONTINUATION_NOT_FOUND");
  let continuationId: string;
  try {
    continuationId = decodeURIComponent(match[1]).trim();
  } catch {
    return errorJson("Paper continuation not found", 404, "PAPER_CONTINUATION_NOT_FOUND");
  }
  if (!continuationId || continuationId.length > 255) {
    return errorJson("Paper continuation not found", 404, "PAPER_CONTINUATION_NOT_FOUND");
  }

  let body: { session_id?: string };
  try {
    body = await request.json() as { session_id?: string };
  } catch {
    return errorJson("Body must be JSON", 400, "BAD_JSON");
  }
  const sessionId = String(body?.session_id ?? "").trim();
  if (!sessionId || sessionId.length > 255) return errorJson("session_id is required", 400, "MISSING_SESSION");

  const now = nowSeconds();
  let row = await getOwnedPaperRequestContinuation(env, continuationId, sessionId, user.userId);
  row = row
    ? await syncPaperRequestContinuation(env, { continuationId, sessionId, userId: user.userId, now })
    : null;
  if (!row) return paperContinuationErrorResponse(null, now);

  const canClaim = row.expires_at > now && row.resource_status === "ready"
    && (row.status === "ready" || (row.status === "running" && row.lease_expires_at != null && row.lease_expires_at <= now));
  if (!canClaim) return paperContinuationErrorResponse(row, now);

  const runTurnId = `paper-continuation:${crypto.randomUUID()}`;
  const claimed = await claimPaperRequestContinuation(env, {
    continuationId,
    sessionId,
    userId: user.userId,
    runTurnId,
    now,
    leaseExpiresAt: now + PAPER_CONTINUATION_LEASE_SECONDS,
  });
  if (!claimed) {
    const current = await syncPaperRequestContinuation(env, { continuationId, sessionId, userId: user.userId, now: nowSeconds() });
    return paperContinuationErrorResponse(current, nowSeconds());
  }

  try {
    await insertChatEvent(env, {
      session_id: sessionId,
      turn_id: runTurnId,
      event_type: "system_status",
      role: "system",
      content: truncateUtf8(
        `Paper resource ${claimed.resource_id} is ready. continue the original paper request by using read_paper or analyze_paper_image for this same resource. Do not claim completion from prose alone.`,
        2_048,
      ),
      status: "paper_continuation",
      created_at: nowSeconds(),
    });
  } catch {
    await releasePaperRequestContinuation(env, {
      continuationId,
      sessionId,
      userId: user.userId,
      runTurnId,
      errorCode: "PAPER_CONTINUATION_PERSISTENCE_FAILED",
    });
    return errorJson("Paper continuation could not be persisted", 503, "PAPER_CONTINUATION_PERSISTENCE_FAILED");
  }

  const modelMessages = rebuildModelMessages(await listChatEvents(env, sessionId));
  return streamModelLoop(env, user, sessionId, runTurnId, modelMessages, false, {
    paperIntent: true,
    paperContinuation: { continuationId, resourceId: claimed.resource_id },
  }, {
    onResult: async (result) => {
      if (result.status === "completed") {
        const completed = await completePaperRequestContinuation(env, {
          continuationId,
          sessionId,
          userId: user.userId,
          runTurnId,
          responseText: result.assistantText,
          now: nowSeconds(),
        });
        if (!completed) throw new Error("Paper continuation could not be completed");
        return;
      }
      await releasePaperRequestContinuation(env, {
        continuationId,
        sessionId,
        userId: user.userId,
        runTurnId,
        errorCode: result.errorCode ?? "PAPER_CONTINUATION_NOT_COMPLETED",
        now: nowSeconds(),
      });
    },
    onError: async () => {
      await releasePaperRequestContinuation(env, {
        continuationId,
        sessionId,
        userId: user.userId,
        runTurnId,
        errorCode: "PAPER_CONTINUATION_MODEL_FAILED",
        now: nowSeconds(),
      });
    },
  });
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

  return streamModelLoop(env, user, sessionId, resumeTurnId, modelMessages, false, {}, {
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
  options: StreamOptions = {},
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
          options,
        );
        if (result.assistantText.trim() || ["completed", "paper_processing", "failed"].includes(result.status)) {
          await insertChatEvent(env, {
            session_id: sessionId,
            turn_id: turnId,
            event_type: "assistant_message",
            role: "assistant",
            content: result.assistantText || null,
            status: result.status === "paper_processing" ? "processing" : result.status === "failed" ? "failed" : "completed",
            created_at: nowSeconds(),
          });
          await touchChatSession(env, sessionId);
        }
        if (result.status === "failed") {
          await persistTerminalError(
            env,
            sessionId,
            turnId,
            result.errorCode ?? "Paper request failed",
          );
        }
        if (lifecycle?.onResult) {
          await lifecycle.onResult(result);
        }
        if (result.status === "completed") {
          emit({ type: "done" });
        } else if (result.status === "paper_processing") {
          emit({
            type: "paper_processing",
            correlation_id: truncateUtf8(turnId, 255),
            continuation_id: result.paperContinuationId ?? null,
            resource_id: result.paperResourceId ?? null,
            status: "processing",
            message: "Paper processing is durable and this request remains resumable; it is not complete.",
          });
        } else if (result.status === "failed") {
          emit({
            type: "error",
            code: result.errorCode ?? "PAPER_REQUEST_FAILED",
            message: result.errorCode === "PAPER_TOOL_CALL_REQUIRED"
              ? "No readable paper resource is available for this request yet. Papers must first be searched in this session; a full-text request then creates a durable PDF resource before text or images can be read."
              : result.errorCode === "PAPER_MATERIALIZE_REQUIRED"
                ? "The paper request found no eligible paper that could be materialized, so no PDF resource was created."
                : result.errorCode === "PAPER_MATERIALIZE_FAILED"
                  ? "The paper request could not create a durable PDF resource."
              : result.errorCode === "PAPER_CONTINUATION_TOOL_REQUIRED"
                  ? "The ready paper request did not produce the required read or image action."
                  : "The paper request could not be completed.",
          });
        }
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
  options: StreamOptions = {},
): Promise<ChatLoopResult> {
  let finalText = "";
  let pendingPaper: { continuationId: string; resourceId: string } | null = null;
  let sawPaperToolCall = false;
  let paperToolFailed = false;
  let materializeAttempted = false;
  let materializeSucceeded = false;
  let materializeFailure = false;
  let continuationReadSucceeded = false;
  const forceTaskConfirmation = options.forceTaskConfirmation === true;
  const paperIntent = options.paperIntent === true;
  const paperMaterializationIntent = options.paperMaterializationIntent === true;
  const paperContinuation = options.paperContinuation;
  const materializableSearchRefs = new Set<string>();

  const recordPaperToolOutcome = (toolName: string, result: string, continuationScoped: boolean): void => {
    const paperPayload = PAPER_TOOL_NAMES.has(toolName) ? parsePaperToolPayload(result) : null;
    if (toolName === "search_paper" && !paperPayload?.error) {
      const paperRef = firstMaterializableSearchRef(result);
      if (paperRef) materializableSearchRefs.add(paperRef);
    }
    if (toolName === "materialize_paper") {
      const validMaterialization = !paperPayload?.error
        && (paperPayload?.mode === "processing" || paperPayload?.mode === "ready")
        && safePaperOpaqueId(paperPayload.resource_id)
        && safePaperOpaqueId(paperPayload.continuation_id);
      if (validMaterialization) {
        materializeSucceeded = true;
        if (paperPayload.mode === "processing") {
          pendingPaper = {
            resourceId: paperPayload.resource_id as string,
            continuationId: paperPayload.continuation_id as string,
          };
        }
      } else {
        materializeFailure = true;
        paperToolFailed = true;
      }
    }
    if (PAPER_TOOL_NAMES.has(toolName) && (paperPayload?.error
      || paperPayload?.status === "failed"
      || paperPayload?.status === "cancelled"
      || paperPayload?.status === "deleted")) {
      paperToolFailed = true;
      if (toolName === "materialize_paper") materializeFailure = true;
    }
    if (paperContinuation && (toolName === "read_paper" || toolName === "analyze_paper_image")
      && continuationScoped && !paperPayload?.error && paperPayload?.mode !== "processing") {
      continuationReadSucceeded = true;
    }
  };

  const synthesizeMaterializeFromSearch = async (): Promise<void> => {
    if (materializeAttempted) return;
    const paperRef = materializableSearchRefs.values().next().value as string | undefined;
    if (!paperRef) return;

    const call: ToolCall = {
      id: crypto.randomUUID(),
      type: "function",
      function: { name: "materialize_paper", arguments: JSON.stringify({ paper_ref: paperRef }) },
    };
    materializeAttempted = true;
    await persistToolCallEvents(env, sessionId, turnId, "", [call]);
    messages.push({ role: "assistant", content: null, tool_calls: [call] });
    emitToolCallEvent(emit, turnId, call, "pending");
    emitToolCallEvent(emit, turnId, call, "processing");
    emitStatus("tool_running", { tool_name: call.function.name });

    let result: string;
    try {
      result = await runTool(env, sessionId, userId, call.function.name, { paper_ref: paperRef }, {
        turnId,
        clientRequestId: options.clientRequestId ?? null,
      });
    } catch (error) {
      const failedResult = JSON.stringify({ error: "tool_execution_failed" });
      await persistToolResultEvent(env, sessionId, turnId, call.id, failedResult);
      emitToolResultEvent(emit, turnId, call, failedResult);
      messages.push({ role: "tool", tool_call_id: call.id, content: failedResult });
      throw error;
    }
    recordPaperToolOutcome(call.function.name, result, true);
    await persistToolResultEvent(env, sessionId, turnId, call.id, result);
    emitToolResultEvent(emit, turnId, call, result);
    messages.push({ role: "tool", tool_call_id: call.id, content: result });
  };

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

    if (paperContinuation && !forceTaskConfirmation && iteration === 0 && toolCalls.length === 0) {
      return { status: "failed", assistantText: content, errorCode: "PAPER_CONTINUATION_TOOL_REQUIRED" };
    }
    if (paperIntent && !forceTaskConfirmation && iteration === 0 && toolCalls.length === 0) {
      return { status: "failed", assistantText: content, errorCode: "PAPER_TOOL_CALL_REQUIRED" };
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
        const isPaperTool = PAPER_TOOL_NAMES.has(call.function.name);
        if (isPaperTool) sawPaperToolCall = true;
        if (call.function.name === "materialize_paper") materializeAttempted = true;
        if (call.function.name === "request_task_creation") {
          return await pauseForTaskConfirmation(env, sessionId, userId, call.id, args, content, emit);
        }

        let result: string;
        const continuationResourceId = typeof args.resource_id === "string" ? args.resource_id.trim() : "";
        const continuationScoped = !paperContinuation || (
          (call.function.name === "read_paper" || call.function.name === "analyze_paper_image")
          && continuationResourceId === paperContinuation.resourceId
        );
        if (!continuationScoped) {
          result = JSON.stringify({ error: "paper_continuation_scope_forbidden" });
          paperToolFailed = true;
        } else try {
          result = await runTool(env, sessionId, userId, call.function.name, args, {
            turnId,
            clientRequestId: options.clientRequestId ?? null,
          });
        } catch (error) {
          const failedResult = JSON.stringify({ error: "tool_execution_failed" });
          await persistToolResultEvent(env, sessionId, turnId, call.id, failedResult);
          emitToolResultEvent(emit, turnId, call, failedResult);
          messages.push({ role: "tool", tool_call_id: call.id, content: failedResult });
          throw error;
        }
        recordPaperToolOutcome(call.function.name, result, continuationScoped);
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

  if (paperMaterializationIntent && !materializeSucceeded && !materializeAttempted && !paperToolFailed) {
    await synthesizeMaterializeFromSearch();
  }
  if (paperContinuation) {
    if (paperToolFailed) return { status: "failed", assistantText: finalText, errorCode: "PAPER_CONTINUATION_TOOL_FAILED" };
    if (!continuationReadSucceeded) return { status: "failed", assistantText: finalText, errorCode: "PAPER_CONTINUATION_TOOL_REQUIRED" };
  }
  if (paperToolFailed) {
    return {
      status: "failed",
      assistantText: finalText,
      errorCode: materializeFailure ? "PAPER_MATERIALIZE_FAILED" : "PAPER_TOOL_EXECUTION_FAILED",
    };
  }
  if (paperMaterializationIntent && !materializeSucceeded) {
    return {
      status: "failed",
      assistantText: finalText,
      errorCode: materializeAttempted ? "PAPER_MATERIALIZE_FAILED" : "PAPER_MATERIALIZE_REQUIRED",
    };
  }
  const resumablePaper = pendingPaper as { continuationId: string; resourceId: string } | null;
  if (resumablePaper) {
    return {
      status: "paper_processing",
      assistantText: finalText,
      paperContinuationId: resumablePaper.continuationId,
      paperResourceId: resumablePaper.resourceId,
    };
  }
  if (paperIntent && !sawPaperToolCall) {
    return { status: "failed", assistantText: finalText, errorCode: "PAPER_TOOL_CALL_REQUIRED" };
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

  const requestWithRetry = async (withToolChoice: boolean): Promise<Response> => {
    let latest: Response | null = null;
    for (let attempt = 0; attempt < MAX_MODEL_ATTEMPTS; attempt += 1) {
      const response = await requestCompletion(withToolChoice);
      latest = response;
      if (response.ok || !MODEL_RETRYABLE_STATUSES.has(response.status) || attempt === MAX_MODEL_ATTEMPTS - 1) {
        return response;
      }
      // Drain a retryable error body before retrying so its connection can be
      // reclaimed. The delay is bounded: chat remains responsive and a real
      // provider outage is still surfaced rather than hidden indefinitely.
      await response.text().catch(() => "");
      const retryAfterSeconds = Number(response.headers.get("retry-after"));
      const delayMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
        ? Math.min(Math.round(retryAfterSeconds * 1000), 2_000)
        : 250 * (attempt + 1);
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
    // The loop always returns; this guard keeps TypeScript's control flow
    // explicit without manufacturing a successful model response.
    return latest as Response;
  };

  let upstream: Response;
  try {
    upstream = await requestWithRetry(forceTaskConfirmation);
  } catch (error) {
    if (!forceTaskConfirmation) throw error;
    // Some OpenAI-compatible providers reject tool_choice even though they
    // accept tools. Retry without the optional hint; runToolLoop still
    // synthesizes the safe confirmation card if the model asks questions.
    upstream = await requestWithRetry(false);
  }

  if ((!upstream.ok || !upstream.body) && forceTaskConfirmation) {
    await upstream.text().catch(() => "");
    upstream = await requestWithRetry(false);
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
