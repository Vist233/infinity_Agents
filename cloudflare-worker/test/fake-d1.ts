import type { Env, RateLimitBinding } from "../src/env";

/**
 * Minimal in-memory stand-in for the subset of D1 used by the Worker. Statements
 * are matched by a stable substring of their SQL; only the tables exercised by
 * the quota + paper-tool + chat tests are implemented.
 */
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

export interface TaskRow {
  task_id: string;
  title: string;
  status: string;
  created_by: string;
  chat_confirmation_id: string | null;
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

export class FakeD1 {
  dailyUsage = new Map<string, number>();
  paperAuth = new Set<string>();
  cache = new Map<string, { data: string; expires_at: number }>();
  chatSessions = new Map<string, ChatSessionRow>();
  chatMessages: ChatMessageRow[] = [];
  chatTaskConfirmations = new Map<string, ChatTaskConfirmationRow>();
  chatRequestIdempotency = new Map<string, ChatRequestIdempotencyRow>();
  tasks = new Map<string, TaskRow>();
  private messageSeq = 0;

  seedChatSession(id: string, userId: string, title = "Test session"): void {
    const ts = Math.floor(Date.now() / 1000);
    this.chatSessions.set(id, { id, user_id: userId, title, created_at: ts, updated_at: ts });
  }

  addMessage(sessionId: string, role: string, content: string): void {
    this.messageSeq += 1;
    this.chatMessages.push({
      id: this.messageSeq,
      session_id: sessionId,
      role,
      content,
      created_at: Math.floor(Date.now() / 1000)
    });
  }

  seedTask(taskId: string, userId: string, title = "Test task", status = "queued", chatConfirmationId: string | null = null): void {
    this.tasks.set(taskId, { task_id: taskId, title, status, created_by: userId, chat_confirmation_id: chatConfirmationId });
    if (chatConfirmationId) {
      const confirmation = this.chatTaskConfirmations.get(chatConfirmationId);
      if (confirmation) confirmation.task_id = taskId;
    }
  }

  prepare(sql: string) {
    return new FakeStatement(this, sql);
  }

  async batch(statements: FakeStatement[]): Promise<unknown[]> {
    const out: unknown[] = [];
    for (const stmt of statements) {
      out.push(await stmt.run());
    }
    return out;
  }
}

class FakeStatement {
  private args: unknown[] = [];
  constructor(private db: FakeD1, private sql: string) {}

  bind(...args: unknown[]): this {
    this.args = args;
    return this;
  }

  async first<T>(): Promise<T | null> {
    const sql = this.sql;
    if (sql.includes("INSERT INTO daily_usage")) {
      // Atomic increment UPSERT ... RETURNING count.
      const [userId, day] = this.args as [string, string];
      const key = `${userId}|${day}`;
      const next = (this.db.dailyUsage.get(key) ?? 0) + 1;
      this.db.dailyUsage.set(key, next);
      return { count: next } as T;
    }
    if (sql.includes("SELECT count FROM daily_usage")) {
      const [userId, day] = this.args as [string, string];
      const count = this.db.dailyUsage.get(`${userId}|${day}`);
      return count === undefined ? null : ({ count } as T);
    }
    if (sql.includes("FROM paper_authorizations")) {
      const [sessionId, ref] = this.args as [string, string];
      return this.db.paperAuth.has(`${sessionId}|${ref}`) ? ({ ok: 1 } as T) : null;
    }
    if (sql.includes("FROM chat_sessions")) {
      const [id, userId] = this.args as [string, string];
      const row = this.db.chatSessions.get(id);
      return row && row.user_id === userId ? (row as T) : null;
    }
    if (sql.includes("FROM chat_task_confirmations")) {
      const [confirmationId, sessionOrUserId, userId] = this.args as [string, string, string?];
      const row = this.db.chatTaskConfirmations.get(confirmationId);
      if (sql.includes("session_id = ?2")) {
        return row && row.session_id === sessionOrUserId && row.user_id === userId ? (row as T) : null;
      }
      return row && row.user_id === sessionOrUserId ? (row as T) : null;
    }
    if (sql.includes("FROM chat_request_idempotency")) {
      const [userId, clientRequestId] = this.args as [string, string];
      const row = this.db.chatRequestIdempotency.get(`${userId}|${clientRequestId}`);
      return (row as T) ?? null;
    }
    if (sql.includes("FROM tasks WHERE task_id")) {
      const [taskId, userId] = this.args as [string, string];
      const row = this.db.tasks.get(taskId);
      return row && row.created_by === userId ? (row as T) : null;
    }
    if (sql.includes("FROM paper_cache")) {
      const [key] = this.args as [string];
      const row = this.db.cache.get(key);
      return row ? ({ data: row.data, expires_at: row.expires_at } as T) : null;
    }
    return null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    if (this.sql.includes("FROM chat_messages")) {
      const [sessionId] = this.args as [string];
      const rows = this.db.chatMessages
        .filter((m) => m.session_id === sessionId)
        .sort((a, b) => a.id - b.id);
      return { results: rows as unknown as T[] };
    }
    return { results: [] };
  }

