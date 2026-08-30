import type { Env } from "./env";
import { nowSeconds } from "./http";
import { decryptAuthToken, encryptAuthToken, isEncryptedAuthToken } from "./auth-token-crypto";

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
  refresh_owner: string | null;
  refresh_started_at: number | null;
  token_version: number;
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

export type ChatEventType =
  | "user_message"
  | "assistant_message"
  | "tool_call"
  | "tool_result"
  | "system_status"
  | "error";

export type ChatEventRole = "user" | "assistant" | "tool" | "system";

export interface ChatEventRow {
  event_id: number;
  session_id: string;
  turn_id: string;
  event_type: ChatEventType;
  role: ChatEventRole;
  content: string | null;
  tool_call_id: string | null;
  tool_name: string | null;
  tool_arguments_json: string | null;
  result_summary: string | null;
  result_object_key: string | null;
  result_sha256: string | null;
  result_bytes: number | null;
  status: string | null;
  created_at: number;
}

export interface ChatEventInput {
  session_id: string;
  turn_id: string;
  event_type: ChatEventType;
  role: ChatEventRole;
  content?: string | null;
  tool_call_id?: string | null;
  tool_name?: string | null;
  tool_arguments_json?: string | null;
  result_summary?: string | null;
  result_object_key?: string | null;
  result_sha256?: string | null;
  result_bytes?: number | null;
  status?: string | null;
  created_at: number;
}

export type PaperSourceKind = "arxiv" | "pubmed_pmc" | "user_upload" | "approved_url";
export type PaperResourceStatus = "requested" | "downloading" | "extracting" | "uploading" | "ready" | "failed" | "deleted" | "cancelled";
export type PaperProcessingAttemptStatus = "queued" | "claimed" | "downloading" | "extracting" | "uploading" | "succeeded" | "failed" | "expired" | "cancelled";
export type PaperResourcePurpose = "search_result" | "read" | "upload";

export interface PaperResourceRow {
  resource_id: string;
  session_id: string;
  user_id: string;
  source_kind: PaperSourceKind;
  source_ref: string;
  canonical_ref: string | null;
  title: string | null;
  status: PaperResourceStatus;
  source_sha256: string | null;
  pdf_object_key: string | null;
  pdf_size_bytes: number | null;
  pdf_sha256: string | null;
  text_manifest_key: string | null;
  image_manifest_key: string | null;
  page_count: number | null;
  image_count: number | null;
  error_code: string | null;
  error_message_safe: string | null;
  created_at: number;
  updated_at: number;
  ready_at: number | null;
}

export interface PaperProcessingAttemptRow {
  attempt_id: string;
  resource_id: string;
  processor_id: string;
  lease_token_hash: string;
  fencing_epoch: number;
  status: PaperProcessingAttemptStatus;
  started_at: number | null;
  lease_expires_at: number;
  finished_at: number | null;
  error_code: string | null;
  error_message_safe: string | null;
}

export interface PaperResourceLinkRow {
  session_id: string;
  resource_id: string;
  purpose: PaperResourcePurpose;
  created_at: number;
}

export type PaperRequestContinuationStatus = "waiting" | "ready" | "running" | "completed" | "failed" | "cancelled" | "expired";

export interface PaperRequestContinuationRow {
  continuation_id: string;
  session_id: string;
  user_id: string;
  turn_id: string;
  client_request_id: string | null;
  resource_id: string;
  status: PaperRequestContinuationStatus;
  active_turn_id: string | null;
  lease_expires_at: number | null;
  expires_at: number;
  last_error_code: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

export interface OwnedPaperRequestContinuation extends PaperRequestContinuationRow {
  resource_status: PaperResourceStatus;
}

export const PAPER_CONTINUATION_TTL_SECONDS = 24 * 60 * 60;
export const PAPER_CONTINUATION_LEASE_SECONDS = 5 * 60;

export interface PaperProcessorSessionRow {
  processor_session_id: string;
  processor_id: string;
  instance_id: string;
  session_token_hash: string;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  revoked_at: number | null;
}

export interface PaperProcessorAttemptContext {
  attempt: PaperProcessingAttemptRow;
  resource: Pick<PaperResourceRow, "resource_id" | "source_kind" | "source_ref" | "canonical_ref" | "title" | "status" | "pdf_object_key" | "text_manifest_key">;
}

export interface PaperProcessorObjectRow {
  resource_id: string;
  attempt_id: string;
  kind: "text_pages" | "image";
  object_id: string;
  size_bytes: number;
  sha256: string;
  content_type: string;
  created_at: number;
}

export interface PaperResourceAuditEventRow {
  event_id: string;
  resource_id: string;
  attempt_id: string | null;
  stage: "materialize" | "download" | "extraction" | "upload" | "image_analysis" | "cancel" | "delete" | "cleanup";
  outcome: "started" | "succeeded" | "failed" | "denied" | "cancelled";
  error_code: string | null;
  metadata_json: string;
  created_at: number;
}

export type PaperResourceProgressAuditEventRow = Pick<PaperResourceAuditEventRow, "event_id" | "resource_id" | "attempt_id" | "stage" | "outcome" | "error_code" | "created_at">;

export interface PaperResourceProgressSnapshot {
  resource: PaperResourceRow;
  continuations: OwnedPaperRequestContinuation[];
  auditEvents: PaperResourceProgressAuditEventRow[];
}

export interface PaperCleanupJobRow {
  cleanup_id: string;
  resource_id: string;
  status: "pending" | "running" | "completed" | "failed";
  attempts: number;
  next_attempt_at: number;
  last_error_code: string | null;
  created_at: number;
  updated_at: number;
}

const PAPER_RESOURCE_TRANSITIONS: Record<PaperResourceStatus, PaperResourceStatus[]> = {
  requested: ["downloading", "failed", "cancelled"],
  downloading: ["extracting", "failed", "cancelled"],
  extracting: ["uploading", "failed", "cancelled"],
  uploading: ["ready", "failed", "cancelled"],
  ready: ["deleted"],
  failed: ["requested", "deleted"],
  deleted: [],
  cancelled: ["requested", "deleted"],
};

/** Maximum inline D1 result summary; larger tool results need an object ref. */
export const MAX_INLINE_TOOL_RESULT_BYTES = 4 * 1024;
const MAX_EVENT_CONTENT_BYTES = 32 * 1024;
const MAX_TOOL_ARGUMENTS_BYTES = 16 * 1024;
const MAX_OBJECT_KEY_BYTES = 512;
const MAX_TOOL_CALL_ID_BYTES = 255;
const MAX_TOOL_NAME_BYTES = 128;

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function validateBoundedEventText(name: string, value: string | null | undefined, maxBytes: number): void {
  if (value == null) return;
  if (typeof value !== "string" || byteLength(value) > maxBytes) {
    throw new Error(`${name} exceeds its maximum size`);
  }
}

function validateChatEvent(input: ChatEventInput): void {
  const expectedRoles: Record<ChatEventType, ChatEventRole> = {
    user_message: "user",
    assistant_message: "assistant",
    tool_call: "assistant",
    tool_result: "tool",
    system_status: "system",
    error: "system",
  };
  if (!(input.event_type in expectedRoles)) throw new Error("Invalid chat event type");
  if (input.role !== expectedRoles[input.event_type]) throw new Error("Invalid chat event role");
  if (!input.session_id || !input.turn_id || byteLength(input.turn_id) > 255) {
    throw new Error("Invalid chat event identity");
  }
  validateBoundedEventText("content", input.content, MAX_EVENT_CONTENT_BYTES);
  validateBoundedEventText("tool_call_id", input.tool_call_id, MAX_TOOL_CALL_ID_BYTES);
  validateBoundedEventText("tool_name", input.tool_name, MAX_TOOL_NAME_BYTES);
  validateBoundedEventText("tool_arguments_json", input.tool_arguments_json, MAX_TOOL_ARGUMENTS_BYTES);
  if (input.result_summary != null && byteLength(input.result_summary) > MAX_INLINE_TOOL_RESULT_BYTES) {
    throw new Error("Inline tool result exceeds the maximum size; use a result object reference");
  }
  validateBoundedEventText("result_summary", input.result_summary, MAX_INLINE_TOOL_RESULT_BYTES);
  validateBoundedEventText("result_object_key", input.result_object_key, MAX_OBJECT_KEY_BYTES);
  if (input.result_sha256 != null && !/^[0-9a-fA-F]{64}$/.test(input.result_sha256)) {
    throw new Error("Invalid result SHA-256");
  }
  if (input.result_bytes != null && (!Number.isSafeInteger(input.result_bytes) || input.result_bytes < 0 || input.result_bytes > 2_147_483_648)) {
    throw new Error("Invalid result byte count");
  }
  if (input.event_type === "tool_call" && (!input.tool_call_id || !input.tool_name)) {
    throw new Error("Tool call requires an ID and name");
  }
  if (input.event_type === "tool_result" && !input.tool_call_id) {
    throw new Error("Tool result requires a call ID");
  }
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

export async function insertAuthSession(
  env: Env,
  row: Omit<AuthSessionRow, "revoked_at" | "refresh_owner" | "refresh_started_at" | "token_version">,
): Promise<void> {
  const [accessToken, refreshToken] = await Promise.all([
    encryptAuthToken(row.access_token, env, row.sid, "access"),
    encryptAuthToken(row.refresh_token, env, row.sid, "refresh"),
  ]);
  await env.DB.prepare(
    `INSERT INTO auth_sessions (sid, user_id, email, access_token, access_expires_at, refresh_token, created_at, last_used_at, revoked_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL)`
  )
    .bind(row.sid, row.user_id, row.email, accessToken, row.access_expires_at, refreshToken, row.created_at, row.last_used_at)
    .run();
}

export async function getAuthSession(env: Env, sid: string): Promise<AuthSessionRow | null> {
  const row = await env.DB.prepare("SELECT * FROM auth_sessions WHERE sid = ?1 AND revoked_at IS NULL").bind(sid).first<AuthSessionRow>();
  if (!row) return null;
  const legacyAccess = !isEncryptedAuthToken(row.access_token);
  const legacyRefresh = !isEncryptedAuthToken(row.refresh_token);
  const [accessToken, refreshToken] = await Promise.all([
    decryptAuthToken(row.access_token, env, sid, "access"),
    decryptAuthToken(row.refresh_token, env, sid, "refresh"),
  ]);
  if (legacyAccess || legacyRefresh) {
    const [encryptedAccess, encryptedRefresh] = await Promise.all([
      encryptAuthToken(accessToken, env, sid, "access"),
      encryptAuthToken(refreshToken, env, sid, "refresh"),
    ]);
    await env.DB.prepare(
      `UPDATE auth_sessions SET access_token = ?2, refresh_token = ?3
       WHERE sid = ?1 AND revoked_at IS NULL
         AND access_token = ?4 AND refresh_token = ?5`,
    ).bind(sid, encryptedAccess, encryptedRefresh, row.access_token, row.refresh_token).run();
  }
  return { ...row, access_token: accessToken, refresh_token: refreshToken };
}

export async function updateAuthSessionTokens(
  env: Env,
  sid: string,
  accessToken: string,
  accessExpiresAt: number,
  refreshToken: string,
  refreshOwner: string,
): Promise<boolean> {
  const [encryptedAccessToken, encryptedRefreshToken] = await Promise.all([
    encryptAuthToken(accessToken, env, sid, "access"),
    encryptAuthToken(refreshToken, env, sid, "refresh"),
  ]);
  const result = await env.DB.prepare(
    `UPDATE auth_sessions
     SET access_token = ?2, access_expires_at = ?3, refresh_token = ?4,
         last_used_at = ?5, refresh_owner = NULL, refresh_started_at = NULL,
         token_version = token_version + 1
     WHERE sid = ?1 AND revoked_at IS NULL AND refresh_owner = ?6`
  )
    .bind(sid, encryptedAccessToken, accessExpiresAt, encryptedRefreshToken, nowSeconds(), refreshOwner)
    .run();
  return Number(result.meta.changes ?? 0) === 1;
}

export async function claimAuthSessionRefresh(
  env: Env,
  sid: string,
  owner: string,
  startedAt: number,
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE auth_sessions SET refresh_owner = ?2, refresh_started_at = ?3
     WHERE sid = ?1 AND revoked_at IS NULL
       AND (refresh_owner IS NULL OR refresh_started_at <= ?4)`,
  ).bind(sid, owner, startedAt, startedAt - 120).run();
  return Number(result.meta.changes ?? 0) === 1;
}

export async function releaseAuthSessionRefresh(env: Env, sid: string, owner: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE auth_sessions SET refresh_owner = NULL, refresh_started_at = NULL
     WHERE sid = ?1 AND revoked_at IS NULL AND refresh_owner = ?2`,
  ).bind(sid, owner).run();
}

export async function revokeAuthSessionRefreshOwner(env: Env, sid: string, owner: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE auth_sessions
     SET revoked_at = ?3, access_token = '', refresh_token = '',
         refresh_owner = NULL, refresh_started_at = NULL
     WHERE sid = ?1 AND revoked_at IS NULL AND refresh_owner = ?2`,
  ).bind(sid, owner, nowSeconds()).run();
}

export async function revokeAuthSession(env: Env, sid: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE auth_sessions SET revoked_at = ?2, access_token = '', refresh_token = '',
       refresh_owner = NULL, refresh_started_at = NULL WHERE sid = ?1`,
  ).bind(sid, nowSeconds()).run();
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
    env.DB.prepare("DELETE FROM chat_events WHERE session_id = ?1").bind(id),
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

/** Compatibility read for legacy text-only history until PAPER-03 cutover. */
export async function listLegacyMessages(env: Env, sessionId: string): Promise<ChatMessageRow[]> {
  return listMessages(env, sessionId);
}

export async function insertMessage(env: Env, sessionId: string, role: string, content: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO chat_messages (session_id, role, content, created_at) VALUES (?1, ?2, ?3, ?4)"
  )
    .bind(sessionId, role, content, nowSeconds())
    .run();
}

