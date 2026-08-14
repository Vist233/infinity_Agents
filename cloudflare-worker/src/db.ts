import type { Env } from "./env";
import { nowSeconds } from "./http";

export interface AuthSessionRow {
  sid: string;
  user_id: string;
  email: string | null;
  access_token: string;
  access_expires_at: number;
  refresh_token: string;
  created_at: number;
  last_used_at: number;
  revoked_at: number | null;
}

export interface UserSettingsRow {
  user_id: string;
  locale: "zh" | "en";
  created_at: number;
  updated_at: number;
}

export interface ChatSessionRow {
  id: string;
  user_id: string;
  title: string;
  created_at: number;
  updated_at: number;
}

export interface ChatMessageRow {
  id: number;
  session_id: string;
  role: string;
  content: string;
  created_at: number;
}

export interface ChatTaskConfirmationRow {
  confirmation_id: string;
  session_id: string;
  user_id: string;
  tool_name: string;
  tool_call_id: string;
  tool_args_json: string;
  status: "pending" | "processing" | "completed" | "expired";
  task_id: string | null;
  created_at: number;
  expires_at: number;
  consumed_at: number | null;
}

export interface ChatRequestIdempotencyRow {
  user_id: string;
  session_id: string;
  client_request_id: string;
  status: "processing" | "confirmation" | "completed";
  confirmation_id: string | null;
  response_text: string;
  created_at: number;
  updated_at: number;
}

export interface OwnedTaskRow {
  task_id: string;
  title: string;
  status: string;
  created_by: string;
  chat_confirmation_id: string | null;
}

// --- auth sessions ---

export async function insertAuthSession(env: Env, row: Omit<AuthSessionRow, "revoked_at">): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO auth_sessions (sid, user_id, email, access_token, access_expires_at, refresh_token, created_at, last_used_at, revoked_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL)`
  )
    .bind(row.sid, row.user_id, row.email, row.access_token, row.access_expires_at, row.refresh_token, row.created_at, row.last_used_at)
    .run();
}

export async function getAuthSession(env: Env, sid: string): Promise<AuthSessionRow | null> {
  return env.DB.prepare("SELECT * FROM auth_sessions WHERE sid = ?1 AND revoked_at IS NULL").bind(sid).first<AuthSessionRow>();
}

export async function updateAuthSessionTokens(
  env: Env,
  sid: string,
  accessToken: string,
  accessExpiresAt: number,
  refreshToken: string
): Promise<void> {
  await env.DB.prepare(
    "UPDATE auth_sessions SET access_token = ?2, access_expires_at = ?3, refresh_token = ?4, last_used_at = ?5 WHERE sid = ?1"
  )
    .bind(sid, accessToken, accessExpiresAt, refreshToken, nowSeconds())
    .run();
}

export async function revokeAuthSession(env: Env, sid: string): Promise<void> {
  await env.DB.prepare("UPDATE auth_sessions SET revoked_at = ?2 WHERE sid = ?1").bind(sid, nowSeconds()).run();
}

// Worker control requests authenticate with a machine credential, so keep a
// product-side projection of the last verified Zhang Auth role for the
// registration owner. Missing rows are intentionally treated as ordinary
// trust by the control plane until a browser session refreshes this record.
export async function upsertUserAccessRole(env: Env, userId: string, role: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO user_access_roles (user_id, role, updated_at)
     VALUES (?1, ?2, ?3)
     ON CONFLICT(user_id) DO UPDATE SET role = excluded.role, updated_at = excluded.updated_at`,
  ).bind(userId, role || "user", nowSeconds()).run();
}

export async function getUserAccessRole(env: Env, userId: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT role FROM user_access_roles WHERE user_id = ?1")
    .bind(userId)
    .first<{ role: string }>();
  return row?.role ?? null;
}

// --- Infinity Agents product settings ---

export async function getUserSettings(env: Env, userId: string): Promise<UserSettingsRow | null> {
  return env.DB.prepare(
    "SELECT user_id, locale, created_at, updated_at FROM user_settings WHERE user_id = ?1",
  ).bind(userId).first<UserSettingsRow>();
}

