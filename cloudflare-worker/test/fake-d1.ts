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
  task_class?: string;
  attempt_count?: number;
  max_attempts?: number;
  created_at?: number;
  dispatch_policy?: string;
  active_attempt_id?: string | null;
  cancel_requested_at?: number | null;
  updated_at?: number;
  finished_at?: number | null;
}

export interface PersistentWorkerRow {
  worker_id: string;
  namespace: string;
  user_id: string;
  credential_hash: string;
  status: string;
  revoked_at: number | null;
  credential_expires_at: number | null;
  trust_level: string;
  last_seen_at: number | null;
  created_at?: number;
  credential_ciphertext?: string | null;
  worker_kind?: "public" | "user";
  pool_id?: string | null;
  owner_user_id?: string | null;
}

export interface CanonicalWorkerRow {
  worker_id: string;
  pool_id: string;
  namespace: string;
  created_by: string;
  status: string;
  protocol_version: string;
  runtime_capability: string;
  image_digest: string | null;
  last_seen_at: number | null;
  created_at: number;
  updated_at: number;
  revoked_at: number | null;
  credential_hash: string;
  credential_ciphertext?: string | null;
}

export interface WorkerPoolRow {
  pool_id: string;
  kind: "public" | "user";
  namespace: string;
  owner_user_id: string | null;
  status: string;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

export interface WorkerAdminEventRow {
  event_id: string;
  action: string;
  worker_id: string | null;
  pool_id: string;
  actor_user_id: string;
  metadata_json: string;
  created_at: number;
}

export interface WorkerSessionRow {
  worker_id: string;
  namespace: string;
  session_id: string;
  instance_id: string;
  user_id: string;
  version: string | null;
  capabilities_json: string;
  connected_at: number;
  last_seen_at: number;
  lease_expires_at: number;
  disconnected_at: number | null;
  worker_kind?: "public" | "user";
  pool_id?: string | null;
  owner_user_id?: string | null;
}

export interface WorkerOfferRow {
  offer_id: string;
  task_id: string;
  worker_id: string;
  namespace: string;
  expires_at: number;
  created_at: number;
  accepted_at: number | null;
  worker_kind: "public" | "user";
  priority: number;
  superseded_at: number | null;
}

export interface WorkerAttemptRow {
  attempt_id: string;
  task_id: string;
  worker_id: string;
  namespace: string;
  status: string;
  lease_expires_at: number;
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
  workerRegistrations = new Map<string, PersistentWorkerRow>();
  workers = new Map<string, CanonicalWorkerRow>();
  workerPoolPolicy = { pool_id: "public-default", namespace: "infinity-public", mode: "public" as const };
  workerPools = new Map<string, WorkerPoolRow>();
  workerAdminEvents: WorkerAdminEventRow[] = [];
  workerSessions = new Map<string, WorkerSessionRow>();
  workerOffers = new Map<string, WorkerOfferRow>();
  workerAttempts = new Map<string, WorkerAttemptRow>();
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
    this.tasks.set(taskId, { task_id: taskId, title, status, created_by: userId, chat_confirmation_id: chatConfirmationId, task_class: "owner_trusted", attempt_count: 0, max_attempts: 3, created_at: Math.floor(Date.now() / 1000), dispatch_policy: "owner_then_public" });
    if (chatConfirmationId) {
      const confirmation = this.chatTaskConfirmations.get(chatConfirmationId);
      if (confirmation) confirmation.task_id = taskId;
    }
  }

  seedWorkerAttempt(row: WorkerAttemptRow): void {
    this.workerAttempts.set(row.attempt_id, row);
  }