/**
 * Insert one validated canonical event. D1's foreign key and partial unique
 * index remain the final guards for session ownership and duplicate calls.
 */
export async function insertChatEvent(env: Env, input: ChatEventInput): Promise<void> {
  validateChatEvent(input);
  const session = await env.DB.prepare(
    "SELECT 1 AS ok FROM chat_sessions WHERE id = ?1",
  ).bind(input.session_id).first<{ ok: number }>();
  if (!session) throw new Error("Chat session not found");

  if (input.event_type === "tool_result") {
    const call = await getChatToolCall(env, input.session_id, input.tool_call_id as string);
    if (!call) throw new Error("Tool call not found for session");
  }

  const insertSql = input.event_type === "tool_result"
    ? `INSERT INTO chat_events
         (session_id, turn_id, event_type, role, content, tool_call_id, tool_name,
          tool_arguments_json, result_summary, result_object_key, result_sha256,
          result_bytes, status, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14
       WHERE NOT EXISTS (
         SELECT 1 FROM chat_events
         WHERE session_id = ?1 AND event_type = 'tool_result' AND tool_call_id = ?6
       )`
    : `INSERT INTO chat_events
       (session_id, turn_id, event_type, role, content, tool_call_id, tool_name,
        tool_arguments_json, result_summary, result_object_key, result_sha256,
        result_bytes, status, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`;
  await env.DB.prepare(insertSql).bind(
    input.session_id,
    input.turn_id,
    input.event_type,
    input.role,
    input.content ?? null,
    input.tool_call_id ?? null,
    input.tool_name ?? null,
    input.tool_arguments_json ?? null,
    input.result_summary ?? null,
    input.result_object_key ?? null,
    input.result_sha256 ?? null,
    input.result_bytes ?? null,
    input.status ?? null,
    input.created_at,
  ).run();
}

/** Read canonical events in D1 insertion order for later replay. */
export async function listChatEvents(env: Env, sessionId: string): Promise<ChatEventRow[]> {
  const res = await env.DB.prepare(
    `SELECT event_id, session_id, turn_id, event_type, role, content,
            tool_call_id, tool_name, tool_arguments_json, result_summary,
            result_object_key, result_sha256, result_bytes, status, created_at
     FROM chat_events
     WHERE session_id = ?1
     ORDER BY event_id ASC`,
  ).bind(sessionId).all<ChatEventRow>();
  return res.results ?? [];
}

export async function getChatToolCall(
  env: Env,
  sessionId: string,
  toolCallId: string,
): Promise<Pick<ChatEventRow, "event_id" | "turn_id" | "tool_call_id" | "tool_name" | "tool_arguments_json"> | null> {
  return env.DB.prepare(
    `SELECT event_id, turn_id, tool_call_id, tool_name, tool_arguments_json
     FROM chat_events
     WHERE session_id = ?1 AND event_type = 'tool_call' AND tool_call_id = ?2
     ORDER BY event_id ASC LIMIT 1`,
  ).bind(sessionId, toolCallId).first<Pick<ChatEventRow, "event_id" | "turn_id" | "tool_call_id" | "tool_name" | "tool_arguments_json">>();
}

// --- paper resources ---