  async run(): Promise<{ meta: { changes: number } }> {
    const sql = this.sql;
    if (sql.includes("INSERT INTO chat_messages")) {
      const [sessionId, role, content] = this.args as [string, string, string];
      this.db.addMessage(sessionId, role, content);
      return { meta: { changes: 1 } };
    }
    if (sql.includes("INSERT INTO chat_task_confirmations")) {
      const [confirmationId, sessionId, userId, toolName, toolCallId, toolArgsJson, createdAt, expiresAt] = this.args as [
        string, string, string, string, string, string, number, number
      ];
      this.db.chatTaskConfirmations.set(confirmationId, {
        confirmation_id: confirmationId,
        session_id: sessionId,
        user_id: userId,
        tool_name: toolName,
        tool_call_id: toolCallId,
        tool_args_json: toolArgsJson,
        status: "pending",
        task_id: null,
        created_at: createdAt,
        expires_at: expiresAt,
        consumed_at: null,
      });
      return { meta: { changes: 1 } };
    }
    if (sql.includes("INSERT INTO chat_request_idempotency")) {
      const [userId, sessionId, clientRequestId, now] = this.args as [string, string, string, number];
      const key = `${userId}|${clientRequestId}`;
      if (this.db.chatRequestIdempotency.has(key)) return { meta: { changes: 0 } };
      this.db.chatRequestIdempotency.set(key, {
        user_id: userId,
        session_id: sessionId,
        client_request_id: clientRequestId,
        status: "processing",
        confirmation_id: null,
        response_text: "",
        created_at: now,
        updated_at: now,
      });
      return { meta: { changes: 1 } };
    }
    if (sql.includes("UPDATE chat_task_confirmations") && sql.includes("SET task_id = ?3")) {
      const [confirmationId, userId, taskId, now] = this.args as [string, string, string, number];
      const row = this.db.chatTaskConfirmations.get(confirmationId);
      if (!row || row.user_id !== userId || row.status !== "pending" || row.task_id || row.expires_at <= now) return { meta: { changes: 0 } };
      row.task_id = taskId;
      return { meta: { changes: 1 } };
    }
    if (sql.includes("UPDATE chat_task_confirmations") && sql.includes("SET status = 'processing'")) {
      const [confirmationId, taskId] = this.args as [string, string];
      const row = this.db.chatTaskConfirmations.get(confirmationId);
      if (!row || row.status !== "pending" || row.task_id !== taskId) return { meta: { changes: 0 } };
      row.status = "processing";
      return { meta: { changes: 1 } };
    }
    if (sql.includes("UPDATE chat_task_confirmations") && sql.includes("SET status = 'completed'")) {
      const [confirmationId, taskId, consumedAt] = this.args as [string, string, number];
      const row = this.db.chatTaskConfirmations.get(confirmationId);
      if (!row || row.status !== "processing") return { meta: { changes: 0 } };
      row.status = "completed";
      row.task_id = taskId;
      row.consumed_at = consumedAt;
      return { meta: { changes: 1 } };
    }
    if (sql.includes("UPDATE chat_task_confirmations SET status = 'pending'")) {
      const [confirmationId] = this.args as [string];
      const row = this.db.chatTaskConfirmations.get(confirmationId);
      if (!row || row.status !== "processing") return { meta: { changes: 0 } };
      row.status = "pending";
      return { meta: { changes: 1 } };
    }
    if (sql.includes("UPDATE chat_request_idempotency")) {
      const [userId, clientRequestId, status, confirmationId, responseText, now] = this.args as [string, string, "confirmation" | "completed", string | null, string, number];
      const row = this.db.chatRequestIdempotency.get(`${userId}|${clientRequestId}`);
      if (!row) return { meta: { changes: 0 } };
      row.status = status;
      row.confirmation_id = confirmationId;
      row.response_text = responseText;
      row.updated_at = now;
      return { meta: { changes: 1 } };
    }
    if (sql.includes("DELETE FROM chat_request_idempotency")) {
      const [userId, clientRequestId] = this.args as [string, string];
      const key = `${userId}|${clientRequestId}`;
      const row = this.db.chatRequestIdempotency.get(key);
      if (!row || row.status !== "processing") return { meta: { changes: 0 } };
      this.db.chatRequestIdempotency.delete(key);
      return { meta: { changes: 1 } };
    }
    if (sql.includes("UPDATE chat_sessions SET updated_at")) {
      return { meta: { changes: 1 } };
    }
    if (sql.includes("UPDATE daily_usage SET count = MAX")) {
      const [userId, day] = this.args as [string, string];
      const key = `${userId}|${day}`;
      const current = this.db.dailyUsage.get(key) ?? 0;
      this.db.dailyUsage.set(key, Math.max(current - 1, 0));
      return { meta: { changes: 1 } };
    }
    if (sql.includes("INSERT INTO paper_authorizations")) {
      const [sessionId, ref] = this.args as [string, string];
      this.db.paperAuth.add(`${sessionId}|${ref}`);
      return { meta: { changes: 1 } };
    }
    if (sql.includes("INSERT INTO paper_cache")) {
      const [key, data, expires_at] = this.args as [string, string, number];
      this.db.cache.set(key, { data, expires_at });
      return { meta: { changes: 1 } };
    }
    return { meta: { changes: 0 } };
  }
}

/** Rate limiter that always allows, unless configured otherwise. */
export function makeRateLimiter(allow = true): RateLimitBinding {
  return { async limit() { return { success: allow }; } };
}

export function makeEnv(overrides: Partial<Env> = {}): { env: Env; db: FakeD1 } {
  const db = new FakeD1();
  const env = {
    DB: db as unknown as Env["DB"],
    ASSETS: {} as Env["ASSETS"],
    CHAT_RATE_LIMITER: makeRateLimiter(true),
    STEPFUN_BASE_URL: "https://stepfun.test/v1",
    STEPFUN_MODEL: "step-test",
    APP_BASE_URL: "https://app.test",
    ZHANG_AUTH_BASE_URL: "https://auth.test",
    ZHANG_AUTH_JWKS_URL: "https://auth.test/.well-known/jwks.json",
    ZHANG_AUTH_CLIENT_ID: "infinity-agents",
    ZHANG_AUTH_AUD: "zhang-services",
    DAILY_QUOTA: "20",
    STEPFUN_API_KEY: "sk-test",
    ZHANG_AUTH_CLIENT_SECRET: "secret-test",
    ...overrides
  } as Env;
  return { env, db };
}
