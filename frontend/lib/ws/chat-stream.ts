import type { RunPhase, TokenInfo } from "@/lib/chat-state";
import { translate, type Language } from "@/lib/i18n";
import { redirectToLogin, withCsrfHeader } from "@/lib/runtime-config";
import type { ChatTaskConfirmation, TaskDraft } from "@/lib/api/tasks";

export interface ChatRequestPayload {
  session_id: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  retry_attempt: number;
  client_request_id: string;
  task_confirmation_id?: string;
  task_id?: string;
}

export interface ChatStatusEvent {
  type: "status";
  phase: RunPhase;
  elapsed_ms: number;
  attempt: number;
  max_attempts: number;
  tool_name?: string;
  reason?: string;
  correlation_id?: string;
}

export interface ChatChunkEvent {
  type: "chunk";
  content: string;
}

export interface ChatToolCallEvent {
  type: "tool_call";
  correlation_id: string;
  tool_call_id: string;
  tool_name: string;
  status: "pending" | "processing";
  arguments_summary: string;
}

export interface ChatToolResultEvent {
  type: "tool_result";
  correlation_id: string;
  tool_call_id: string;
  tool_name: string;
  status: "succeeded" | "failed";
  summary: string;
}

export interface ChatPaperProcessingEvent {
  type: "paper_processing";
  correlation_id: string;
  continuation_id: string | null;
  resource_id: string | null;
  status: "processing" | "requested" | "downloading" | "extracting" | "uploading" | "ready" | "failed" | "cancelled";
  message: string;
}

export interface ChatDoneEvent {
  type: "done";
  token_info?: Partial<TokenInfo>;
}

export interface ChatErrorEvent {
  type: "error";
  message: string;
}

export interface ChatTaskDraftEvent {
  type: "task_draft_created" | "task_draft_updated";
  draft: TaskDraft;
}

export interface ChatTaskDraftCancelledEvent {
  type: "task_draft_cancelled";
  draft_id: string;
  revision?: number;
  status: "cancelled";
}

export interface ChatTaskConfirmationEvent extends ChatTaskConfirmation {
  type: "task_confirmation";
}

export interface ChatTaskConfirmedEvent {
  type: "task_confirmed";
  task_id: string;
  status: string;
  attempt_count?: number;
  duplicate?: boolean;
}

export type ChatEvent = ChatStatusEvent | ChatChunkEvent | ChatToolCallEvent | ChatToolResultEvent | ChatPaperProcessingEvent | ChatTaskDraftEvent | ChatTaskDraftCancelledEvent | ChatTaskConfirmationEvent | ChatTaskConfirmedEvent | ChatDoneEvent | ChatErrorEvent;

export interface StartChatStreamOptions {
  apiBase: string;
  payload: ChatRequestPayload;
  onEvent: (event: ChatEvent) => void;
  onSocketError?: () => void;
  onClose?: () => void;
}

export interface ChatStreamHandle {
  close: (code?: number, reason?: string) => void;
  getReadyState: () => number;
}

// Mirrors WebSocket readyState constants so existing call sites keep working.
const OPEN = 1;
const CLOSED = 3;

const VALID_EVENT_TYPES = new Set(["status", "chunk", "tool_call", "tool_result", "paper_processing", "task_draft_created", "task_draft_updated", "task_draft_cancelled", "task_confirmation", "task_confirmed", "done", "error"]);
const MAX_EVENT_TEXT_CHARS = 2_048;
const MAX_ARGUMENTS_CHARS = 1_024;
const PAPER_PROCESSING_STATUSES = new Set<ChatPaperProcessingEvent["status"]>([
  "processing", "requested", "downloading", "extracting", "uploading", "ready", "failed", "cancelled",
]);

function boundedText(value: unknown, maxChars: number): string {
  return typeof value === "string" ? value.slice(0, maxChars) : "";
}

export function toFriendlyChatError(message: string, language: Language = "en"): string {
  if (message.includes("paper_not_authorized_for_session")) {
    return translate(language, "error.paperUnavailable");
  }
  return message;
}