export async function createPaperResource(
  env: Env,
  row: Omit<PaperResourceRow, "status" | "source_sha256" | "pdf_object_key" | "pdf_size_bytes" | "pdf_sha256" | "text_manifest_key" | "image_manifest_key" | "page_count" | "image_count" | "error_code" | "error_message_safe" | "ready_at" | "created_at" | "updated_at">,
): Promise<PaperResourceRow> {
  if (!row.resource_id || !row.session_id || !row.user_id || !row.source_ref || !row.source_kind) {
    throw new Error("Invalid paper resource identity");
  }
  if (row.source_ref.length > 512 || (row.canonical_ref?.length ?? 0) > 512 || (row.title?.length ?? 0) > 255) {
    throw new Error("Paper resource metadata exceeds its maximum size");
  }
  const createdAt = nowSeconds();
  const resource: PaperResourceRow = {
    ...row,
    status: "requested",
    source_sha256: null,
    pdf_object_key: null,
    pdf_size_bytes: null,
    pdf_sha256: null,
    text_manifest_key: null,
    image_manifest_key: null,
    page_count: null,
    image_count: null,
    error_code: null,
    error_message_safe: null,
    created_at: createdAt,
    updated_at: createdAt,
    ready_at: null,
  };
  await env.DB.prepare(
    `INSERT INTO paper_resources
       (resource_id, session_id, user_id, source_kind, source_ref, canonical_ref, title,
        status, source_sha256, pdf_object_key, pdf_size_bytes, pdf_sha256,
        text_manifest_key, image_manifest_key, page_count, image_count, error_code,
        error_message_safe, created_at, updated_at, ready_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)`,
  ).bind(
    resource.resource_id, resource.session_id, resource.user_id, resource.source_kind, resource.source_ref,
    resource.canonical_ref, resource.title, resource.status, resource.source_sha256, resource.pdf_object_key,
    resource.pdf_size_bytes, resource.pdf_sha256, resource.text_manifest_key, resource.image_manifest_key,
    resource.page_count, resource.image_count, resource.error_code, resource.error_message_safe,
    resource.created_at, resource.updated_at, resource.ready_at,
  ).run();
  return resource;
}

async function getPaperResourceForSessionOwner(
  env: Env,
  resourceId: string,
  sessionId: string,
  userId: string,
): Promise<{ resource_id: string } | null> {
  return env.DB.prepare(
    `SELECT r.resource_id
       FROM paper_resources r
       JOIN chat_sessions s ON s.id = r.session_id
      WHERE r.resource_id = ?1 AND r.session_id = ?2 AND r.user_id = ?3 AND s.user_id = ?3`,
  ).bind(resourceId, sessionId, userId).first<{ resource_id: string }>();
}