  seedPersistentWorker(row: Omit<PersistentWorkerRow, "last_seen_at"> & { last_seen_at?: number | null }): void {
    this.workerRegistrations.set(`${row.worker_id}|${row.namespace}`, {
      ...row,
      last_seen_at: row.last_seen_at ?? null,
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
    const sql = this.sql.replace(/\s+/g, " ");
    if (sql.includes("FROM worker_pool_policy")) {
      return this.db.workerPoolPolicy as T;
    }
    if (sql.includes("FROM workers WHERE worker_id = ?1 AND pool_id = ?2")) {
      const [workerId, poolId, operator, userId] = this.args as [string, string, number, string];
      const row = this.db.workers.get(workerId);
      return row && row.pool_id === poolId && (operator === 1 || row.created_by === userId) ? row as T : null;
    }
    if (sql.includes("FROM workers WHERE worker_id = ?1")) {
      const [workerId] = this.args as [string];
      return (this.db.workers.get(workerId) as T) ?? null;
    }
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
    if (sql.includes("SELECT status, cancel_requested_at FROM tasks")) {
      return (this.db.tasks.get(String(this.args[0])) as T) ?? null;
    }
    if (sql.includes("FROM tasks WHERE task_id")) {
      const [taskId, userId] = this.args as [string, string];
      const row = this.db.tasks.get(taskId);
      return row && row.created_by === userId ? (row as T) : null;
    }
    if (sql.includes("SELECT attempt_id FROM worker_attempts") && sql.includes("worker_id = ?1")) {
      const [workerId, now] = this.args as [string, number];
      const row = [...this.db.workerAttempts.values()].find((attempt) => attempt.worker_id === workerId && ["claimed", "running"].includes(attempt.status) && attempt.lease_expires_at > now);
      return row ? ({ attempt_id: row.attempt_id } as T) : null;
    }
    if (sql.includes("SELECT t.task_id, t.title, t.task_class")) {
      const [trustLevel, now, ownerUserId] = this.args as [string, number, string?];
      const isPublic = sql.includes("FROM worker_registrations wr");
      const candidates = [...this.db.tasks.values()]
        .filter((task) => task.status === "queued" && task.dispatch_policy === "owner_then_public")
        .filter((task) => trustLevel !== "student_untrusted" || task.task_class === "public")
        .filter((task) => isPublic || task.created_by === ownerUserId)
        .filter((task) => ![...this.db.workerOffers.values()].some((offer) => offer.task_id === task.task_id && offer.accepted_at == null && offer.superseded_at == null && offer.expires_at > now))
        .filter((task) => !isPublic || ![...this.db.workerRegistrations.values()].some((worker) => {
          if (worker.worker_kind !== "user" || worker.owner_user_id !== task.created_by || worker.status !== "active") return false;
          const session = this.db.workerSessions.get(`${worker.worker_id}|${worker.namespace}`);
          if (!session || session.lease_expires_at <= now || session.disconnected_at != null) return false;
          const busy = [...this.db.workerAttempts.values()].some((attempt) => attempt.worker_id === worker.worker_id && attempt.namespace === worker.namespace && ["claimed", "running"].includes(attempt.status) && attempt.lease_expires_at > now);
          const offered = [...this.db.workerOffers.values()].some((offer) => offer.worker_id === worker.worker_id && offer.namespace === worker.namespace && offer.worker_kind === "user" && offer.accepted_at == null && offer.superseded_at == null && offer.expires_at > now);
          return !busy && !offered;
        }))
        .sort((left, right) => (left.created_at ?? 0) - (right.created_at ?? 0));
      const task = candidates[0];
      return task ? ({
        task_id: task.task_id,
        title: task.title,
        task_class: task.task_class ?? "owner_trusted",
        attempt_count: task.attempt_count ?? 0,
        max_attempts: task.max_attempts ?? 3,
      } as T) : null;
    }
    if (sql.includes("FROM worker_registrations") && sql.includes("credential_hash = ?1")) {
      const [credentialHash] = this.args as [string];
      const row = [...this.db.workerRegistrations.values()].find((worker) =>
        worker.credential_hash === credentialHash
          && worker.status === "active"
          && worker.revoked_at == null
          && (worker.credential_expires_at == null || worker.credential_expires_at > Number(this.args[1])));
      return row ? ({
        worker_id: row.worker_id,
        namespace: row.namespace,
        user_id: row.user_id,
        trust_level: row.trust_level,
        status: row.status,
        credential_expires_at: row.credential_expires_at,
        current_role: null,
        worker_kind: row.worker_kind ?? "user",
        pool_id: row.pool_id ?? null,
        owner_user_id: row.owner_user_id ?? (row.worker_kind === "public" ? null : row.user_id),
      } as T) : null;
    }
    if (sql.includes("FROM worker_pools WHERE pool_id = ?1")) {
      const [poolId] = this.args as [string];
      return (this.db.workerPools.get(poolId) as T) ?? null;
    }
    if (sql.includes("FROM worker_registrations") && sql.includes("worker_id = ?1") && sql.includes("pool_id = ?3")) {
      const [workerId, namespace, poolId] = this.args as [string, string, string];
      const row = this.db.workerRegistrations.get(`${workerId}|${namespace}`);
      if (!row || row.pool_id !== poolId || row.worker_kind !== "public"
        || (sql.includes("status = 'active'") && row.status !== "active")) return null;
      return {
        worker_id: row.worker_id,
        namespace: row.namespace,
        pool_id: poolId,
        credential_ciphertext: row.credential_ciphertext ?? null,
        status: row.status,
      } as T;
    }
    if (sql.includes("FROM paper_cache")) {
      const [key] = this.args as [string];
      const row = this.db.cache.get(key);
      return row ? ({ data: row.data, expires_at: row.expires_at } as T) : null;
    }
    return null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    const sql = this.sql.replace(/\s+/g, " ");
    if (sql.includes("FROM chat_messages")) {
      const [sessionId] = this.args as [string];
      const rows = this.db.chatMessages
        .filter((m) => m.session_id === sessionId)
        .sort((a, b) => a.id - b.id);
      return { results: rows as unknown as T[] };
    }
    if (sql.includes("FROM worker_registrations") && sql.includes("worker_kind = 'public'")) {
      const [poolId] = this.args as [string];
      const rows = [...this.db.workerRegistrations.values()]
        .filter((row) => row.worker_kind === "public" && row.pool_id === poolId)
        .sort((left, right) => (left.created_at ?? 0) - (right.created_at ?? 0));
      return { results: rows as unknown as T[] };
    }
    if (sql.includes("FROM workers WHERE pool_id = ?1 AND created_by = ?2")) {
      const [poolId, userId] = this.args as [string, string];
      const rows = [...this.db.workers.values()].filter((row) => row.pool_id === poolId && row.created_by === userId);
      return { results: rows as unknown as T[] };
    }
    if (sql.includes("FROM workers WHERE pool_id = ?1")) {
      const [poolId] = this.args as [string];
      const rows = [...this.db.workers.values()].filter((row) => row.pool_id === poolId);
      return { results: rows as unknown as T[] };
    }
    return { results: [] };
  }

  async run(): Promise<{ meta: { changes: number } }> {
    const sql = this.sql.replace(/\s+/g, " ");
    if (sql.includes("UPDATE tasks SET status = 'cancelled'")) {
      const [taskId, now] = this.args as [string, number];
      const row = this.db.tasks.get(taskId);
      if (!row || row.status !== "queued" || row.active_attempt_id) return { meta: { changes: 0 } };
      row.status = "cancelled";
      row.updated_at = now;
      row.finished_at = now;
      return { meta: { changes: 1 } };
    }
    if (sql.includes("UPDATE tasks SET cancel_requested_at")) {
      const [taskId, now] = this.args as [string, number];
      const row = this.db.tasks.get(taskId);
      if (!row || !["claimed", "running"].includes(row.status) || row.cancel_requested_at != null) return { meta: { changes: 0 } };
      row.cancel_requested_at = now;
      row.updated_at = now;
      return { meta: { changes: 1 } };
    }
    if (sql.includes("INSERT INTO task_events") || sql.includes("INSERT INTO outbox_events")) {
      return { meta: { changes: 1 } };
    }
    if (sql.includes("INSERT INTO workers")) {
      const [workerId, poolId, namespace, createdBy, credentialHash, credentialCiphertext, createdAt] = this.args as [string, string, string, string, string, string, number];
      this.db.workers.set(workerId, {
        worker_id: workerId,
        pool_id: poolId,
        namespace,
        created_by: createdBy,
        credential_hash: credentialHash,
        credential_ciphertext: credentialCiphertext,
        status: "active",
        protocol_version: "2",
        runtime_capability: "goal-driven-claude-code",
        image_digest: null,
        last_seen_at: null,
        created_at: createdAt,
        updated_at: createdAt,
        revoked_at: null,
      });
      return { meta: { changes: 1 } };
    }
    if (sql.includes("UPDATE workers SET credential_hash")) {
      const [workerId, credentialHash, credentialCiphertext, updatedAt] = this.args as [string, string, string, number];
      const row = this.db.workers.get(workerId);
      if (!row || row.status === "revoked") return { meta: { changes: 0 } };
      row.credential_hash = credentialHash;
      row.credential_ciphertext = credentialCiphertext;
      row.status = "active";
      row.revoked_at = null;
      row.last_seen_at = null;
      row.updated_at = updatedAt;
      return { meta: { changes: 1 } };
    }
    if (sql.includes("UPDATE workers SET revoked_at")) {
      const [workerId, revokedAt] = this.args as [string, number];
      const row = this.db.workers.get(workerId);
      if (!row || row.status === "revoked") return { meta: { changes: 0 } };
      row.status = "revoked";
      row.revoked_at = revokedAt;
      row.updated_at = revokedAt;
      return { meta: { changes: 1 } };
    }
    if (sql.includes("UPDATE worker_sessions_runtime")) {
      return { meta: { changes: 1 } };
    }
    if (sql.includes("INSERT INTO chat_messages")) {
      const [sessionId, role, content] = this.args as [string, string, string];
      this.db.addMessage(sessionId, role, content);
      return { meta: { changes: 1 } };
    }
    if (sql.includes("INSERT INTO worker_sessions")) {
      const [workerId, namespace, sessionId, instanceId, userId, version, capabilitiesJson, now, leaseExpiresAt] = this.args as [string, string, string, string, string, string, string, number, number];
      const key = `${workerId}|${namespace}`;
      const current = this.db.workerSessions.get(key);
      if (current && current.instance_id !== instanceId && current.lease_expires_at > now) {
        return { meta: { changes: 0 } };
      }
      this.db.workerSessions.set(key, {
        worker_id: workerId,
        namespace,
        session_id: sessionId,
        instance_id: instanceId,
        user_id: userId,
        version,
        capabilities_json: capabilitiesJson,
        connected_at: now,
        last_seen_at: now,
        lease_expires_at: leaseExpiresAt,
        disconnected_at: null,
        worker_kind: (this.args[9] as "public" | "user" | undefined) ?? "user",
        pool_id: (this.args[10] as string | null | undefined) ?? null,
        owner_user_id: (this.args[11] as string | null | undefined) ?? userId,
      });
      return { meta: { changes: 1 } };
    }
    if (sql.includes("INSERT INTO worker_pools")) {
      const [poolId, namespace, createdBy, now] = this.args as [string, string, string, number];
      if (this.db.workerPools.has(poolId)) return { meta: { changes: 0 } };
      this.db.workerPools.set(poolId, {
        pool_id: poolId,
        kind: "public",
        namespace,
        owner_user_id: null,
        status: "active",
        created_by: createdBy,
        created_at: now,
        updated_at: now,
      });
      return { meta: { changes: 1 } };
    }
    if (sql.includes("INSERT INTO worker_registrations")) {
      const [workerId, namespace, userId, credentialHash, credentialCiphertext, value6, value7] = this.args as [string, string, string, string, string, string | number, string | number];
      const isPublic = sql.includes("'public'");
      const row: PersistentWorkerRow = {
        worker_id: workerId,
        namespace,
        user_id: userId,
        credential_hash: credentialHash,
        credential_ciphertext: credentialCiphertext,
        credential_expires_at: null,
        status: "active",
        revoked_at: null,
        trust_level: isPublic ? "owner_trusted" : String(value6),
        last_seen_at: null,
        created_at: Number(isPublic ? value6 : value7),
        worker_kind: isPublic ? "public" : "user",
        pool_id: isPublic ? String(value7) : null,
        owner_user_id: isPublic ? null : userId,
      };
      this.db.workerRegistrations.set(`${workerId}|${namespace}`, row);
      return { meta: { changes: 1 } };
    }
    if (sql.includes("UPDATE worker_registrations") && sql.includes("SET revoked_at = ?3, status = 'revoked'") && sql.includes("worker_kind = 'public'")) {
      const [workerId, namespace, now, poolId] = this.args as [string, string, number, string];
      const row = this.db.workerRegistrations.get(`${workerId}|${namespace}`);
      if (!row || row.pool_id !== poolId || row.worker_kind !== "public" || row.revoked_at != null) return { meta: { changes: 0 } };
      row.revoked_at = now;
      row.status = "revoked";
      return { meta: { changes: 1 } };
    }
    if (sql.includes("INSERT INTO worker_admin_events")) {
      if (sql.includes("VALUES (?1, 'created'")) {
        const [eventId, workerId, poolId, actorUserId, createdAt] = this.args as [string, string, string, string, number];
        this.db.workerAdminEvents.push({ event_id: eventId, action: "created", worker_id: workerId, pool_id: poolId, actor_user_id: actorUserId, metadata_json: "{}", created_at: createdAt });
        return { meta: { changes: 1 } };
      }
      if (sql.includes("VALUES (?1, 'credential_rotated'") || sql.includes("VALUES (?1, 'revoked'")) {
        const [eventId, workerId, poolId, actorUserId, createdAt] = this.args as [string, string, string, string, number];
        const action = sql.includes("credential_rotated") ? "credential_rotated" : "revoked";
        this.db.workerAdminEvents.push({ event_id: eventId, action, worker_id: workerId, pool_id: poolId, actor_user_id: actorUserId, metadata_json: "{}", created_at: createdAt });
        return { meta: { changes: 1 } };
      }
      if (sql.includes("VALUES (?1, 'credential_recovered'")) {
        const [eventId, workerId, poolId, actorUserId, createdAt] = this.args as [string, string, string, string, number];
        this.db.workerAdminEvents.push({ event_id: eventId, action: "credential_recovered", worker_id: workerId, pool_id: poolId, actor_user_id: actorUserId, metadata_json: "{}", created_at: createdAt });
        return { meta: { changes: 1 } };
      }
      const [eventId, action, workerId, poolId, actorUserId, createdAt] = this.args as [string, string, string | null, string, string, number];
      this.db.workerAdminEvents.push({ event_id: eventId, action, worker_id: workerId, pool_id: poolId, actor_user_id: actorUserId, metadata_json: "{}", created_at: createdAt });
      return { meta: { changes: 1 } };
    }
    if (sql.includes("UPDATE worker_registrations") && sql.includes("SET credential_hash")) {
      const row = this.db.workerRegistrations.get(`${String(this.args[0])}|${String(this.args[1])}`);
      if (!row) return { meta: { changes: 0 } };
      const isPublic = sql.includes("worker_kind = 'public'");
      const credentialHash = String(this.args[isPublic ? 3 : 3]);
      const credentialCiphertext = String(this.args[4]);
      row.credential_hash = credentialHash;
      row.credential_ciphertext = credentialCiphertext;
      row.status = "active";
      row.revoked_at = null;
      row.last_seen_at = null;
      return { meta: { changes: 1 } };
    }
    if (sql.includes("UPDATE worker_sessions") && sql.includes("SET last_seen_at")) {
      const [workerId, namespace, sessionId, now, leaseExpiresAt] = this.args as [string, string, string, number, number];
      const row = this.db.workerSessions.get(`${workerId}|${namespace}`);
      if (!row || row.session_id !== sessionId || row.lease_expires_at <= now) return { meta: { changes: 0 } };
      row.last_seen_at = now;
      row.lease_expires_at = leaseExpiresAt;
      row.disconnected_at = null;
      return { meta: { changes: 1 } };
    }
    if (sql.includes("UPDATE worker_offers") && sql.includes("SET superseded_at")) {
      const [taskId, now] = this.args as [string, number];
      let changes = 0;
      for (const offer of this.db.workerOffers.values()) {
        if (offer.task_id === taskId && offer.worker_kind === "public" && offer.accepted_at == null && offer.superseded_at == null && offer.expires_at > now) {
          offer.superseded_at = now;
          changes += 1;
        }
      }
      return { meta: { changes } };
    }
    if (sql.includes("INSERT INTO worker_offers")) {
      const [offerId, taskId, workerId, namespace, expiresAt, createdAt, workerKind, priority] = this.args as [string, string, string, string, number, number, "public" | "user", number];
      this.db.workerOffers.set(offerId, { offer_id: offerId, task_id: taskId, worker_id: workerId, namespace, expires_at: expiresAt, created_at: createdAt, accepted_at: null, worker_kind: workerKind, priority, superseded_at: null });
      return { meta: { changes: 1 } };
    }
    if (sql.includes("UPDATE worker_sessions") && sql.includes("SET disconnected_at")) {
      if (!sql.includes("session_id = ?3")) {
        const [workerId, namespace, now] = this.args as [string, string, number];
        const row = this.db.workerSessions.get(`${workerId}|${namespace}`);
        if (!row) return { meta: { changes: 0 } };
        row.disconnected_at = now;
        row.lease_expires_at = now;
        return { meta: { changes: 1 } };
      }
      const [workerId, namespace, sessionId, now] = this.args as [string, string, string, number];
      const row = this.db.workerSessions.get(`${workerId}|${namespace}`);
      if (!row || row.session_id !== sessionId) return { meta: { changes: 0 } };
      row.disconnected_at = now;
      row.lease_expires_at = now;
      return { meta: { changes: 1 } };
    }
    if (sql.includes("UPDATE worker_registrations SET last_seen_at")) {
      const [workerId, namespace, now] = this.args as [string, string, number];
      const row = this.db.workerRegistrations.get(`${workerId}|${namespace}`);
      if (!row || row.status !== "active") return { meta: { changes: 0 } };
      row.last_seen_at = now;
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
    if (sql.includes("UPDATE chat_task_confirmations SET status = 'expired'")) {
      const [confirmationId, userId] = this.args as [string, string];
      const row = this.db.chatTaskConfirmations.get(confirmationId);
      if (!row || row.user_id !== userId || row.status !== "pending") return { meta: { changes: 0 } };
      row.status = "expired";
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
    AUTH_SESSION_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    ...overrides
  } as Env;
  return { env, db };
}