export async function ensureUserSettings(env: Env, userId: string, locale: "zh" | "en"): Promise<UserSettingsRow> {
  const now = nowSeconds();
  await env.DB.prepare(
    `INSERT INTO user_settings (user_id, locale, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?3)
     ON CONFLICT(user_id) DO NOTHING`,
  ).bind(userId, locale, now).run();
  const settings = await getUserSettings(env, userId);
  if (!settings) throw new Error("Failed to initialize Infinity Agents user settings");
  return settings;
}

// --- chat sessions ---

export async function createChatSession(env: Env, id: string, userId: string, title: string): Promise<ChatSessionRow> {
  const ts = nowSeconds();
  await env.DB.prepare(
    "INSERT INTO chat_sessions (id, user_id, title, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)"
  )
    .bind(id, userId, title, ts)
    .run();
  return { id, user_id: userId, title, created_at: ts, updated_at: ts };
}

export async function listChatSessions(env: Env, userId: string): Promise<ChatSessionRow[]> {
  const res = await env.DB.prepare(
    "SELECT * FROM chat_sessions WHERE user_id = ?1 ORDER BY updated_at DESC LIMIT 200"
  )
    .bind(userId)
    .all<ChatSessionRow>();
  return res.results ?? [];
}

export async function getChatSession(env: Env, id: string, userId: string): Promise<ChatSessionRow | null> {
  return env.DB.prepare("SELECT * FROM chat_sessions WHERE id = ?1 AND user_id = ?2").bind(id, userId).first<ChatSessionRow>();
}

export async function renameChatSession(env: Env, id: string, userId: string, title: string): Promise<boolean> {
  const res = await env.DB.prepare(
    "UPDATE chat_sessions SET title = ?3, updated_at = ?4 WHERE id = ?1 AND user_id = ?2"
  )
    .bind(id, userId, title, nowSeconds())
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

export async function touchChatSession(env: Env, id: string): Promise<void> {
  await env.DB.prepare("UPDATE chat_sessions SET updated_at = ?2 WHERE id = ?1").bind(id, nowSeconds()).run();
}

export async function deleteChatSession(env: Env, id: string, userId: string): Promise<boolean> {
  const owned = await getChatSession(env, id, userId);
  if (!owned) return false;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM chat_messages WHERE session_id = ?1").bind(id),
    env.DB.prepare("DELETE FROM paper_authorizations WHERE session_id = ?1").bind(id),
    env.DB.prepare("DELETE FROM chat_sessions WHERE id = ?1 AND user_id = ?2").bind(id, userId)
  ]);
  return true;
}

// --- chat messages ---

export async function listMessages(env: Env, sessionId: string): Promise<ChatMessageRow[]> {
  const res = await env.DB.prepare(
    "SELECT * FROM chat_messages WHERE session_id = ?1 ORDER BY id ASC"
  )
    .bind(sessionId)
    .all<ChatMessageRow>();
  return res.results ?? [];
}

export async function insertMessage(env: Env, sessionId: string, role: string, content: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO chat_messages (session_id, role, content, created_at) VALUES (?1, ?2, ?3, ?4)"
  )
    .bind(sessionId, role, content, nowSeconds())
    .run();
}

// --- chat tool confirmations ---

export async function createChatTaskConfirmation(
  env: Env,
  row: Omit<ChatTaskConfirmationRow, "status" | "task_id" | "consumed_at">,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO chat_task_confirmations
       (confirmation_id, session_id, user_id, tool_name, tool_call_id, tool_args_json,
        status, task_id, created_at, expires_at, consumed_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', NULL, ?7, ?8, NULL)`,
  )
    .bind(
      row.confirmation_id,
      row.session_id,
      row.user_id,
      row.tool_name,
      row.tool_call_id,
      row.tool_args_json,
      row.created_at,
      row.expires_at,
    )
    .run();
}