export async function linkPaperResource(
  env: Env,
  sessionId: string,
  resourceId: string,
  userId: string,
  purpose: PaperResourcePurpose,
): Promise<boolean> {
  if (!(purpose === "search_result" || purpose === "read" || purpose === "upload")) {
    throw new Error("Invalid paper resource link purpose");
  }
  const owned = await getPaperResourceForSessionOwner(env, resourceId, sessionId, userId);
  if (!owned) return false;
  const result = await env.DB.prepare(
    `INSERT INTO paper_resource_links (session_id, resource_id, purpose, created_at)
     VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(session_id, resource_id, purpose) DO NOTHING`,
  ).bind(sessionId, resourceId, purpose, nowSeconds()).run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function revokePaperResourceLink(
  env: Env,
  sessionId: string,
  resourceId: string,
  userId: string,
): Promise<boolean> {
  const result = await env.DB.prepare(
    `DELETE FROM paper_resource_links
      WHERE session_id = ?1 AND resource_id = ?2
        AND EXISTS (
          SELECT 1 FROM paper_resources r
          JOIN chat_sessions s ON s.id = r.session_id
          WHERE r.resource_id = ?2 AND r.session_id = ?1 AND r.user_id = ?3 AND s.user_id = ?3
        )`,
  ).bind(sessionId, resourceId, userId).run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function getOwnedPaperResource(
  env: Env,
  resourceId: string,
  sessionId: string,
  userId: string,
): Promise<PaperResourceRow | null> {
  return env.DB.prepare(
    `SELECT r.*
       FROM paper_resources r
       JOIN chat_sessions s ON s.id = r.session_id
       JOIN paper_resource_links l ON l.resource_id = r.resource_id AND l.session_id = r.session_id
      WHERE r.resource_id = ?1 AND r.session_id = ?2 AND r.user_id = ?3 AND s.user_id = ?3
      LIMIT 1`,
  ).bind(resourceId, sessionId, userId).first<PaperResourceRow>();
}

export async function findOwnedPaperResourceBySource(
  env: Env,
  input: { sessionId: string; userId: string; sourceKind: PaperSourceKind; sourceRef: string },
): Promise<PaperResourceRow | null> {
  return env.DB.prepare(
    `SELECT r.*
       FROM paper_resources r
       JOIN chat_sessions s ON s.id = r.session_id
       JOIN paper_resource_links l ON l.resource_id = r.resource_id AND l.session_id = r.session_id
      WHERE r.session_id = ?1 AND r.user_id = ?2 AND s.user_id = ?2
        AND r.source_kind = ?3 AND r.source_ref = ?4
      ORDER BY r.updated_at DESC, r.created_at DESC
      LIMIT 1`,
  ).bind(input.sessionId, input.userId, input.sourceKind, input.sourceRef).first<PaperResourceRow>();
}

function initialPaperContinuationStatus(status: PaperResourceStatus): PaperRequestContinuationStatus {
  if (status === "ready") return "ready";
  if (status === "failed") return "failed";
  if (status === "cancelled" || status === "deleted") return "cancelled";
  return "waiting";
}

export async function createPaperRequestContinuation(
  env: Env,
  input: {
    continuationId: string;
    sessionId: string;
    userId: string;
    turnId: string;
    clientRequestId?: string | null;
    resource: Pick<PaperResourceRow, "resource_id" | "status">;
    now?: number;
  },
): Promise<PaperRequestContinuationRow> {
  if (!input.continuationId || !input.sessionId || !input.userId || !input.resource.resource_id
    || !input.turnId || input.turnId.length > 255
    || (input.clientRequestId != null && (input.clientRequestId.length < 1 || input.clientRequestId.length > 255))) {
    throw new Error("Invalid paper continuation identity");
  }
  const ownedResource = await getOwnedPaperResource(env, input.resource.resource_id, input.sessionId, input.userId);
  if (!ownedResource) throw new Error("Paper continuation resource is not owned");
  const createdAt = input.now ?? nowSeconds();
  const expiresAt = createdAt + PAPER_CONTINUATION_TTL_SECONDS;
  await env.DB.prepare(
    `INSERT INTO paper_request_continuations
       (continuation_id, session_id, user_id, turn_id, client_request_id, resource_id,
        status, active_turn_id, lease_expires_at, expires_at, last_error_code,
        created_at, updated_at, completed_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, NULL, ?8, NULL, ?9, ?9, NULL)
     ON CONFLICT(session_id, turn_id, resource_id) DO NOTHING`,
  ).bind(
    input.continuationId,
    input.sessionId,
    input.userId,
    input.turnId,
    input.clientRequestId ?? null,
    input.resource.resource_id,
    initialPaperContinuationStatus(ownedResource.status),
    expiresAt,
    createdAt,
  ).run();
  const inserted = await env.DB.prepare(
    `SELECT continuation_id, session_id, user_id, turn_id, client_request_id,
            resource_id, status, active_turn_id, lease_expires_at, expires_at,
            last_error_code, created_at, updated_at, completed_at
       FROM paper_request_continuations
      WHERE continuation_id = ?1`,
  ).bind(input.continuationId).first<PaperRequestContinuationRow>();
  if (inserted) return inserted;
  const existing = await env.DB.prepare(
    `SELECT continuation_id, session_id, user_id, turn_id, client_request_id,
            resource_id, status, active_turn_id, lease_expires_at, expires_at,
            last_error_code, created_at, updated_at, completed_at
       FROM paper_request_continuations
      WHERE session_id = ?1 AND turn_id = ?2 AND resource_id = ?3`,
  ).bind(input.sessionId, input.turnId, input.resource.resource_id).first<PaperRequestContinuationRow>();
  if (!existing) throw new Error("Paper continuation could not be persisted");
  return existing;
}

export async function getOwnedPaperRequestContinuation(
  env: Env,
  continuationId: string,
  sessionId: string,
  userId: string,
): Promise<OwnedPaperRequestContinuation | null> {
  return env.DB.prepare(
    `SELECT c.continuation_id, c.session_id, c.user_id, c.turn_id,
            c.client_request_id, c.resource_id, c.status, c.active_turn_id,
            c.lease_expires_at, c.expires_at, c.last_error_code, c.created_at,
            c.updated_at, c.completed_at, r.status AS resource_status
       FROM paper_request_continuations c
       JOIN paper_resources r ON r.resource_id = c.resource_id
       JOIN chat_sessions s ON s.id = c.session_id
      WHERE c.continuation_id = ?1 AND c.session_id = ?2 AND c.user_id = ?3
        AND r.session_id = c.session_id AND r.user_id = c.user_id
        AND s.user_id = c.user_id
      LIMIT 1`,
  ).bind(continuationId, sessionId, userId).first<OwnedPaperRequestContinuation>();
}

export async function listOwnedPaperRequestContinuationsForTurn(
  env: Env,
  sessionId: string,
  userId: string,
  turnId: string,
): Promise<OwnedPaperRequestContinuation[]> {
  const result = await env.DB.prepare(
    `SELECT c.continuation_id, c.session_id, c.user_id, c.turn_id,
            c.client_request_id, c.resource_id, c.status, c.active_turn_id,
            c.lease_expires_at, c.expires_at, c.last_error_code, c.created_at,
            c.updated_at, c.completed_at, r.status AS resource_status
       FROM paper_request_continuations c
       JOIN paper_resources r ON r.resource_id = c.resource_id
       JOIN chat_sessions s ON s.id = c.session_id
      WHERE c.session_id = ?1 AND c.user_id = ?2 AND c.turn_id = ?3
        AND r.session_id = c.session_id AND r.user_id = c.user_id
        AND s.user_id = c.user_id
      ORDER BY c.created_at ASC, c.continuation_id ASC`,
  ).bind(sessionId, userId, turnId).all<OwnedPaperRequestContinuation>();
  return result.results ?? [];
}

async function listOwnedPaperRequestContinuationsForResource(
  env: Env,
  input: { resourceId: string; sessionId: string; userId: string; limit?: number },
): Promise<OwnedPaperRequestContinuation[]> {
  const limit = Math.max(1, Math.min(input.limit ?? 20, 20));
  const result = await env.DB.prepare(
    `SELECT c.continuation_id, c.session_id, c.user_id, c.turn_id,
            c.client_request_id, c.resource_id, c.status, c.active_turn_id,
            c.lease_expires_at, c.expires_at, c.last_error_code, c.created_at,
            c.updated_at, c.completed_at, r.status AS resource_status
       FROM paper_request_continuations c
       JOIN paper_resources r ON r.resource_id = c.resource_id
       JOIN chat_sessions s ON s.id = c.session_id
      WHERE c.resource_id = ?1 AND c.session_id = ?2 AND c.user_id = ?3
        AND r.session_id = c.session_id AND r.user_id = c.user_id
        AND s.user_id = c.user_id
      ORDER BY c.updated_at DESC, c.continuation_id ASC
      LIMIT ?4`,
  ).bind(input.resourceId, input.sessionId, input.userId, limit).all<OwnedPaperRequestContinuation>();
  return result.results ?? [];
}

async function listPaperResourceProgressAuditEvents(
  env: Env,
  input: { resourceId: string; sessionId: string; userId: string },
  limit = 50,
): Promise<PaperResourceProgressAuditEventRow[]> {
  const boundedLimit = Math.max(1, Math.min(limit, 50));
  const result = await env.DB.prepare(
    `SELECT e.event_id, e.resource_id, e.attempt_id, e.stage, e.outcome, e.error_code, e.created_at
       FROM paper_resource_audit_events e
       JOIN paper_resources r ON r.resource_id = e.resource_id
       JOIN chat_sessions s ON s.id = r.session_id
       JOIN paper_resource_links l ON l.resource_id = r.resource_id AND l.session_id = r.session_id
      WHERE e.resource_id = ?1 AND r.session_id = ?2 AND r.user_id = ?3
        AND s.user_id = ?3
      ORDER BY e.created_at ASC, e.event_id ASC
      LIMIT ?4`,
  ).bind(input.resourceId, input.sessionId, input.userId, boundedLimit).all<PaperResourceProgressAuditEventRow>();
  return result.results ?? [];
}

/**
 * Read one owner-scoped, bounded progress snapshot. The API projection built
 * from this value must never expose the resource object keys or audit payload.
 */
export async function getOwnedPaperResourceProgress(
  env: Env,
  resourceId: string,
  sessionId: string,
  userId: string,
): Promise<PaperResourceProgressSnapshot | null> {
  const resource = await getOwnedPaperResource(env, resourceId, sessionId, userId);
  if (!resource) return null;
  const [continuations, auditEvents] = await Promise.all([
    listOwnedPaperRequestContinuationsForResource(env, { resourceId, sessionId, userId }),
    listPaperResourceProgressAuditEvents(env, { resourceId, sessionId, userId }),
  ]);
  return { resource, continuations, auditEvents };
}

/** Synchronize a durable continuation with the resource lifecycle before serving it. */
export async function syncPaperRequestContinuation(
  env: Env,
  input: { continuationId: string; sessionId: string; userId: string; now?: number },
): Promise<OwnedPaperRequestContinuation | null> {
  const now = input.now ?? nowSeconds();
  await env.DB.prepare(
    `UPDATE paper_request_continuations
        SET status = CASE
          WHEN expires_at <= ?4 AND status NOT IN ('completed', 'cancelled', 'expired') THEN 'expired'
          WHEN (SELECT status FROM paper_resources WHERE resource_id = paper_request_continuations.resource_id) = 'ready' AND status = 'waiting' THEN 'ready'
          WHEN (SELECT status FROM paper_resources WHERE resource_id = paper_request_continuations.resource_id) = 'failed' AND status IN ('waiting', 'ready', 'running') THEN 'failed'
          WHEN (SELECT status FROM paper_resources WHERE resource_id = paper_request_continuations.resource_id) IN ('cancelled', 'deleted') AND status IN ('waiting', 'ready', 'running') THEN 'cancelled'
          ELSE status END,
            last_error_code = CASE
          WHEN (SELECT status FROM paper_resources WHERE resource_id = paper_request_continuations.resource_id) = 'failed' AND status IN ('waiting', 'ready', 'running') THEN COALESCE((SELECT error_code FROM paper_resources WHERE resource_id = paper_request_continuations.resource_id), 'PAPER_RESOURCE_FAILED')
          ELSE last_error_code END,
            active_turn_id = CASE
          WHEN expires_at <= ?4 OR (SELECT status FROM paper_resources WHERE resource_id = paper_request_continuations.resource_id) IN ('failed', 'cancelled', 'deleted') THEN NULL
          ELSE active_turn_id END,
            lease_expires_at = CASE
          WHEN expires_at <= ?4 OR (SELECT status FROM paper_resources WHERE resource_id = paper_request_continuations.resource_id) IN ('failed', 'cancelled', 'deleted') THEN NULL
          ELSE lease_expires_at END,
            updated_at = ?4
      WHERE paper_request_continuations.continuation_id = ?1
        AND paper_request_continuations.session_id = ?2
        AND paper_request_continuations.user_id = ?3
        AND EXISTS (SELECT 1 FROM paper_resources WHERE paper_resources.resource_id = paper_request_continuations.resource_id)`,
  ).bind(input.continuationId, input.sessionId, input.userId, now).run();
  return getOwnedPaperRequestContinuation(env, input.continuationId, input.sessionId, input.userId);
}

export async function claimPaperRequestContinuation(
  env: Env,
  input: { continuationId: string; sessionId: string; userId: string; runTurnId: string; now?: number; leaseExpiresAt?: number },
): Promise<OwnedPaperRequestContinuation | null> {
  const now = input.now ?? nowSeconds();
  const leaseExpiresAt = input.leaseExpiresAt ?? now + PAPER_CONTINUATION_LEASE_SECONDS;
  if (!input.runTurnId || input.runTurnId.length > 255 || leaseExpiresAt <= now) return null;
  const result = await env.DB.prepare(
    `UPDATE paper_request_continuations
        SET status = 'running', active_turn_id = ?4,
            lease_expires_at = ?5, updated_at = ?6
      WHERE continuation_id = ?1 AND session_id = ?2 AND user_id = ?3
        AND expires_at > ?6
        AND EXISTS (
          SELECT 1 FROM paper_resources r
           WHERE r.resource_id = paper_request_continuations.resource_id
             AND r.session_id = ?2 AND r.user_id = ?3 AND r.status = 'ready'
        )
        AND (status = 'ready' OR (status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?6))`,
  ).bind(input.continuationId, input.sessionId, input.userId, input.runTurnId, leaseExpiresAt, now).run();
  if ((result.meta?.changes ?? 0) !== 1) return null;
  return getOwnedPaperRequestContinuation(env, input.continuationId, input.sessionId, input.userId);
}

export async function releasePaperRequestContinuation(
  env: Env,
  input: { continuationId: string; sessionId: string; userId: string; runTurnId: string; errorCode?: string | null; now?: number },
): Promise<boolean> {
  const now = input.now ?? nowSeconds();
  const errorCode = input.errorCode ?? null;
  if (errorCode != null && !/^[A-Z0-9_]{1,64}$/.test(errorCode)) return false;
  const result = await env.DB.prepare(
    `UPDATE paper_request_continuations
        SET status = CASE
              WHEN expires_at <= ?4 THEN 'expired'
              WHEN (SELECT status FROM paper_resources WHERE resource_id = paper_request_continuations.resource_id) = 'ready' THEN 'ready'
              WHEN (SELECT status FROM paper_resources WHERE resource_id = paper_request_continuations.resource_id) = 'failed' THEN 'failed'
              ELSE 'cancelled' END,
            active_turn_id = NULL, lease_expires_at = NULL,
            last_error_code = CASE
              WHEN (SELECT status FROM paper_resources WHERE resource_id = paper_request_continuations.resource_id) = 'failed'
                THEN COALESCE((SELECT error_code FROM paper_resources WHERE resource_id = paper_request_continuations.resource_id), 'PAPER_RESOURCE_FAILED')
              ELSE ?6 END,
            updated_at = ?4
      WHERE continuation_id = ?1 AND session_id = ?2 AND user_id = ?3
        AND status = 'running' AND active_turn_id = ?5`,
  ).bind(input.continuationId, input.sessionId, input.userId, now, input.runTurnId, errorCode).run();
  return (result.meta?.changes ?? 0) === 1;
}

export async function completePaperRequestContinuation(
  env: Env,
  input: { continuationId: string; sessionId: string; userId: string; runTurnId: string; responseText: string; now?: number },
): Promise<boolean> {
  const current = await getOwnedPaperRequestContinuation(env, input.continuationId, input.sessionId, input.userId);
  if (!current || current.status !== "running" || current.active_turn_id !== input.runTurnId) return false;
  const now = input.now ?? nowSeconds();
  const responseText = input.responseText.slice(0, 32_768);
  const statements = [env.DB.prepare(
    `UPDATE paper_request_continuations
        SET status = 'completed', active_turn_id = NULL, lease_expires_at = NULL,
            completed_at = ?4, updated_at = ?4
      WHERE continuation_id = ?1 AND session_id = ?2 AND user_id = ?3
        AND status = 'running' AND active_turn_id = ?5
        AND expires_at > ?4
        AND EXISTS (
          SELECT 1 FROM paper_resources r
           WHERE r.resource_id = paper_request_continuations.resource_id
             AND r.status = 'ready'
        )`,
  ).bind(input.continuationId, input.sessionId, input.userId, now, input.runTurnId)];
  if (current.client_request_id) {
    statements.push(env.DB.prepare(
      `UPDATE chat_request_idempotency
          SET status = 'completed', confirmation_id = NULL,
              response_text = ?3, updated_at = ?4
        WHERE user_id = ?1 AND client_request_id = ?2 AND status = 'processing'`,
    ).bind(input.userId, current.client_request_id, responseText, now));
  }
  const results = await env.DB.batch(statements);
  return Number((results[0] as { meta?: { changes?: number } } | undefined)?.meta?.changes ?? 0) === 1;
}

export async function recordUserPaperUpload(
  env: Env,
  input: { resourceId: string; sessionId: string; userId: string; sizeBytes: number; sha256: string; now?: number },
): Promise<boolean> {
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes <= 0 || input.sizeBytes > 2_147_483_648 || !/^[0-9a-fA-F]{64}$/.test(input.sha256)) return false;
  const now = input.now ?? nowSeconds();
  const result = await env.DB.prepare(
    `UPDATE paper_resources SET
        pdf_object_key = 'paper/' || resource_id || '/source.pdf',
        pdf_size_bytes = ?4, pdf_sha256 = ?5, source_sha256 = ?5, updated_at = ?6
      WHERE resource_id = ?1 AND session_id = ?2 AND user_id = ?3
        AND source_kind = 'user_upload' AND status = 'requested'`,
  ).bind(input.resourceId, input.sessionId, input.userId, input.sizeBytes, input.sha256, now).run();
  return (result.meta?.changes ?? 0) === 1;
}

export async function recordPaperAuditEvent(
  env: Env,
  input: Omit<PaperResourceAuditEventRow, "event_id"> & { event_id?: string },
): Promise<boolean> {
  if (!input.resource_id || !input.metadata_json || input.metadata_json.length > 4096
    || !/^[A-Z0-9_]{1,64}$/.test(input.error_code ?? "OK")
    || /object[_-]?key|local[_-]?path|authorization|cookie|secret|credential/i.test(input.metadata_json)) return false;
  const result = await env.DB.prepare(
    `INSERT OR IGNORE INTO paper_resource_audit_events
       (event_id, resource_id, attempt_id, stage, outcome, error_code, metadata_json, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  ).bind(
    input.event_id ?? crypto.randomUUID(), input.resource_id, input.attempt_id, input.stage,
    input.outcome, input.error_code, input.metadata_json, input.created_at,
  ).run();
  return (result.meta?.changes ?? 0) === 1;
}

export async function schedulePaperCleanup(env: Env, resourceId: string, now = nowSeconds()): Promise<boolean> {
  if (!resourceId) return false;
  const result = await env.DB.prepare(
    `INSERT INTO paper_cleanup_jobs
       (cleanup_id, resource_id, status, attempts, next_attempt_at, last_error_code, created_at, updated_at)
     VALUES (?1, ?2, 'pending', 0, ?3, NULL, ?3, ?3)
     ON CONFLICT(resource_id) DO UPDATE SET
       status = CASE WHEN paper_cleanup_jobs.status = 'completed' THEN 'completed' ELSE 'pending' END,
       next_attempt_at = CASE WHEN paper_cleanup_jobs.status = 'completed' THEN paper_cleanup_jobs.next_attempt_at ELSE excluded.next_attempt_at END,
       updated_at = excluded.updated_at`,
  ).bind(crypto.randomUUID(), resourceId, now).run();
  return (result.meta?.changes ?? 0) >= 1;
}

export async function listDuePaperCleanupJobs(env: Env, now = nowSeconds(), limit = 10): Promise<PaperCleanupJobRow[]> {
  const result = await env.DB.prepare(
    `SELECT cleanup_id, resource_id, status, attempts, next_attempt_at, last_error_code, created_at, updated_at
       FROM paper_cleanup_jobs
      WHERE status IN ('pending', 'failed') AND next_attempt_at <= ?1
      ORDER BY next_attempt_at ASC, cleanup_id ASC
      LIMIT ?2`,
  ).bind(now, Math.max(1, Math.min(limit, 50))).all<PaperCleanupJobRow>();
  return result.results ?? [];
}

export async function reclaimStalePaperCleanupJobs(env: Env, now = nowSeconds()): Promise<number> {
  const result = await env.DB.prepare(
    `UPDATE paper_cleanup_jobs SET status = 'failed', last_error_code = 'PAPER_CLEANUP_RECLAIMED', next_attempt_at = ?1, updated_at = ?1
      WHERE status = 'running' AND updated_at <= ?1 - 300`,
  ).bind(now).run();
  return Number(result.meta?.changes ?? 0);
}

export async function claimPaperCleanupJob(env: Env, cleanupId: string, now = nowSeconds()): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE paper_cleanup_jobs SET status = 'running', attempts = attempts + 1, updated_at = ?2
      WHERE cleanup_id = ?1 AND status IN ('pending', 'failed') AND next_attempt_at <= ?2 AND attempts < 100`,
  ).bind(cleanupId, now).run();
  return (result.meta?.changes ?? 0) === 1;
}

export async function completePaperCleanupJob(env: Env, cleanupId: string, now = nowSeconds()): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE paper_cleanup_jobs SET status = 'completed', last_error_code = NULL, updated_at = ?2
      WHERE cleanup_id = ?1 AND status = 'running'`,
  ).bind(cleanupId, now).run();
  return (result.meta?.changes ?? 0) === 1;
}

export async function failPaperCleanupJob(env: Env, cleanupId: string, errorCode: string, now = nowSeconds()): Promise<boolean> {
  if (!/^[A-Z0-9_]{1,64}$/.test(errorCode)) return false;
  const result = await env.DB.prepare(
    `UPDATE paper_cleanup_jobs SET status = 'failed', last_error_code = ?2, next_attempt_at = ?3 + MIN(3600, 30 * (attempts + 1)), updated_at = ?3
      WHERE cleanup_id = ?1 AND status = 'running'`,
  ).bind(cleanupId, errorCode, now).run();
  return (result.meta?.changes ?? 0) === 1;
}

export async function cancelPaperResource(
  env: Env,
  input: { resourceId: string; sessionId: string; userId: string; now?: number },
): Promise<boolean> {
  const now = input.now ?? nowSeconds();
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE paper_resources SET status = 'cancelled', updated_at = ?4
       WHERE resource_id = ?1 AND session_id = ?2 AND user_id = ?3
         AND status IN ('requested', 'downloading', 'extracting', 'uploading')`,
    ).bind(input.resourceId, input.sessionId, input.userId, now),
    env.DB.prepare(
      `UPDATE paper_processing_attempts SET status = 'cancelled', finished_at = ?2
       WHERE resource_id = ?1 AND status IN ('claimed', 'downloading', 'extracting', 'uploading')`,
    ).bind(input.resourceId, now),
    env.DB.prepare(
      `UPDATE paper_request_continuations
          SET status = 'cancelled', active_turn_id = NULL,
              lease_expires_at = NULL, updated_at = ?2
        WHERE resource_id = ?1 AND status IN ('waiting', 'ready', 'running')`,
    ).bind(input.resourceId, now),
  ]);
  return Number((results[0] as { meta?: { changes?: number } } | undefined)?.meta?.changes ?? 0) === 1;
}