export function normalizeChatEvent(rawData: unknown): ChatEvent | null {
  if (typeof rawData !== "string") return null;

  try {
    const payload = JSON.parse(rawData) as Record<string, unknown>;
    if (!VALID_EVENT_TYPES.has(String(payload.type))) {
      return null;
    }
    if (payload.type === "status") {
      return {
        type: "status",
        phase: typeof payload.phase === "string" ? (payload.phase as RunPhase) : "thinking",
        elapsed_ms: Number(payload.elapsed_ms) || 0,
        attempt: Number(payload.attempt) || 1,
        max_attempts: Number(payload.max_attempts) || 1,
        tool_name: typeof payload.tool_name === "string" ? payload.tool_name : undefined,
        reason: typeof payload.reason === "string" ? payload.reason : undefined,
        correlation_id: typeof payload.correlation_id === "string" ? boundedText(payload.correlation_id, 255) : undefined,
      };
    }
    if (payload.type === "chunk") {
      return { type: "chunk", content: typeof payload.content === "string" ? payload.content : "" };
    }
    if (payload.type === "tool_call") {
      if (typeof payload.correlation_id !== "string" || typeof payload.tool_call_id !== "string" || typeof payload.tool_name !== "string") return null;
      if (payload.status !== "pending" && payload.status !== "processing") return null;
      return {
        type: "tool_call",
        correlation_id: boundedText(payload.correlation_id, 255),
        tool_call_id: boundedText(payload.tool_call_id, 255),
        tool_name: boundedText(payload.tool_name, 255),
        status: payload.status,
        arguments_summary: boundedText(payload.arguments_summary, MAX_ARGUMENTS_CHARS),
      };
    }
    if (payload.type === "tool_result") {
      if (typeof payload.correlation_id !== "string" || typeof payload.tool_call_id !== "string" || typeof payload.tool_name !== "string") return null;
      if (payload.status !== "succeeded" && payload.status !== "failed") return null;
      return {
        type: "tool_result",
        correlation_id: boundedText(payload.correlation_id, 255),
        tool_call_id: boundedText(payload.tool_call_id, 255),
        tool_name: boundedText(payload.tool_name, 255),
        status: payload.status,
        summary: boundedText(payload.summary, MAX_EVENT_TEXT_CHARS),
      };
    }
    if (payload.type === "paper_processing") {
      if (typeof payload.correlation_id !== "string" || !payload.correlation_id
        || (payload.continuation_id !== null && (typeof payload.continuation_id !== "string" || !payload.continuation_id))
        || (payload.resource_id !== null && (typeof payload.resource_id !== "string" || !payload.resource_id))
        || typeof payload.message !== "string"
        || typeof payload.status !== "string"
        || !PAPER_PROCESSING_STATUSES.has(payload.status as ChatPaperProcessingEvent["status"])) return null;
      return {
        type: "paper_processing",
        correlation_id: boundedText(payload.correlation_id, 255),
        continuation_id: payload.continuation_id === null ? null : boundedText(payload.continuation_id, 255),
        resource_id: payload.resource_id === null ? null : boundedText(payload.resource_id, 255),
        status: payload.status as ChatPaperProcessingEvent["status"],
        message: boundedText(payload.message, MAX_EVENT_TEXT_CHARS),
      };
    }
    if (payload.type === "task_draft_created" || payload.type === "task_draft_updated") {
      if (!payload.draft || typeof payload.draft !== "object") return null;
      return { type: payload.type, draft: payload.draft as TaskDraft } as ChatTaskDraftEvent;
    }
    if (payload.type === "task_draft_cancelled") {
      if (typeof payload.draft_id !== "string") return null;
      return {
        type: "task_draft_cancelled",
        draft_id: payload.draft_id,
        revision: Number(payload.revision) || undefined,
        status: "cancelled",
      };
    }
    if (payload.type === "task_confirmation") {
      if (typeof payload.confirmation_id !== "string" || typeof payload.title !== "string") return null;
      return {
        type: "task_confirmation",
        confirmation_id: payload.confirmation_id,
        tool_name: typeof payload.tool_name === "string" ? payload.tool_name : "request_task_creation",
        title: payload.title,
        analysis_type: typeof payload.analysis_type === "string" ? payload.analysis_type : "generic",
        research_question: typeof payload.research_question === "string" ? payload.research_question : "",
        method_document_name: typeof payload.method_document_name === "string" ? payload.method_document_name : "",
        method_document_content: typeof payload.method_document_content === "string" ? payload.method_document_content : "",
        dataset_name: typeof payload.dataset_name === "string" ? payload.dataset_name : "",
      };
    }
    if (payload.type === "task_confirmed") {
      if (typeof payload.task_id !== "string" || typeof payload.status !== "string") return null;
      return {
        type: "task_confirmed",
        task_id: payload.task_id,
        status: payload.status,
        attempt_count: Number.isFinite(Number(payload.attempt_count)) ? Number(payload.attempt_count) : undefined,
        duplicate: typeof payload.duplicate === "boolean" ? payload.duplicate : undefined,
      };
    }
    if (payload.type === "done") {
      return { type: "done", token_info: (payload.token_info as Partial<TokenInfo> | undefined) ?? undefined };
    }
    if (payload.type === "error") {
      return { type: "error", message: typeof payload.message === "string" ? payload.message : "Connection error" };
    }
    return null;
  } catch {
    if (/^[{[]/.test(rawData.trim())) return null;
    return { type: "chunk", content: rawData };
  }
}

/** Consume an already-authenticated Paper continuation SSE response. */
export async function consumeChatEventStream(response: Response, onEvent: (event: ChatEvent) => void): Promise<void> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const emitFrame = (frame: string) => {
    const line = frame
      .split(/\r?\n/)
      .map((value) => value.trim())
      .find((value) => value.startsWith("data:"));
    if (!line) return;
    const data = line.slice(5).trim();
    if (!data) return;
    const event = normalizeChatEvent(data);
    if (event) onEvent(event);
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() ?? "";
    frames.forEach(emitFrame);
  }
  buffer += decoder.decode();
  if (buffer.trim()) emitFrame(buffer);
}

/**
 * Start a chat stream over Server-Sent Events. Issues a same-origin
 * `POST /api/chat` with the session cookie (credentials: "include") and parses
 * the `data: {...}` event stream. Returns a handle whose `close()` aborts the
 * in-flight request, preserving the previous WebSocket-style contract.
 */
export function startChatStream(options: StartChatStreamOptions): ChatStreamHandle {
  const controller = new AbortController();
  let readyState = OPEN;

  const finish = () => {
    if (readyState === CLOSED) return;
    readyState = CLOSED;
    options.onClose?.();
  };

  (async () => {
    let response: Response;
    try {
      response = await fetch(`${options.apiBase}/api/chat`, {
        method: "POST",
        headers: withCsrfHeader({ "Content-Type": "application/json", Accept: "text/event-stream" }),
        credentials: "include",
        body: JSON.stringify(options.payload),
        signal: controller.signal,
      });
    } catch {
      options.onSocketError?.();
      finish();
      return;
    }

    if (response.status === 401) {
      redirectToLogin();
      finish();
      return;
    }
    if (!response.ok || !response.body) {
      let message = `Request failed (${response.status})`;
      try {
        const payload = (await response.json()) as { error?: { message?: string } };
        if (payload?.error?.message) message = payload.error.message;
      } catch {
        // ignore
      }
      options.onEvent({ type: "error", message });
      finish();
      return;
    }

    try {
      await consumeChatEventStream(response, options.onEvent);
    } catch {
      if (!controller.signal.aborted) {
        options.onSocketError?.();
      }
    } finally {
      finish();
    }
  })();

  return {
    close: () => {
      controller.abort();
      finish();
    },
    getReadyState: () => readyState,
  };
}