export async function getChatTaskConfirmation(
  env: Env,
  confirmationId: string,
  sessionId: string,
  userId: string,
): Promise<ChatTaskConfirmationRow | null> {
  return env.DB.prepare(
    `SELECT confirmation_id, session_id, user_id, tool_name, tool_call_id, tool_args_json,
            status, task_id, created_at, expires_at, consumed_at
     FROM chat_task_confirmations
     WHERE confirmation_id = ?1 AND session_id = ?2 AND user_id = ?3`,
  )
    .bind(confirmationId, sessionId, userId)
    .first<ChatTaskConfirmationRow>();
}

export async function completeChatTaskConfirmation(
  env: Env,
  confirmationId: string,
  taskId: string,
  consumedAt: number,
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE chat_task_confirmations
     SET status = 'completed', task_id = ?2, consumed_at = ?3
     WHERE confirmation_id = ?1 AND status = 'processing'`,
  )
    .bind(confirmationId, taskId, consumedAt)
    .run();
  return (result.meta?.changes ?? 0) === 1;
}

export async function reopenChatTaskConfirmation(env: Env, confirmationId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE chat_task_confirmations SET status = 'pending'
     WHERE confirmation_id = ?1 AND status = 'processing'`,
  )
    .bind(confirmationId)
    .run();
}

export async function cancelChatTaskConfirmation(env: Env, confirmationId: string, userId: string): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE chat_task_confirmations SET status = 'expired'
     WHERE confirmation_id = ?1 AND user_id = ?2 AND status = 'pending'`,
  ).bind(confirmationId, userId).run();
  return (result.meta?.changes ?? 0) === 1;
}

export async function getOwnedTask(env: Env, taskId: string, userId: string): Promise<OwnedTaskRow | null> {
  return env.DB.prepare(
    `SELECT task_id, title, status, created_by, chat_confirmation_id
     FROM tasks WHERE task_id = ?1 AND created_by = ?2`,
  )
    .bind(taskId, userId)
    .first<OwnedTaskRow>();
}

export async function getChatTaskConfirmationForUser(
  env: Env,
  confirmationId: string,
  userId: string,
): Promise<ChatTaskConfirmationRow | null> {
  return env.DB.prepare(
    `SELECT confirmation_id, session_id, user_id, tool_name, tool_call_id, tool_args_json,
            status, task_id, created_at, expires_at, consumed_at
     FROM chat_task_confirmations
     WHERE confirmation_id = ?1 AND user_id = ?2`,
  )
    .bind(confirmationId, userId)
    .first<ChatTaskConfirmationRow>();
}

export async function bindChatTaskConfirmation(
  env: Env,
  confirmationId: string,
  userId: string,
  taskId: string,
  now: number,
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE chat_task_confirmations
     SET task_id = ?3
     WHERE confirmation_id = ?1 AND user_id = ?2 AND status = 'pending'
       AND task_id IS NULL AND expires_at > ?4`,
  )
    .bind(confirmationId, userId, taskId, now)
    .run();
  return (result.meta?.changes ?? 0) === 1;
}

export async function claimChatTaskConfirmation(
  env: Env,
  confirmationId: string,
  taskId: string,
): Promise<boolean> {
  // A non-null task_id is written only by the expiry-checked task submission
  // path, so a bound task may finish its model continuation after the card's
  // 30-minute input window has elapsed.
  const result = await env.DB.prepare(
    `UPDATE chat_task_confirmations
     SET status = 'processing'
     WHERE confirmation_id = ?1 AND status = 'pending' AND task_id = ?2`,
  )
    .bind(confirmationId, taskId)
    .run();
  return (result.meta?.changes ?? 0) === 1;
}

export async function getChatRequestIdempotency(
  env: Env,
  userId: string,
  clientRequestId: string,
): Promise<ChatRequestIdempotencyRow | null> {
  return env.DB.prepare(
    `SELECT user_id, session_id, client_request_id, status, confirmation_id,
            response_text, created_at, updated_at
     FROM chat_request_idempotency
     WHERE user_id = ?1 AND client_request_id = ?2`,
  )
    .bind(userId, clientRequestId)
    .first<ChatRequestIdempotencyRow>();
}

