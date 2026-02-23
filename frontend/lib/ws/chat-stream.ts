import type { RunPhase, TokenInfo } from "@/lib/chat-state";

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
  wsBase: string;
  payload: ChatRequestPayload;
  onEvent: (event: ChatEvent) => void;
  onSocketError?: () => void;
  onClose?: () => void;
}

export interface ChatStreamHandle {
  close: (code?: number, reason?: string) => void;
  getReadyState: () => number;
}

const VALID_EVENT_TYPES = new Set(["status", "chunk", "tool_call", "done", "error"]);

export function toFriendlyChatError(message: string): string {
  if (message.includes("paper_not_authorized_for_session")) {
    return "该论文不在当前会话可访问范围，请先使用 search_paper 检索后再读。";
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
      return { type: "error", message: typeof payload.message === "string" ? payload.message : "连接出错" };
    }
    return null;
  } catch {
    return { type: "chunk", content: rawData };
  }
}

export function startChatStream(options: StartChatStreamOptions): ChatStreamHandle {
  const ws = new WebSocket(`${options.wsBase}/ws/chat`);

  ws.onopen = () => {
    ws.send(JSON.stringify(options.payload));
  };

  ws.onmessage = (event) => {
    const normalized = normalizeChatEvent(typeof event.data === "string" ? event.data : "");
    if (!normalized) return;
    options.onEvent(normalized);
  };

  ws.onerror = () => {
    options.onSocketError?.();
  };

  ws.onclose = () => {
    options.onClose?.();
  };

  return {
    close: (code, reason) => ws.close(code, reason),
    getReadyState: () => ws.readyState,
  };
}
