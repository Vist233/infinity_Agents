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

export class FakeD1 {
  dailyUsage = new Map<string, number>();
  paperAuth = new Set<string>();
  cache = new Map<string, { data: string; expires_at: number }>();
  chatSessions = new Map<string, ChatSessionRow>();
  chatMessages: ChatMessageRow[] = [];
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
    ZHANG_AUTH_AUD: "infinity-agents",
    DAILY_QUOTA: "20",
    STEPFUN_API_KEY: "sk-test",
    ZHANG_AUTH_CLIENT_SECRET: "secret-test",
    ...overrides
  } as Env;
  return { env, db };
}
