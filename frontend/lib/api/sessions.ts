import type { Message, SessionItem } from "@/lib/chat-state";
import type { PaperTaskCandidate } from "@/lib/paper-task";
import { withCsrfHeader } from "@/lib/runtime-config";

const MAX_TIMELINE_SUMMARY_CHARS = 2048;
const MAX_TIMELINE_ARGUMENTS_CHARS = 1024;
const MAX_TIMELINE_EVENTS = 100;
const MAX_PAPER_TASKS = 100;

export interface SessionHistoryEvent {
  session_id: string;
  event_id: number;
  turn_id: string;
  event_type: "tool_call" | "tool_result";
  tool_call_id: string;
  tool_name: string;
  status: "pending" | "processing" | "succeeded" | "failed" | "unknown";
  summary: string;
  arguments_summary?: string;
}

export interface SessionHistory {
  messages: Message[];
  timeline: SessionHistoryEvent[];
  paperTasks: PaperTaskCandidate[];
  legacyTextOnly: boolean;
}

export interface ApiError extends Error {
  status?: number;
  detail?: string;
}

function createApiError(message: string, status?: number, detail?: string): ApiError {
  const error = new Error(message) as ApiError;
  error.status = status;
  error.detail = detail;
  return error;
}

async function parseErrorResponse(response: Response): Promise<string> {
  // A Response body is single-use.  Read it once, then attempt JSON parsing
  // from the captured text so a non-standard JSON error cannot turn into the
  // misleading "body stream already read" exception.
  const body = await response.text();
  try {
    const payload = JSON.parse(body) as { detail?: unknown };
    if (payload && typeof payload.detail === "string") {
      return payload.detail;
    }
  } catch {
    // ignore malformed json
  }
  return body || `HTTP ${response.status}`;
}

async function requestJson<T>(input: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(input, { credentials: "include", ...init, headers: withCsrfHeader(init?.headers) });
  } catch (error) {
    throw createApiError(
      `Network request failed: ${error instanceof Error ? error.message : "unknown error"}`,
      undefined,
      "network_error",
    );
  }

  if (response.status === 401) {
    // The public landing page is intentionally usable without a session.  Let
    // the UI offer an explicit sign-in action instead of redirecting on load.
    throw createApiError("Authentication required", 401, "unauthenticated");
  }

  if (!response.ok) {
    const detail = await parseErrorResponse(response);
    throw createApiError(`Request failed (${response.status})`, response.status, detail);
  }
  return response.json() as Promise<T>;
}

export async function listSessions(apiBase: string): Promise<SessionItem[]> {
  const data = await requestJson<unknown>(`${apiBase}/api/sessions`);
  return Array.isArray(data) ? (data as SessionItem[]) : [];
}

export async function createSession(apiBase: string): Promise<{ session_id: string; storage_mode?: string }> {
  return requestJson(`${apiBase}/api/sessions`, { method: "POST" });
}

function boundedText(value: unknown, maxChars: number): string {
  return typeof value === "string" ? value.slice(0, maxChars) : "";
}

function normalizeMessages(value: unknown): Message[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && typeof item === "object")
    .map((item) => item as Record<string, unknown>)
    .filter((item) => (item.role === "user" || item.role === "assistant") && typeof item.content === "string")
    .map((item) => ({ role: item.role as "user" | "assistant", content: boundedText(item.content, 32_000) }));
}

