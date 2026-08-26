import type { Env } from "./env";
import type { AuthedUser } from "./auth";
import { errorJson, json } from "./http";
import {
  createChatSession,
  deleteChatSession,
  getChatSession,
  listChatEvents,
  listChatSessions,
  listMessages,
  renameChatSession
} from "./db";
import type { ChatEventRow } from "./db";

const MAX_HISTORY_TEXT_CHARS = 32_000;
const MAX_HISTORY_SUMMARY_CHARS = 2_048;
const MAX_HISTORY_ARGUMENTS_CHARS = 1_024;
const MAX_HISTORY_EVENTS = 100;

function boundedText(value: string | null | undefined, maxChars: number): string {
  return (value ?? "").slice(0, maxChars);
}

function redactArgumentValue(key: string, value: unknown): unknown {
  if (/(?:secret|token|password|authorization|credential|cookie|api[_-]?key|object[_-]?key|path)/i.test(key)) {
    return "[redacted]";
  }
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redactArgumentValue(key, item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).slice(0, 40).map(([childKey, childValue]) => [
      childKey,
      redactArgumentValue(childKey, childValue),
    ]));
  }
  return typeof value === "string" ? boundedText(value, 256) : value;
}

function safeArgumentsSummary(argumentsJson: string | null): string | undefined {
  if (!argumentsJson) return undefined;
  try {
    const parsed = JSON.parse(argumentsJson) as unknown;
    return boundedText(JSON.stringify(redactArgumentValue("", parsed)), MAX_HISTORY_ARGUMENTS_CHARS);
  } catch {
    return "[invalid arguments]";
  }
}

function safeResultSummary(summary: string | null): string {
  return boundedText(summary, MAX_HISTORY_SUMMARY_CHARS);
}

function toHistoryMessages(rows: ChatEventRow[]): Array<{ role: "user" | "assistant"; content: string }> {
  return rows
    .filter((row) => (row.event_type === "user_message" || row.event_type === "assistant_message")
      && (row.role === "user" || row.role === "assistant")
      && row.content != null)
    .map((row) => ({ role: row.role as "user" | "assistant", content: boundedText(row.content, MAX_HISTORY_TEXT_CHARS) }));
}

function toSafeHistoryEvents(rows: ChatEventRow[]): Array<Record<string, unknown>> {
  const toolNames = new Map(
    rows
      .filter((row) => row.event_type === "tool_call" && row.tool_call_id && row.tool_name)
      .map((row) => [row.tool_call_id as string, row.tool_name as string]),
  );
  const collapsed = new Map<string, Record<string, unknown>>();
  for (const row of rows
    .filter((row) => row.event_type === "tool_call" || row.event_type === "tool_result")
    .filter((row) => row.tool_call_id)
    .slice(0, MAX_HISTORY_EVENTS)) {
    const callId = row.tool_call_id as string;
    const previous = collapsed.get(callId);
    const next = {
      session_id: row.session_id,
      event_id: row.event_id,
      turn_id: boundedText(row.turn_id, 255),
      event_type: row.event_type,
      tool_call_id: row.tool_call_id,
      tool_name: row.tool_name ?? toolNames.get(row.tool_call_id as string) ?? "unknown",
      status: row.status ?? "unknown",
      summary: row.event_type === "tool_result" ? safeResultSummary(row.result_summary) : "",
      ...(row.event_type === "tool_call" ? { arguments_summary: safeArgumentsSummary(row.tool_arguments_json) } : {}),
    };
    collapsed.set(callId, previous
      ? {
          ...previous,
          ...(row.event_type === "tool_result" ? { status: next.status, summary: next.summary } : {}),
        }
      : next);
  }
  return [...collapsed.values()];
}

function toSessionItem(row: { id: string; title: string; created_at: number; updated_at: number }) {
  return {
    session_id: row.id,
    title: row.title,
    created_at: new Date(row.created_at * 1000).toISOString(),
    updated_at: new Date(row.updated_at * 1000).toISOString()
  };
}

/** POST /api/sessions */
export async function createSession(env: Env, user: AuthedUser): Promise<Response> {
  const id = crypto.randomUUID();
  const row = await createChatSession(env, id, user.userId, "New chat");
  return json({ ...toSessionItem(row), storage_mode: "sandboxed" }, 201);
}

/** GET /api/sessions */
export async function getSessions(env: Env, user: AuthedUser): Promise<Response> {
  const rows = await listChatSessions(env, user.userId);
  return json(rows.map(toSessionItem));
}

/** GET /api/sessions/:id/messages */
export async function getSessionMessages(env: Env, user: AuthedUser, sessionId: string): Promise<Response> {
  const owned = await getChatSession(env, sessionId, user.userId);
  if (!owned) return errorJson("Session not found", 404, "NOT_FOUND");
  const eventRows = await listChatEvents(env, sessionId);
  const legacyTextOnly = eventRows.length === 0
    || eventRows.every((row) => row.status === "legacy" && (row.event_type === "user_message" || row.event_type === "assistant_message"));
  if (eventRows.length === 0) {
    const rows = await listMessages(env, sessionId);
    return json({
      messages: rows
        .filter((row) => row.role === "user" || row.role === "assistant")
        .map((row) => ({ role: row.role, content: boundedText(row.content, MAX_HISTORY_TEXT_CHARS) })),
      events: [],
      legacy_text_only: true,
    });
  }
  return json({
    messages: toHistoryMessages(eventRows),
    events: legacyTextOnly ? [] : toSafeHistoryEvents(eventRows),
    legacy_text_only: legacyTextOnly,
  });
}

/** PATCH /api/sessions/:id/title */
export async function updateSessionTitle(
  env: Env,
  user: AuthedUser,
  sessionId: string,
  request: Request
): Promise<Response> {
  let body: { title?: string };
  try {
    body = await request.json();
  } catch {
    return errorJson("Body must be JSON", 400, "BAD_JSON");
  }
  const title = (body.title ?? "").trim();
  if (!title) return errorJson("Title cannot be empty", 400, "EMPTY_TITLE");
  if (title.length > 255) return errorJson("Title too long", 400, "TITLE_TOO_LONG");
  const ok = await renameChatSession(env, sessionId, user.userId, title);
  if (!ok) return errorJson("Session not found", 404, "NOT_FOUND");
  return json({ session_id: sessionId, title });
}

/** DELETE /api/sessions/:id */
export async function removeSession(env: Env, user: AuthedUser, sessionId: string): Promise<Response> {
  const ok = await deleteChatSession(env, sessionId, user.userId);
  if (!ok) return errorJson("Session not found", 404, "NOT_FOUND");
  return json({ session_id: sessionId });
}
