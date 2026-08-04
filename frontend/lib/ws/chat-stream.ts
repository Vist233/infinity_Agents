import type { RunPhase, TokenInfo } from "@/lib/chat-state";
import { redirectToLogin } from "@/lib/runtime-config";

export interface ChatRequestPayload {
  session_id: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  retry_attempt: number;
  client_request_id: string;
}

export interface ChatStatusEvent {
  type: "status";
  phase: RunPhase;
  elapsed_ms: number;
  attempt: number;
  max_attempts: number;
  tool_name?: string;
  reason?: string;
}

export interface ChatChunkEvent {
  type: "chunk";
  content: string;
}

export interface ChatToolCallEvent {
  type: "tool_call";
  tool_name: string;
}

export interface ChatDoneEvent {
  type: "done";
  token_info?: Partial<TokenInfo>;
}

export interface ChatErrorEvent {
  type: "error";
  message: string;
}

export type ChatEvent = ChatStatusEvent | ChatChunkEvent | ChatToolCallEvent | ChatDoneEvent | ChatErrorEvent;

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

const VALID_EVENT_TYPES = new Set(["status", "chunk", "tool_call", "done", "error"]);

export function toFriendlyChatError(message: string): string {
  if (message.includes("paper_not_authorized_for_session")) {
    return "This paper is not available in the current session. Search for it first, then read it.";
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
      };
    }
    if (payload.type === "chunk") {
      return { type: "chunk", content: typeof payload.content === "string" ? payload.content : "" };
    }
    if (payload.type === "tool_call") {
      if (typeof payload.tool_name !== "string") return null;
      return { type: "tool_call", tool_name: payload.tool_name };
    }
    if (payload.type === "done") {
      return { type: "done", token_info: (payload.token_info as Partial<TokenInfo> | undefined) ?? undefined };
    }
    if (payload.type === "error") {
      return { type: "error", message: typeof payload.message === "string" ? payload.message : "Connection error" };
    }
    return null;
  } catch {
    return { type: "chunk", content: rawData };
  }
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
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
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

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const line = frame
            .split("\n")
            .map((l) => l.trim())
            .find((l) => l.startsWith("data:"));
          if (!line) continue;
          const data = line.slice(5).trim();
          if (!data) continue;
          const event = normalizeChatEvent(data);
          if (event) options.onEvent(event);
        }
      }
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