export async function deletePaperResource(
  env: Env,
  input: { resourceId: string; sessionId: string; userId: string; now?: number },
): Promise<boolean> {
  const now = input.now ?? nowSeconds();
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE paper_resources SET status = 'deleted', updated_at = ?4
       WHERE resource_id = ?1 AND session_id = ?2 AND user_id = ?3
         AND status <> 'deleted'`,
    ).bind(input.resourceId, input.sessionId, input.userId, now),
    env.DB.prepare(
      `UPDATE paper_processing_attempts SET status = 'cancelled', finished_at = ?2
       WHERE resource_id = ?1 AND status IN ('claimed', 'downloading', 'extracting', 'uploading')`,
    ).bind(input.resourceId, now),
    env.DB.prepare(
      `UPDATE paper_request_continuations
          SET status = 'cancelled', active_turn_id = NULL,
              lease_expires_at = NULL, updated_at = ?2
        WHERE resource_id = ?1 AND status IN ('waiting', 'ready', 'running')`,
    ).bind(input.resourceId, now),
    env.DB.prepare(
      `INSERT INTO paper_cleanup_jobs
         (cleanup_id, resource_id, status, attempts, next_attempt_at, last_error_code, created_at, updated_at)
       SELECT ?1, resource_id, 'pending', 0, ?2, NULL, ?2, ?2
        FROM paper_resources
        WHERE resource_id = ?3 AND status = 'deleted'
       ON CONFLICT(resource_id) DO UPDATE SET
         status = CASE WHEN paper_cleanup_jobs.status = 'completed' THEN 'completed' ELSE 'pending' END,
         next_attempt_at = CASE WHEN paper_cleanup_jobs.status = 'completed' THEN paper_cleanup_jobs.next_attempt_at ELSE excluded.next_attempt_at END,
         updated_at = excluded.updated_at`,
    ).bind(crypto.randomUUID(), now, input.resourceId),
  ]);
  return Number((results[0] as { meta?: { changes?: number } } | undefined)?.meta?.changes ?? 0) === 1;
}

export async function createPaperProcessingAttempt(
  env: Env,
  row: Pick<PaperProcessingAttemptRow, "attempt_id" | "resource_id" | "processor_id" | "lease_token_hash" | "fencing_epoch" | "lease_expires_at">,
): Promise<PaperProcessingAttemptRow> {
  if (!/^[0-9a-fA-F]{64}$/.test(row.lease_token_hash) || !Number.isSafeInteger(row.fencing_epoch) || row.fencing_epoch <= 0) {
    throw new Error("Invalid paper processing lease");
  }
  const attempt: PaperProcessingAttemptRow = {
    ...row,
    status: "claimed",
    started_at: nowSeconds(),
    finished_at: null,
    error_code: null,
    error_message_safe: null,
  };
  await env.DB.prepare(
    `INSERT INTO paper_processing_attempts
       (attempt_id, resource_id, processor_id, lease_token_hash, fencing_epoch, status,
        started_at, lease_expires_at, finished_at, error_code, error_message_safe)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
  ).bind(
    attempt.attempt_id, attempt.resource_id, attempt.processor_id, attempt.lease_token_hash,
    attempt.fencing_epoch, attempt.status, attempt.started_at, attempt.lease_expires_at,
    attempt.finished_at, attempt.error_code, attempt.error_message_safe,
  ).run();
  return attempt;
}