export async function reserveChatRequestIdempotency(
  env: Env,
  userId: string,
  sessionId: string,
  clientRequestId: string,
  now: number,
): Promise<boolean> {
  const result = await env.DB.prepare(
    `INSERT INTO chat_request_idempotency
       (user_id, session_id, client_request_id, status, confirmation_id, response_text, created_at, updated_at)
     VALUES (?1, ?2, ?3, 'processing', NULL, '', ?4, ?4)
     ON CONFLICT(user_id, client_request_id) DO NOTHING`,
  )
    .bind(userId, sessionId, clientRequestId, now)
    .run();
  return (result.meta?.changes ?? 0) === 1;
}

export async function completeChatRequestIdempotency(
  env: Env,
  userId: string,
  clientRequestId: string,
  status: "confirmation" | "completed",
  confirmationId: string | null,
  responseText: string,
  now: number,
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE chat_request_idempotency
     SET status = ?3, confirmation_id = ?4, response_text = ?5, updated_at = ?6
     WHERE user_id = ?1 AND client_request_id = ?2`,
  )
    .bind(userId, clientRequestId, status, confirmationId, responseText, now)
    .run();
  return (result.meta?.changes ?? 0) === 1;
}

export async function releaseChatRequestIdempotency(
  env: Env,
  userId: string,
  clientRequestId: string,
): Promise<void> {
  await env.DB.prepare(
    "DELETE FROM chat_request_idempotency WHERE user_id = ?1 AND client_request_id = ?2 AND status = 'processing'",
  )
    .bind(userId, clientRequestId)
    .run();
}

// --- paper authorizations ---

export async function authorizePapers(
  env: Env,
  sessionId: string,
  papers: Array<{ ref: string; source: string; title?: string }>
): Promise<void> {
  if (papers.length === 0) return;
  const ts = nowSeconds();
  const stmts = papers.map((p) =>
    env.DB.prepare(
      `INSERT INTO paper_authorizations (session_id, ref, source, title, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(session_id, ref) DO NOTHING`
    ).bind(sessionId, p.ref, p.source, p.title ?? null, ts)
  );
  await env.DB.batch(stmts);
}

export async function isPaperAuthorized(env: Env, sessionId: string, ref: string): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT 1 AS ok FROM paper_authorizations WHERE session_id = ?1 AND ref = ?2"
  )
    .bind(sessionId, ref)
    .first<{ ok: number }>();
  return Boolean(row);
}

// --- paper cache ---

export async function cacheGet(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT data, expires_at FROM paper_cache WHERE cache_key = ?1"
  )
    .bind(key)
    .first<{ data: string; expires_at: number }>();
  if (!row) return null;
  if (row.expires_at <= nowSeconds()) return null;
  return row.data;
}

export async function cacheSet(env: Env, key: string, data: string, ttlSeconds: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO paper_cache (cache_key, data, expires_at) VALUES (?1, ?2, ?3)
     ON CONFLICT(cache_key) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at`
  )
    .bind(key, data, nowSeconds() + ttlSeconds)
    .run();
}

// --- daily quota ---

/**
 * Atomically increment the user's daily counter and return the new count.
 * A single UPSERT keeps this race-free within D1.
 */
export async function incrementDailyUsage(env: Env, userId: string, day: string): Promise<number> {
  const res = await env.DB.prepare(
    `INSERT INTO daily_usage (user_id, day, count) VALUES (?1, ?2, 1)
     ON CONFLICT(user_id, day) DO UPDATE SET count = count + 1
     RETURNING count`
  )
    .bind(userId, day)
    .first<{ count: number }>();
  return Number(res?.count ?? 0);
}

export async function decrementDailyUsage(env: Env, userId: string, day: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE daily_usage SET count = MAX(count - 1, 0) WHERE user_id = ?1 AND day = ?2"
  )
    .bind(userId, day)
    .run();
}

export async function getDailyUsage(env: Env, userId: string, day: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT count FROM daily_usage WHERE user_id = ?1 AND day = ?2"
  )
    .bind(userId, day)
    .first<{ count: number }>();
  return Number(row?.count ?? 0);
}
