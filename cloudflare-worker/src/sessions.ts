import type { Env } from "./env";
import type { AuthedUser } from "./auth";
import { errorJson, json } from "./http";
import {
  createChatSession,
  deleteChatSession,
  getChatSession,
  listChatSessions,
  listMessages,
  renameChatSession
} from "./db";

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
  const rows = await listMessages(env, sessionId);
  return json(rows.map((m) => ({ role: m.role, content: m.content })));
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