export async function getPaperProcessingAttempt(env: Env, resourceId: string, attemptId: string): Promise<PaperProcessingAttemptRow | null> {
  return env.DB.prepare(
    `SELECT * FROM paper_processing_attempts WHERE resource_id = ?1 AND attempt_id = ?2`,
  ).bind(resourceId, attemptId).first<PaperProcessingAttemptRow>();
}

export interface PaperResourceTransition {
  resourceId: string;
  expectedStatus: PaperResourceStatus;
  nextStatus: PaperResourceStatus;
  attemptId?: string;
  fencingEpoch?: number;
  now?: number;
}

export async function transitionPaperResource(env: Env, transition: PaperResourceTransition): Promise<boolean> {
  if (!PAPER_RESOURCE_TRANSITIONS[transition.expectedStatus]?.includes(transition.nextStatus)) return false;
  if (transition.attemptId && (!Number.isSafeInteger(transition.fencingEpoch) || (transition.fencingEpoch as number) <= 0)) return false;
  const now = transition.now ?? nowSeconds();
  const result = await env.DB.prepare(
    `UPDATE paper_resources
        SET status = ?2,
            updated_at = ?6,
            ready_at = CASE WHEN ?2 = 'ready' THEN ?6 ELSE ready_at END
      WHERE resource_id = ?1 AND status = ?3
        AND (?4 IS NULL OR EXISTS (
          SELECT 1 FROM paper_processing_attempts a
           WHERE a.attempt_id = ?4 AND a.resource_id = ?1
             AND a.fencing_epoch = ?5
             AND a.status IN ('claimed', 'downloading', 'extracting', 'uploading')
             AND a.lease_expires_at > ?6
        ))`,
  ).bind(
    transition.resourceId,
    transition.nextStatus,
    transition.expectedStatus,
    transition.attemptId ?? null,
    transition.fencingEpoch ?? null,
    now,
  ).run();
  return (result.meta?.changes ?? 0) === 1;
}

// --- dedicated Paper Processor control plane ---

export async function createPaperProcessorSession(
  env: Env,
  row: PaperProcessorSessionRow,
): Promise<void> {
  if (!row.processor_session_id || !row.processor_id || !row.instance_id || !/^[0-9a-f]{64}$/.test(row.session_token_hash)) {
    throw new Error("Invalid Paper Processor session");
  }
  await env.DB.prepare(
    `INSERT INTO paper_processor_sessions
       (processor_session_id, processor_id, instance_id, session_token_hash,
        created_at, last_seen_at, expires_at, revoked_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  ).bind(
    row.processor_session_id, row.processor_id, row.instance_id, row.session_token_hash,
    row.created_at, row.last_seen_at, row.expires_at, row.revoked_at,
  ).run();
}

export async function getActivePaperProcessorSession(
  env: Env,
  sessionId: string,
  sessionTokenHash: string,
  now: number,
): Promise<PaperProcessorSessionRow | null> {
  return env.DB.prepare(
    `SELECT processor_session_id, processor_id, instance_id, session_token_hash,
            created_at, last_seen_at, expires_at, revoked_at
       FROM paper_processor_sessions
      WHERE processor_session_id = ?1 AND session_token_hash = ?2
        AND revoked_at IS NULL AND expires_at > ?3`,
  ).bind(sessionId, sessionTokenHash, now).first<PaperProcessorSessionRow>();
}

export async function getActivePaperProcessorSessionByToken(
  env: Env,
  sessionTokenHash: string,
  now: number,
): Promise<PaperProcessorSessionRow | null> {
  return env.DB.prepare(
    `SELECT processor_session_id, processor_id, instance_id, session_token_hash,
            created_at, last_seen_at, expires_at, revoked_at
       FROM paper_processor_sessions
      WHERE session_token_hash = ?1 AND revoked_at IS NULL AND expires_at > ?2`,
  ).bind(sessionTokenHash, now).first<PaperProcessorSessionRow>();
}

export async function touchPaperProcessorSession(env: Env, sessionId: string, now: number, expiresAt: number): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE paper_processor_sessions
        SET last_seen_at = ?2, expires_at = ?3
      WHERE processor_session_id = ?1 AND revoked_at IS NULL AND expires_at > ?2`,
  ).bind(sessionId, now, expiresAt).run();
  return (result.meta?.changes ?? 0) === 1;
}

export interface PaperProcessorClaimInput {
  processorId: string;
  attemptId: string;
  leaseTokenHash: string;
  leaseExpiresAt: number;
  now: number;
}

export interface PaperProcessorGrant {
  resource_id: string;
  attempt_id: string;
  lease_token: string;
  fencing_epoch: number;
  lease_expires_at: number;
  source_kind: PaperSourceKind;
  source_ref: string;
  canonical_ref: string | null;
}

interface PaperClaimCandidate extends Pick<PaperResourceRow, "resource_id" | "source_kind" | "source_ref" | "canonical_ref"> {
  fencing_epoch: number;
}

/**
 * A Processor can be killed after claiming a resource (for example by its
 * cgroup memory limit).  Lease expiry is the authority in that case: retire
 * the fenced attempt first, then make only its non-terminal resource
 * claimable again.  This runs before every server-selected poll, so recovery
 * never relies on a browser retry or manual D1 intervention.
 */