function normalizeTimeline(value: unknown, sessionId: string): SessionHistoryEvent[] {
  if (!Array.isArray(value)) return [];
  const collapsed = new Map<string, SessionHistoryEvent>();
  for (const item of value
    .filter((item) => item && typeof item === "object")
    .map((item) => item as Record<string, unknown>)
    .filter((item) => item.session_id === sessionId)
    .filter((item) => (item.event_type === "tool_call" || item.event_type === "tool_result"))
    .filter((item) => typeof item.tool_call_id === "string" && typeof item.tool_name === "string")
    .slice(0, MAX_TIMELINE_EVENTS)) {
    const event = {
      session_id: sessionId,
      event_id: Number.isFinite(Number(item.event_id)) ? Number(item.event_id) : 0,
      turn_id: boundedText(item.turn_id, 255),
      event_type: item.event_type as "tool_call" | "tool_result",
      tool_call_id: boundedText(item.tool_call_id, 255),
      tool_name: boundedText(item.tool_name, 255),
      status: ["pending", "processing", "succeeded", "failed"].includes(String(item.status))
        ? item.status as SessionHistoryEvent["status"]
        : "unknown",
      summary: boundedText(item.summary, MAX_TIMELINE_SUMMARY_CHARS),
      ...(typeof item.arguments_summary === "string"
        ? { arguments_summary: boundedText(item.arguments_summary, MAX_TIMELINE_ARGUMENTS_CHARS) }
        : {}),
    } as SessionHistoryEvent;
    const previous = collapsed.get(event.tool_call_id);
    collapsed.set(event.tool_call_id, previous
      ? { ...previous, ...(event.event_type === "tool_result" ? { status: event.status, summary: event.summary } : {}) }
      : event);
  }
  return [...collapsed.values()];
}

function normalizePaperTasks(value: unknown): PaperTaskCandidate[] {
  if (!Array.isArray(value)) return [];
  const byResource = new Map<string, PaperTaskCandidate>();
  for (const item of value.slice(0, MAX_PAPER_TASKS)
    .filter((item) => item && typeof item === "object")
    .map((item) => item as Record<string, unknown>)) {
    const resourceId = typeof item.resource_id === "string" && /^\S{1,255}$/.test(item.resource_id)
      ? item.resource_id
      : null;
    const continuationId = item.continuation_id == null
      ? null
      : typeof item.continuation_id === "string" && /^\S{1,255}$/.test(item.continuation_id)
        ? item.continuation_id
        : null;
    const correlationId = typeof item.correlation_id === "string" && /^\S{1,255}$/.test(item.correlation_id)
      ? item.correlation_id
      : null;
    const toolCallId = typeof item.tool_call_id === "string" && /^\S{1,255}$/.test(item.tool_call_id)
      ? item.tool_call_id
      : null;
    if (!resourceId || !correlationId || !toolCallId
      || item.materialize_status !== "succeeded" || item.readiness !== "unknown") continue;
    byResource.set(resourceId, {
      resourceId,
      continuationId,
      correlationId,
      toolCallId,
      materializeStatus: "succeeded",
      readiness: "unknown",
    });
  }
  return [...byResource.values()];
}

export async function listSessionHistory(apiBase: string, sessionId: string): Promise<SessionHistory> {
  const data = await requestJson<unknown>(`${apiBase}/api/sessions/${sessionId}/messages`);
  if (Array.isArray(data)) {
    return { messages: normalizeMessages(data), timeline: [], paperTasks: [], legacyTextOnly: true };
  }
  const record = data && typeof data === "object" ? data as Record<string, unknown> : {};
  return {
    messages: normalizeMessages(record.messages),
    timeline: normalizeTimeline(record.events, sessionId),
    paperTasks: normalizePaperTasks(record.paper_tasks),
    legacyTextOnly: record.legacy_text_only === true,
  };
}

export async function listSessionMessages(apiBase: string, sessionId: string): Promise<Message[]> {
  return (await listSessionHistory(apiBase, sessionId)).messages;
}

export async function updateSessionTitle(apiBase: string, sessionId: string, title: string): Promise<void> {
  await requestJson(`${apiBase}/api/sessions/${sessionId}/title`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
}

export async function deleteSession(apiBase: string, sessionId: string): Promise<void> {
  await requestJson(`${apiBase}/api/sessions/${sessionId}`, {
    method: "DELETE",
  });
}