async function recoverExpiredPaperProcessingAttempts(env: Env, now: number): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE paper_processing_attempts
          SET status = 'expired', finished_at = ?1,
              error_code = 'PAPER_PROCESSOR_LEASE_EXPIRED',
              error_message_safe = 'Paper Processor lease expired before completion'
        WHERE status IN ('claimed', 'downloading', 'extracting', 'uploading')
          AND lease_expires_at <= ?1`,
    ).bind(now),
    env.DB.prepare(
      `UPDATE paper_resources
          SET status = 'requested', updated_at = ?1
        WHERE status IN ('downloading', 'extracting', 'uploading')
          AND EXISTS (
            SELECT 1 FROM paper_processing_attempts a
             WHERE a.resource_id = paper_resources.resource_id
               AND a.status = 'expired'
               AND a.finished_at = ?1
          )
          AND NOT EXISTS (
            SELECT 1 FROM paper_processing_attempts a
             WHERE a.resource_id = paper_resources.resource_id
               AND a.status IN ('claimed', 'downloading', 'extracting', 'uploading')
               AND a.lease_expires_at > ?1
          )`,
    ).bind(now),
  ]);
}

export async function claimPaperResource(
  env: Env,
  input: PaperProcessorClaimInput,
  leaseToken: string,
): Promise<PaperProcessorGrant | null> {
  if (!input.processorId || !input.attemptId || !/^[0-9a-f]{64}$/.test(input.leaseTokenHash)) return null;
  await recoverExpiredPaperProcessingAttempts(env, input.now);
  const candidate = await env.DB.prepare(
    `SELECT r.resource_id, r.source_kind, r.source_ref, r.canonical_ref,
            COALESCE(MAX(a.fencing_epoch), 0) + 1 AS fencing_epoch
       FROM paper_resources r
       LEFT JOIN paper_processing_attempts a ON a.resource_id = r.resource_id
      WHERE r.status = 'requested'
      GROUP BY r.resource_id, r.source_kind, r.source_ref, r.canonical_ref, r.created_at
      ORDER BY r.created_at ASC
      LIMIT 1`,
  ).bind().first<PaperClaimCandidate>();
  if (!candidate) return null;
  const fencingEpoch = Number(candidate.fencing_epoch);
  if (!Number.isSafeInteger(fencingEpoch) || fencingEpoch <= 0) return null;
  try {
    await createPaperProcessingAttempt(env, {
      attempt_id: input.attemptId,
      resource_id: candidate.resource_id,
      processor_id: input.processorId,
      lease_token_hash: input.leaseTokenHash,
      fencing_epoch: fencingEpoch,
      lease_expires_at: input.leaseExpiresAt,
    });
  } catch {
    // The partial unique active-attempt index makes a concurrent claim lose
    // safely; callers may poll again without receiving a second lease.
    return null;
  }
  const claimed = await transitionPaperResource(env, {
    resourceId: candidate.resource_id,
    expectedStatus: "requested",
    nextStatus: "downloading",
    attemptId: input.attemptId,
    fencingEpoch,
    now: input.now,
  });
  if (!claimed) {
    await env.DB.prepare(
      `UPDATE paper_processing_attempts SET status = 'cancelled', finished_at = ?2
        WHERE attempt_id = ?1 AND status = 'claimed'`,
    ).bind(input.attemptId, input.now).run();
    return null;
  }
  return {
    resource_id: candidate.resource_id,
    attempt_id: input.attemptId,
    lease_token: leaseToken,
    fencing_epoch: fencingEpoch,
    lease_expires_at: input.leaseExpiresAt,
    source_kind: candidate.source_kind,
    source_ref: candidate.source_ref,
    canonical_ref: candidate.canonical_ref,
  };
}

export async function getAuthorizedPaperProcessorAttempt(
  env: Env,
  input: { attemptId: string; resourceId: string; processorId: string; leaseTokenHash: string; fencingEpoch: number; now: number },
): Promise<PaperProcessorAttemptContext | null> {
  return env.DB.prepare(
    `SELECT a.attempt_id, a.resource_id, a.processor_id, a.lease_token_hash,
            a.fencing_epoch, a.status AS attempt_status, a.started_at, a.lease_expires_at,
            a.finished_at, a.error_code, a.error_message_safe,
            r.source_kind, r.source_ref, r.canonical_ref, r.title, r.status AS resource_status,
            r.pdf_object_key, r.text_manifest_key
       FROM paper_processing_attempts a
       JOIN paper_resources r ON r.resource_id = a.resource_id
      WHERE a.attempt_id = ?1 AND a.resource_id = ?2 AND a.processor_id = ?3
        AND a.lease_token_hash = ?4 AND a.fencing_epoch = ?5
        AND a.status IN ('claimed', 'downloading', 'extracting', 'uploading')
        AND a.lease_expires_at > ?6`,
  ).bind(input.attemptId, input.resourceId, input.processorId, input.leaseTokenHash, input.fencingEpoch, input.now)
    .first<PaperProcessingAttemptRow & Pick<PaperResourceRow, "source_kind" | "source_ref" | "canonical_ref" | "title" | "pdf_object_key" | "text_manifest_key"> & { attempt_status: PaperProcessingAttemptStatus; resource_status: PaperResourceStatus }>()
    .then((row) => row ? ({ attempt: {
      attempt_id: row.attempt_id,
      resource_id: row.resource_id,
      processor_id: row.processor_id,
      lease_token_hash: row.lease_token_hash,
      fencing_epoch: row.fencing_epoch,
      status: row.attempt_status,
      started_at: row.started_at,
      lease_expires_at: row.lease_expires_at,
      finished_at: row.finished_at,
      error_code: row.error_code,
      error_message_safe: row.error_message_safe,
    }, resource: {
      resource_id: row.resource_id,
      source_kind: row.source_kind,
      source_ref: row.source_ref,
      canonical_ref: row.canonical_ref,
      title: row.title,
      status: row.resource_status,
      pdf_object_key: row.pdf_object_key,
      text_manifest_key: row.text_manifest_key,
    } }) : null);
}

export async function renewPaperProcessorAttempt(
  env: Env,
  input: { attemptId: string; resourceId: string; processorId: string; leaseTokenHash: string; fencingEpoch: number; now: number; leaseExpiresAt: number },
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE paper_processing_attempts
        SET lease_expires_at = ?7
      WHERE attempt_id = ?1 AND resource_id = ?2 AND processor_id = ?3
        AND lease_token_hash = ?4 AND fencing_epoch = ?5
        AND status IN ('claimed', 'downloading', 'extracting', 'uploading')
        AND lease_expires_at > ?6`,
  ).bind(input.attemptId, input.resourceId, input.processorId, input.leaseTokenHash, input.fencingEpoch, input.now, input.leaseExpiresAt).run();
  return (result.meta?.changes ?? 0) === 1;
}

export async function stagePaperProcessorAttempt(
  env: Env,
  input: { attemptId: string; resourceId: string; processorId: string; leaseTokenHash: string; fencingEpoch: number; now: number; stage: "extracting" | "uploading" },
): Promise<boolean> {
  const expected = input.stage === "extracting" ? "downloading" : "extracting";
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE paper_resources SET status = ?7, updated_at = ?6
        WHERE resource_id = ?1 AND status = ?2
          AND EXISTS (SELECT 1 FROM paper_processing_attempts a
            WHERE a.attempt_id = ?3 AND a.resource_id = ?1 AND a.processor_id = ?4
              AND a.lease_token_hash = ?5 AND a.fencing_epoch = ?8
              AND a.status IN ('claimed', 'downloading', 'extracting', 'uploading')
              AND a.lease_expires_at > ?6)`,
    ).bind(input.resourceId, expected, input.attemptId, input.processorId, input.leaseTokenHash, input.now, input.stage, input.fencingEpoch),
    env.DB.prepare(
      `UPDATE paper_processing_attempts SET status = ?2
        WHERE attempt_id = ?1 AND resource_id = ?3 AND processor_id = ?4
          AND lease_token_hash = ?5 AND fencing_epoch = ?6
          AND status IN ('claimed', 'downloading', 'extracting', 'uploading')
          AND lease_expires_at > ?7`,
    ).bind(input.attemptId, input.stage, input.resourceId, input.processorId, input.leaseTokenHash, input.fencingEpoch, input.now),
  ]);
  return Number((results[0] as { meta?: { changes?: number } } | undefined)?.meta?.changes ?? 0) === 1
    && Number((results[1] as { meta?: { changes?: number } } | undefined)?.meta?.changes ?? 0) === 1;
}

export type PaperUploadedObjectKind = "source_pdf" | "text_pages" | "text_manifest" | "image" | "image_manifest";

export async function recordPaperProcessorObject(
  env: Env,
  input: { attemptId: string; resourceId: string; processorId: string; leaseTokenHash: string; fencingEpoch: number; now: number; kind: PaperUploadedObjectKind; objectId?: string; sizeBytes: number; sha256: string; contentType?: string },
): Promise<boolean> {
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0 || !/^[0-9a-f]{64}$/.test(input.sha256)) return false;
  if ((input.kind === "text_pages" || input.kind === "image") && (!input.objectId || (input.kind === "image" && !/^page-\d{4}-image-\d{4}$/.test(input.objectId)) || (input.kind === "text_pages" && input.objectId !== "pages"))) return false;
  if (input.kind === "text_pages" || input.kind === "image") {
    const result = await env.DB.prepare(
      `INSERT INTO paper_processor_objects
         (resource_id, attempt_id, kind, object_id, size_bytes, sha256, content_type, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8
        WHERE EXISTS (SELECT 1 FROM paper_processing_attempts a
          WHERE a.attempt_id = ?2 AND a.resource_id = ?1 AND a.processor_id = ?9
            AND a.lease_token_hash = ?10 AND a.fencing_epoch = ?11
            AND a.status = 'uploading' AND a.lease_expires_at > ?8)
          AND EXISTS (SELECT 1 FROM paper_resources r WHERE r.resource_id = ?1 AND r.status = 'uploading')
       ON CONFLICT(resource_id, kind, object_id) DO UPDATE SET
         size_bytes = excluded.size_bytes, sha256 = excluded.sha256,
         content_type = excluded.content_type
        WHERE paper_processor_objects.size_bytes = excluded.size_bytes
          AND paper_processor_objects.sha256 = excluded.sha256`,
    ).bind(
      input.resourceId, input.attemptId, input.kind, input.objectId, input.sizeBytes, input.sha256,
      input.contentType ?? "application/octet-stream", input.now, input.processorId, input.leaseTokenHash, input.fencingEpoch,
    ).run();
    return (result.meta?.changes ?? 0) === 1;
  }
  const isSourcePdf = input.kind === "source_pdf";
  const column = isSourcePdf ? "pdf_object_key = 'paper/' || resource_id || '/source.pdf', pdf_size_bytes = ?6, pdf_sha256 = ?7, source_sha256 = ?7"
    : input.kind === "text_manifest" ? "text_manifest_key = 'paper/' || resource_id || '/text/manifest.json'"
      : "image_manifest_key = 'paper/' || resource_id || '/images/manifest.json'";
  const result = await env.DB.prepare(
    `UPDATE paper_resources SET ${column}, updated_at = ?8
      WHERE resource_id = ?1 AND status = '${isSourcePdf ? "downloading" : "uploading"}'
        AND EXISTS (SELECT 1 FROM paper_processing_attempts a
          WHERE a.attempt_id = ?2 AND a.resource_id = ?1 AND a.processor_id = ?3
            AND a.lease_token_hash = ?4 AND a.fencing_epoch = ?5
            AND a.status IN (${isSourcePdf ? "'claimed', 'downloading'" : "'uploading'"}) AND a.lease_expires_at > ?8)`,
  ).bind(input.resourceId, input.attemptId, input.processorId, input.leaseTokenHash, input.fencingEpoch, input.sizeBytes, input.sha256, input.now).run();
  return (result.meta?.changes ?? 0) === 1;
}

export async function finalizePaperProcessorAttempt(
  env: Env,
  input: { attemptId: string; resourceId: string; processorId: string; leaseTokenHash: string; fencingEpoch: number; now: number; pageCount: number | null; imageCount: number | null },
): Promise<boolean> {
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE paper_resources SET status = 'ready', page_count = ?6, image_count = ?7,
              updated_at = ?8, ready_at = ?8
        WHERE resource_id = ?1 AND status = 'uploading' AND text_manifest_key IS NOT NULL
          AND (?6 IS NULL OR (?6 >= 0 AND ?6 <= 10000))
          AND (?7 IS NULL OR (?7 >= 0 AND ?7 <= 100000))
          AND EXISTS (SELECT 1 FROM paper_processing_attempts a
            WHERE a.attempt_id = ?2 AND a.resource_id = ?1 AND a.processor_id = ?3
              AND a.lease_token_hash = ?4 AND a.fencing_epoch = ?5
              AND a.status = 'uploading' AND a.lease_expires_at > ?8)`,
    ).bind(input.resourceId, input.attemptId, input.processorId, input.leaseTokenHash, input.fencingEpoch, input.pageCount, input.imageCount, input.now),
    env.DB.prepare(
      `UPDATE paper_processing_attempts SET status = 'succeeded', finished_at = ?6
        WHERE attempt_id = ?1 AND resource_id = ?2 AND processor_id = ?3
          AND lease_token_hash = ?4 AND fencing_epoch = ?5 AND status = 'uploading'`,
    ).bind(input.attemptId, input.resourceId, input.processorId, input.leaseTokenHash, input.fencingEpoch, input.now),
    env.DB.prepare(
      `UPDATE paper_request_continuations
          SET status = 'ready', updated_at = ?2
        WHERE resource_id = ?1 AND status = 'waiting'`,
    ).bind(input.resourceId, input.now),
  ]);
  return Number((results[0] as { meta?: { changes?: number } } | undefined)?.meta?.changes ?? 0) === 1
    && Number((results[1] as { meta?: { changes?: number } } | undefined)?.meta?.changes ?? 0) === 1;
}

export async function cancelPaperProcessorAttempt(
  env: Env,
  input: { attemptId: string; resourceId: string; processorId: string; leaseTokenHash: string; fencingEpoch: number; now: number },
): Promise<boolean> {
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE paper_resources SET status = 'cancelled', updated_at = ?6
        WHERE resource_id = ?1 AND status IN ('downloading', 'extracting', 'uploading')
          AND EXISTS (SELECT 1 FROM paper_processing_attempts a
            WHERE a.attempt_id = ?2 AND a.resource_id = ?1 AND a.processor_id = ?3
              AND a.lease_token_hash = ?4 AND a.fencing_epoch = ?5
              AND a.status IN ('claimed', 'downloading', 'extracting', 'uploading')
              AND a.lease_expires_at > ?6)`,
    ).bind(input.resourceId, input.attemptId, input.processorId, input.leaseTokenHash, input.fencingEpoch, input.now),
    env.DB.prepare(
      `UPDATE paper_processing_attempts SET status = 'cancelled', finished_at = ?6
        WHERE attempt_id = ?1 AND resource_id = ?2 AND processor_id = ?3
          AND lease_token_hash = ?4 AND fencing_epoch = ?5
          AND status IN ('claimed', 'downloading', 'extracting', 'uploading')
          AND lease_expires_at > ?6`,
    ).bind(input.attemptId, input.resourceId, input.processorId, input.leaseTokenHash, input.fencingEpoch, input.now),
    env.DB.prepare(
      `UPDATE paper_request_continuations
          SET status = 'cancelled', active_turn_id = NULL,
              lease_expires_at = NULL, updated_at = ?2
        WHERE resource_id = ?1 AND status IN ('waiting', 'ready', 'running')`,
    ).bind(input.resourceId, input.now),
  ]);
  return Number((results[0] as { meta?: { changes?: number } } | undefined)?.meta?.changes ?? 0) === 1
    && Number((results[1] as { meta?: { changes?: number } } | undefined)?.meta?.changes ?? 0) === 1;
}

export async function failPaperProcessorAttempt(
  env: Env,
  input: { attemptId: string; resourceId: string; processorId: string; leaseTokenHash: string; fencingEpoch: number; now: number; errorCode: string; errorMessageSafe: string },
): Promise<boolean> {
  if (!/^[A-Z0-9_]{1,64}$/.test(input.errorCode) || input.errorMessageSafe.length > 1024) return false;
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE paper_resources SET status = 'failed', error_code = ?6,
              error_message_safe = ?7, updated_at = ?8
        WHERE resource_id = ?1 AND status IN ('downloading', 'extracting', 'uploading')
          AND EXISTS (SELECT 1 FROM paper_processing_attempts a
            WHERE a.attempt_id = ?2 AND a.resource_id = ?1 AND a.processor_id = ?3
              AND a.lease_token_hash = ?4 AND a.fencing_epoch = ?5
              AND a.status IN ('claimed', 'downloading', 'extracting', 'uploading')
              AND a.lease_expires_at > ?8)`,
    ).bind(input.resourceId, input.attemptId, input.processorId, input.leaseTokenHash, input.fencingEpoch, input.errorCode, input.errorMessageSafe, input.now),
    env.DB.prepare(
      `UPDATE paper_processing_attempts SET status = 'failed', error_code = ?6,
              error_message_safe = ?7, finished_at = ?8
        WHERE attempt_id = ?1 AND resource_id = ?2 AND processor_id = ?3
          AND lease_token_hash = ?4 AND fencing_epoch = ?5
          AND status IN ('claimed', 'downloading', 'extracting', 'uploading')
          AND lease_expires_at > ?8`,
    ).bind(input.attemptId, input.resourceId, input.processorId, input.leaseTokenHash, input.fencingEpoch, input.errorCode, input.errorMessageSafe, input.now),
    env.DB.prepare(
      `UPDATE paper_request_continuations
          SET status = 'failed', active_turn_id = NULL,
              lease_expires_at = NULL, last_error_code = ?2, updated_at = ?3
        WHERE resource_id = ?1 AND status IN ('waiting', 'ready', 'running')`,
    ).bind(input.resourceId, input.errorCode, input.now),
  ]);
  return Number((results[0] as { meta?: { changes?: number } } | undefined)?.meta?.changes ?? 0) === 1
    && Number((results[1] as { meta?: { changes?: number } } | undefined)?.meta?.changes ?? 0) === 1;
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

// Compatibility input only. Retire this table in a separately approved
// migration after all active clients use paper_resource_links and PAPER-10 has
// verified that no production full-text read still depends on legacy refs.

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
