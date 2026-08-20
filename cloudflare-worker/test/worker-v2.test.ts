import { describe, expect, it } from "vitest";
import { handleWorkerV2 } from "../src/worker-v2";
import { hashText } from "../src/sha256";

type Worker = {
  worker_id: string;
  pool_id: string;
  namespace: string;
  created_by: string;
  credential_hash: string;
  status: "active" | "revoked";
  protocol_version: string;
  runtime_capability: string;
  image_digest: string | null;
  last_seen_at: number | null;
};

type Session = {
  session_id: string;
  worker_id: string;
  pool_id: string;
  namespace: string;
  instance_id: string;
  protocol_version: string;
  runtime_capability: string;
  image_digest: string | null;
  session_secret_hash: string;
  session_epoch: number;
  connected_at: number;
  last_seen_at: number;
  lease_expires_at: number;
  disconnected_at: number | null;
};

type Task = {
  task_id: string;
  task_spec_id: string;
  dataset_snapshot_id: string;
  method_source_id: string | null;
  title: string;
  attempt_count: number;
  max_attempts: number;
  lease_epoch: number;
  status: string;
  execution_pool_id: string;
  active_attempt_id: string | null;
  lease_worker_id: string | null;
  lease_token_hash: string | null;
  lease_expires_at: number | null;
  result_artifact_id?: string | null;
  cancel_requested_at?: number | null;
};

type Attempt = {
  attempt_id: string;
  task_id: string;
  worker_id: string;
  session_id: string;
  attempt_number: number;
  fencing_epoch: number;
  lease_token_hash: string;
  lease_expires_at: number;
  status: string;
};

class RuntimeFakeD1 {
  readonly workers = new Map<string, Worker>();
  readonly sessions = new Map<string, Session>();
  readonly sessionHistory = new Map<string, Session>();
  readonly tasks = new Map<string, Task>();
  readonly attempts = new Map<string, Attempt>();
  readonly events: string[] = [];
  readonly outbox: string[] = [];
  readonly artifactUploads = new Map<string, any>();
  readonly artifactParts = new Map<string, Map<number, any>>();
  readonly artifacts = new Map<string, any>();
  readonly policy = { pool_id: "public-default", namespace: "infinity-public", mode: "public" as const };
  afterTaskLoad: (() => void) | null = null;

  prepare(sql: string): RuntimeFakeStatement {
    return new RuntimeFakeStatement(this, sql);
  }

  async batch(statements: RuntimeFakeStatement[]): Promise<unknown[]> {
    const output: unknown[] = [];
    for (const statement of statements) output.push(await statement.run());
    return output;
  }
}

class RuntimeFakeStatement {
  private args: unknown[] = [];
  constructor(private readonly db: RuntimeFakeD1, private readonly sql: string) {}
  bind(...args: unknown[]): this { this.args = args; return this; }

  async first<T>(): Promise<T | null> {
    const sql = this.sql.replace(/\s+/g, " ");
    if (sql.includes("FROM worker_pool_policy")) return this.db.policy as T;
    if (sql.includes("FROM workers WHERE worker_id")) {
      const [workerId, credentialHash] = this.args as [string, string];
      const row = this.db.workers.get(workerId);
      return row && row.credential_hash === credentialHash ? row as T : null;
    }
    if (sql.includes("FROM worker_sessions_runtime WHERE worker_id")) {
      return (this.db.sessions.get(String(this.args[0])) as T) ?? null;
    }
    if (sql.includes("FROM worker_sessions_runtime WHERE session_id")) {
      const [sessionId, workerId, now] = this.args as [string, string, number];
      const row = [...this.db.sessionHistory.values()].find((candidate) =>
        candidate.session_id === sessionId && candidate.worker_id === workerId
          && candidate.lease_expires_at > now && candidate.disconnected_at == null);
      return (row as T) ?? null;
    }
    if (sql.includes("SELECT finalize_artifact_id FROM artifact_uploads")) {
      const [uploadId, owner] = this.args as [string, string];
      const row = this.db.artifactUploads.get(uploadId);
      return row && row.finalize_owner === owner && row.status === "open" ? row as T : null;
    }
    if (sql.includes("FROM tasks t") && sql.includes("task-cancelled:")) {
      const [taskId, attemptId, uploadId] = this.args as [string, string, string];
      const task = this.db.tasks.get(taskId);
      const attempt = this.db.attempts.get(attemptId);
      const upload = this.db.artifactUploads.get(uploadId);
      const consistent = task?.status === "cancelled" && task.result_artifact_id == null
        && attempt?.status === "cancelled" && upload?.status === "aborted"
        && !this.db.artifacts.has(uploadId)
        && this.db.events.includes(`task-cancelled:${attemptId}`)
        && this.db.outbox.includes(`task-cancelled:${attemptId}`);
      return consistent ? ({ task_id: taskId } as T) : null;
    }
    if (sql.includes("FROM artifacts a") && sql.includes("JOIN artifact_uploads")) {
      const [uploadId, artifactId] = this.args as [string, string];
      const artifact = this.db.artifacts.get(uploadId);
      const upload = this.db.artifactUploads.get(uploadId);
      const task = artifact ? this.db.tasks.get(artifact.task_id) : null;
      const attempt = artifact ? this.db.attempts.get(artifact.attempt_id) : null;
      return artifact && upload?.status === "completed" && artifact.artifact_id === artifactId
        && task?.status === "succeeded" && task.result_artifact_id === artifactId
        && attempt?.status === "succeeded"
        && this.db.events.includes(`task-succeeded:${artifact.attempt_id}`)
        && this.db.outbox.includes(`task-succeeded:${artifact.attempt_id}`)
        ? ({ artifact_id: artifactId } as T) : null;
    }
    if (sql.includes("FROM artifact_uploads WHERE upload_id")) {
      const [uploadId, workerId] = this.args as [string, string];
      const row = this.db.artifactUploads.get(uploadId);
      return row && row.worker_id === workerId ? row as T : null;
    }
    if (sql.includes("FROM artifacts WHERE upload_id")) {
      return (this.db.artifacts.get(String(this.args[0])) as T) ?? null;
    }
    if (sql.includes("FROM task_attempts") && sql.includes("status = 'succeeded'")) {
      const [attemptId, taskId, workerId, sessionId, tokenHash, now, epoch, instanceId] = this.args as [string, string, string, string, string, number, number, string];
      const row = this.db.attempts.get(attemptId);
      const session = this.db.sessionHistory.get(sessionId);
      return row && row.task_id === taskId && row.worker_id === workerId && row.session_id === sessionId
        && row.lease_token_hash === tokenHash && row.status === "succeeded"
        && session?.worker_id === workerId && session.session_epoch === epoch && session.instance_id === instanceId
        && session.disconnected_at == null && session.lease_expires_at > now ? row as T : null;
    }
    if (sql.includes("FROM task_attempts")) {
      const [attemptId, taskId, workerId, sessionId, tokenHash, now, epoch, instanceId] = this.args as [string, string, string, string, string, number, number, string];
      const row = this.db.attempts.get(attemptId);
      const session = this.db.sessionHistory.get(sessionId);
      return row && row.task_id === taskId && row.worker_id === workerId && row.session_id === sessionId
        && row.lease_token_hash === tokenHash && ["claimed", "running"].includes(row.status)
        && row.lease_expires_at > now
        && session?.worker_id === workerId && session.session_epoch === epoch && session.instance_id === instanceId
        && session.disconnected_at == null && session.lease_expires_at > now ? row as T : null;
    }
    if (sql.includes("FROM tasks WHERE task_id")) {
      const row = (this.db.tasks.get(String(this.args[0])) as T) ?? null;
      const callback = this.db.afterTaskLoad;
      this.db.afterTaskLoad = null;
      callback?.();
      return row;
    }
    if (sql.includes("FROM tasks") && sql.includes("status = 'queued'")) {
      const [poolId] = this.args as [string, number];
      const row = [...this.db.tasks.values()].find((candidate) =>
        candidate.status === "queued" && candidate.execution_pool_id === poolId);
      return (row as T) ?? null;
    }
    return null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    const sql = this.sql.replace(/\s+/g, " ");
    if (sql.includes("FROM artifact_upload_parts")) {
      const rows = [...(this.db.artifactParts.get(String(this.args[0]))?.values() ?? [])]
        .sort((left, right) => left.part_number - right.part_number);
      return { results: rows as T[] };
    }
    return { results: [] };
  }

  async run(): Promise<{ meta: { changes: number } }> {
    const sql = this.sql.replace(/\s+/g, " ");
    if (sql.startsWith("DELETE FROM worker_sessions_runtime")) {
      this.db.sessions.delete(String(this.args[0]));
      return { meta: { changes: 1 } };
    }
    if (sql.includes("INSERT INTO worker_sessions_runtime")) {
      const [sessionId, workerId, poolId, namespace, instanceId, protocol, runtime, image, secretHash, epoch, connected, lease] = this.args as [string, string, string, string, string, string, string, string | null, string, number, number, number];
      const session = {
        session_id: sessionId, worker_id: workerId, pool_id: poolId, namespace, instance_id: instanceId,
        protocol_version: protocol, runtime_capability: runtime, image_digest: image, session_secret_hash: secretHash,
        session_epoch: epoch, connected_at: connected, last_seen_at: connected, lease_expires_at: lease, disconnected_at: null,
      };
      this.db.sessions.set(workerId, session);
      this.db.sessionHistory.set(sessionId, session);
      return { meta: { changes: 1 } };
    }
    if (sql.includes("UPDATE worker_sessions_runtime") && sql.includes("SET disconnected_at")) {
      const [workerId, sessionId, expectedEpoch, now] = this.args as [string, string, number, number];
      const row = this.db.sessionHistory.get(sessionId);
      if (!row || row.worker_id !== workerId || row.session_epoch !== expectedEpoch
        || (row.disconnected_at == null && row.lease_expires_at > now)) return { meta: { changes: 0 } };
      row.disconnected_at ??= now;
      row.lease_expires_at = Math.min(row.lease_expires_at, now);
      return { meta: { changes: 1 } };
    }
    if (sql.includes("UPDATE worker_sessions_runtime") && sql.includes("SET last_seen_at")) {
      const [sessionId, workerId, secretHash, now, lease, epoch, instanceId] = this.args as [string, string, string, number, number, number, string];
      const row = this.db.sessionHistory.get(sessionId);
      if (!row || row.worker_id !== workerId || row.session_secret_hash !== secretHash
        || row.session_epoch !== epoch || row.instance_id !== instanceId
        || row.lease_expires_at <= now || row.disconnected_at != null) return { meta: { changes: 0 } };
      row.last_seen_at = now;
      row.lease_expires_at = lease;
      return { meta: { changes: 1 } };
    }
    if (sql.includes("UPDATE workers SET last_seen_at")) {
      const row = this.db.workers.get(String(this.args[0]));
      if (!row || row.status !== "active") return { meta: { changes: 0 } };
      if (this.args.length >= 5) {
        const [, , sessionId, epoch, instanceId] = this.args as [string, number, string, number, string];
        const session = this.db.sessionHistory.get(sessionId);
        if (!session || session.worker_id !== row.worker_id || session.session_epoch !== epoch
          || session.instance_id !== instanceId || session.disconnected_at != null
          || session.lease_expires_at <= Number(this.args[1])) return { meta: { changes: 0 } };
      }
      row.last_seen_at = Number(this.args[1]);
      return { meta: { changes: 1 } };
    }
    if (sql.includes("INSERT INTO artifact_uploads")) {
      const [uploadId, taskId, attemptId, workerId, objectKey, name, kind, contentType, expectedSize, expectedSha, manifest, createdAt] = this.args as [string, string, string, string, string, string, string, string, number, string, string, number];
      this.db.artifactUploads.set(uploadId, { upload_id: uploadId, task_id: taskId, attempt_id: attemptId, worker_id: workerId, object_key: objectKey, name, kind, content_type: contentType, expected_size_bytes: expectedSize, expected_sha256: expectedSha, manifest_json: manifest, status: "open", finalize_owner: null, finalize_started_at: null, finalize_artifact_id: null, created_at: createdAt });
      this.db.artifactParts.set(uploadId, new Map());
      return { meta: { changes: 1 } };
    }
    if (sql.includes("INSERT OR REPLACE INTO artifact_upload_parts")) {
      const [uploadId, partNumber, etag, size, sha256, createdAt] = this.args as [string, number, string, number, string, number];
      const parts = this.db.artifactParts.get(uploadId) ?? new Map();
      parts.set(partNumber, { part_number: partNumber, etag, part_size_bytes: size, part_sha256: sha256, created_at: createdAt });
      this.db.artifactParts.set(uploadId, parts);
      return { meta: { changes: 1 } };
    }
    if (sql.includes("UPDATE artifact_uploads") && sql.includes("SET finalize_owner")) {
      if (sql.includes("SET finalize_owner = NULL")) {
        const [uploadId, owner] = this.args as [string, string];
        const row = this.db.artifactUploads.get(uploadId);
        if (!row || row.status !== "open" || row.finalize_owner !== owner) return { meta: { changes: 0 } };
        row.finalize_owner = null;
        row.finalize_started_at = null;
        return { meta: { changes: 1 } };
      }
      const [uploadId, owner, startedAt, , , , , , artifactId, staleBefore] = this.args as [string, string, number, string, string, string, string, string, string, number];
      const row = this.db.artifactUploads.get(uploadId);
      const task = row ? this.db.tasks.get(row.task_id) : null;
      if (!row || !task || task.cancel_requested_at != null || row.status !== "open" || (row.finalize_owner && row.finalize_started_at > staleBefore)) return { meta: { changes: 0 } };
      row.finalize_owner = owner;
      row.finalize_started_at = startedAt;
      row.finalize_artifact_id ??= artifactId;
      return { meta: { changes: 1 } };
    }
    if (sql.includes("UPDATE artifact_uploads SET status = 'completed'")) {
      const [uploadId, completedAt, , , , owner, artifactId] = this.args as [string, number, string, string, string, string, string];
      const row = this.db.artifactUploads.get(uploadId);
      const task = row ? this.db.tasks.get(row.task_id) : null;
      if (!row || task?.status !== "succeeded" || task.result_artifact_id !== artifactId || !["open", "completed"].includes(row.status) || (row.status === "open" && row.finalize_owner !== owner) || row.finalize_artifact_id !== artifactId) return { meta: { changes: 0 } };
      row.status = "completed";
      row.finalize_owner = null;
      row.finalize_started_at = null;
      row.completed_at = completedAt;
      return { meta: { changes: 1 } };
    }
    if (sql.includes("INTO artifacts")) {
      const [artifactId, taskId, name, kind, objectKey, size, sha256, contentType, createdAt, attemptId, workerId, manifest, uploadId] = this.args as [string, string, string, string, string, number, string, string, number, string, string, string, string];
      const upload = this.db.artifactUploads.get(uploadId);
      if (!upload || upload.status !== "completed") return { meta: { changes: 0 } };
      this.db.artifacts.set(uploadId, { artifact_id: artifactId, upload_id: uploadId, task_id: taskId, name, kind, object_key: objectKey, file_size_bytes: size, checksum_sha256: sha256, content_type: contentType, created_at: createdAt, attempt_id: attemptId, worker_id: workerId, manifest_json: manifest, status: "published", release_state: "published" });
      return { meta: { changes: 1 } };
    }
    if (sql.includes("UPDATE task_attempts SET status = 'succeeded'")) {
      const [attemptId] = this.args as [string];
      const row = this.db.attempts.get(attemptId);
      if (!row || !["claimed", "running", "succeeded"].includes(row.status)) return { meta: { changes: 0 } };
      row.status = "succeeded";
      return { meta: { changes: 1 } };
    }
    if (sql.includes("UPDATE task_attempts SET status = 'cancelled'")) {
      const [attemptId] = this.args as [string];
      const row = this.db.attempts.get(attemptId);
      if (!row || !["claimed", "running", "succeeded"].includes(row.status)) return { meta: { changes: 0 } };
      row.status = "cancelled";
      return { meta: { changes: 1 } };
    }
    if (sql.includes("UPDATE tasks SET status = 'cancelled'")) {
      const [taskId, attemptId] = this.args as [string, string];
      const row = this.db.tasks.get(taskId);
      if (!row || row.active_attempt_id !== attemptId || row.cancel_requested_at == null || !["claimed", "running"].includes(row.status)) return { meta: { changes: 0 } };
      row.status = "cancelled";
      row.result_artifact_id = null;
      row.active_attempt_id = null;
      return { meta: { changes: 1 } };
    }
    if (sql.includes("UPDATE artifact_uploads SET status = 'aborted'")) {
      const row = this.db.artifactUploads.get(String(this.args[0]));
      if (!row || !["open", "completed"].includes(row.status)) return { meta: { changes: 0 } };
      row.status = "aborted";
      row.finalize_owner = null;
      return { meta: { changes: 1 } };
    }
    if (sql.includes("DELETE FROM artifacts WHERE upload_id")) {
      return { meta: { changes: this.db.artifacts.delete(String(this.args[0])) ? 1 : 0 } };
    }
    if (sql.includes("UPDATE tasks SET status = 'succeeded'")) {
      const [taskId, artifactId, now, , workerId, , , sessionId, sessionEpoch, instanceId] = this.args as [string, string, number, string, string, number, string, string, number, string];
      const row = this.db.tasks.get(taskId);
      const session = this.db.sessionHistory.get(sessionId);
      if (!row || !row.active_attempt_id || row.cancel_requested_at != null || !["claimed", "running", "succeeded"].includes(row.status)
        || session?.worker_id !== workerId || session.session_epoch !== sessionEpoch || session.instance_id !== instanceId
        || session.disconnected_at != null || session.lease_expires_at <= now) return { meta: { changes: 0 } };
      row.status = "succeeded";
      (row as any).result_artifact_id = artifactId;
      return { meta: { changes: 1 } };
    }
    if (sql.includes("UPDATE tasks") && sql.includes("SET status = 'claimed'")) {
      const [taskId, attemptId, workerId, epoch, tokenHash, lease, now, poolId, expectedEpoch, sessionId, sessionEpoch, instanceId] = this.args as [string, string, string, number, string, number, number, string, number, string, number, string];
      const row = this.db.tasks.get(taskId);
      const session = this.db.sessionHistory.get(sessionId);
      if (!row || row.status !== "queued" || row.execution_pool_id !== poolId || row.lease_epoch !== expectedEpoch
        || session?.worker_id !== workerId || session.session_epoch !== sessionEpoch || session.instance_id !== instanceId
        || session.disconnected_at != null || session.lease_expires_at <= now) return { meta: { changes: 0 } };
      row.status = "claimed";
      row.attempt_count += 1;
      row.active_attempt_id = attemptId;
      row.lease_worker_id = workerId;
      row.lease_epoch = epoch;
      row.lease_token_hash = tokenHash;
      row.lease_expires_at = lease;
      return { meta: { changes: 1 } };
    }
    if (sql.includes("INSERT INTO task_attempts")) {
      const [attemptId, taskId, workerId, sessionId, attemptNumber, epoch, tokenHash, lease, now] = this.args as [string, string, string, string, number, number, string, number, number];
      const task = this.db.tasks.get(taskId);
      if (!task || task.active_attempt_id !== attemptId || task.lease_epoch !== epoch || task.status !== "claimed") return { meta: { changes: 0 } };
      this.db.attempts.set(attemptId, { attempt_id: attemptId, task_id: taskId, worker_id: workerId, session_id: sessionId, attempt_number: attemptNumber, fencing_epoch: epoch, lease_token_hash: tokenHash, lease_expires_at: lease, status: "claimed" });
      return { meta: { changes: 1 } };
    }
    if (sql.includes("INTO task_events")) {
      if (sql.includes("'task_claimed'")) {
        const attempt = this.db.attempts.get(String(this.args.at(-1)));
        if (!attempt || attempt.status !== "claimed") return { meta: { changes: 0 } };
      }
      this.db.events.push(String(this.args[0]));
      return { meta: { changes: 1 } };
    }
    if (sql.includes("INTO outbox_events")) {
      if (sql.includes("'task_claimed'")) {
        const attempt = this.db.attempts.get(String(this.args.at(-1)));
        if (!attempt || attempt.status !== "claimed") return { meta: { changes: 0 } };
      }
      this.db.outbox.push(String(this.args[1]));
      return { meta: { changes: 1 } };
    }
    if (sql.includes("UPDATE task_attempts SET lease_expires_at")) {
      const [attemptId, taskId, workerId, sessionId, tokenHash, lease, now, sessionEpoch, instanceId] = this.args as [string, string, string, string, string, number, number, number, string];
      const row = this.db.attempts.get(attemptId);
      const session = this.db.sessionHistory.get(sessionId);
      if (!row || row.task_id !== taskId || row.worker_id !== workerId || row.session_id !== sessionId || row.lease_token_hash !== tokenHash || row.lease_expires_at <= now
        || session?.session_epoch !== sessionEpoch || session.instance_id !== instanceId
        || session.disconnected_at != null || session.lease_expires_at <= now) return { meta: { changes: 0 } };
      row.lease_expires_at = lease;
      row.status = "running";
      return { meta: { changes: 1 } };
    }
    if (sql.includes("UPDATE tasks SET status = CASE")) {
      const [taskId, attemptId, workerId, tokenHash, epoch, lease, now, sessionId, sessionEpoch, instanceId] = this.args as [string, string, string, string, number, number, number, string, number, string];
      const row = this.db.tasks.get(taskId);
      const session = this.db.sessionHistory.get(sessionId);
      if (!row || row.active_attempt_id !== attemptId || row.lease_worker_id !== workerId || row.lease_token_hash !== tokenHash || row.lease_epoch !== epoch || row.lease_expires_at == null || row.lease_expires_at <= now
        || session?.worker_id !== workerId || session.session_epoch !== sessionEpoch || session.instance_id !== instanceId
        || session.disconnected_at != null || session.lease_expires_at <= now) return { meta: { changes: 0 } };
      row.status = "running";
      row.lease_expires_at = lease;
      return { meta: { changes: 1 } };
    }
    return { meta: { changes: 0 } };
  }
}

class MemoryBucket {
  readonly objects = new Map<string, Uint8Array>();
  readonly uploads = new Map<string, { key: string; parts: Map<number, Uint8Array> }>();
  private sequence = 0;
  failCompleteOnce = false;
  onStoredGet: (() => void) | null = null;

  async createMultipartUpload(key: string): Promise<any> {
    const uploadId = `upload-${++this.sequence}`;
    this.uploads.set(uploadId, { key, parts: new Map() });
    return this.multipart(uploadId);
  }

  resumeMultipartUpload(_key: string, uploadId: string): any {
    return this.multipart(uploadId);
  }

  private multipart(uploadId: string): any {
    const upload = this.uploads.get(uploadId)!;
    return {
      uploadId,
      abort: async () => { this.uploads.delete(uploadId); },
      uploadPart: async (partNumber: number, value: ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob) => {
        const bytes = await readBytes(value);
        upload.parts.set(partNumber, bytes);
        return { partNumber, etag: `${uploadId}-${partNumber}-${hashText(new TextDecoder().decode(bytes)).slice(0, 12)}` };
      },
      complete: async (parts: Array<{ partNumber: number; etag: string }>) => {
        if (this.failCompleteOnce) {
          this.failCompleteOnce = false;
          throw new Error("simulated uncertain multipart completion");
        }
        const chunks = parts.map((part) => upload.parts.get(part.partNumber) ?? new Uint8Array());
        const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
        const result = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
        this.objects.set(upload.key, result);
        return {};
      },
    };
  }

  async get(key: string): Promise<any> {
    const bytes = this.objects.get(key);
    if (!bytes) return null;
    const callback = this.onStoredGet;
    this.onStoredGet = null;
    callback?.();
    return { body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } }), writeHttpMetadata() {} };
  }

  async delete(key: string): Promise<void> { this.objects.delete(key); }
}

async function readBytes(value: ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob): Promise<Uint8Array> {
  if (value instanceof ReadableStream) {
    const reader = value.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value instanceof Uint8Array ? next.value : new Uint8Array(next.value);
      chunks.push(chunk);
      size += chunk.byteLength;
    }
    const result = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return result;
  }
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

function envFor(db: RuntimeFakeD1, bucket?: MemoryBucket): any {
  return {
    DB: db,
    TASK_ARTIFACT_MAX_BYTES: "2147483648",
    RESOURCE_BUCKET: bucket,
  };
}

function authHeaders(workerId: string, credential: string, instanceId: string, session: Session, extra: Record<string, string> = {}): Headers {
  return new Headers({
    authorization: `Bearer ${credential}`,
    "x-worker-id": workerId,
    "x-worker-instance-id": instanceId,
    "x-worker-session-id": session.session_id,
    "x-worker-session-epoch": String(session.session_epoch),
    "x-worker-protocol-version": "2",
    "x-worker-runtime-capability": "goal-driven-claude-code",
    ...extra,
  });
}

async function connect(db: RuntimeFakeD1, workerId: string, credential: string, instanceId: string): Promise<{ response: Response; session: Session }> {
  const response = await handleWorkerV2(new Request("https://app.test/api/worker/v2/connect", {
    method: "POST",
    headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
    body: JSON.stringify({ worker_id: workerId, instance_id: instanceId, protocol_version: "2", runtime_capability: "goal-driven-claude-code" }),
  }), envFor(db));
  const session = db.sessions.get(workerId)!;
  return { response: response!, session };
}

describe("Worker v2 control plane", () => {
  it("performs reverse handshake and rejects a second live instance", async () => {
    const db = new RuntimeFakeD1();
    const credential = "wc_test-persistent-credential";
    db.workers.set("worker-b", {
      worker_id: "worker-b", pool_id: "public-default", namespace: "infinity-public", created_by: "user-a",
      credential_hash: hashText(credential), status: "active", protocol_version: "2", runtime_capability: "goal-driven-claude-code", image_digest: null, last_seen_at: null,
    });
    const first = await connect(db, "worker-b", credential, "machine-a");
    expect(first.response.status).toBe(201);
    const second = await connect(db, "worker-b", credential, "machine-b");
    expect(second.response.status).toBe(409);
    expect(await second.response.json()).toMatchObject({ error: { code: "WORKER_ALREADY_CONNECTED" } });
  });

  it("creates an immutable replacement session without deleting Attempt history", async () => {
    const db = new RuntimeFakeD1();
    const credential = "wc_test-persistent-credential";
    db.workers.set("worker-b", {
      worker_id: "worker-b", pool_id: "public-default", namespace: "infinity-public", created_by: "user-a",
      credential_hash: hashText(credential), status: "active", protocol_version: "2", runtime_capability: "goal-driven-claude-code", image_digest: null, last_seen_at: null,
    });
    const first = await connect(db, "worker-b", credential, "machine-a");
    expect(first.response.status).toBe(201);
    const originalSessionId = first.session.session_id;
    const originalEpoch = first.session.session_epoch;
    db.attempts.set("attempt-history", {
      attempt_id: "attempt-history", task_id: "task-history", worker_id: "worker-b",
      session_id: originalSessionId, attempt_number: 1, fencing_epoch: 1,
      lease_token_hash: "historical", lease_expires_at: 0, status: "succeeded",
    });
    first.session.lease_expires_at = 0;

    const reconnected = await connect(db, "worker-b", credential, "machine-b");

    expect(reconnected.response.status).toBe(201);
    expect(reconnected.session.session_id).not.toBe(originalSessionId);
    expect(reconnected.session.session_epoch).toBe(originalEpoch + 1);
    expect(reconnected.session.instance_id).toBe("machine-b");
    expect(db.attempts.get("attempt-history")?.session_id).toBe(originalSessionId);
    expect(db.sessionHistory.get(originalSessionId)).toMatchObject({
      instance_id: "machine-a",
      session_epoch: originalEpoch,
      disconnected_at: expect.any(Number),
    });

    const staleEpochHeaders = authHeaders("worker-b", credential, "machine-b", reconnected.session);
    staleEpochHeaders.set("x-worker-session-epoch", String(originalEpoch));
    const staleEpoch = await handleWorkerV2(new Request("https://app.test/api/worker/v2/heartbeat", {
      method: "POST",
      headers: staleEpochHeaders,
    }), envFor(db));
    expect(staleEpoch?.status).toBe(409);
    expect(await staleEpoch?.json()).toMatchObject({ error: { code: "WORKER_SESSION_STALE" } });

    const compatibleHeaders = authHeaders("worker-b", credential, "machine-b", reconnected.session);
    compatibleHeaders.delete("x-worker-session-epoch");
    const compatible = await handleWorkerV2(new Request("https://app.test/api/worker/v2/heartbeat", {
      method: "POST",
      headers: compatibleHeaders,
    }), envFor(db));
    expect(compatible?.status).toBe(200);
  });

  it("atomically rejects a stale accept after authentication races a reconnect", async () => {
    const db = new RuntimeFakeD1();
    const credential = "wc_test-persistent-credential";
    db.workers.set("worker-b", {
      worker_id: "worker-b", pool_id: "public-default", namespace: "infinity-public", created_by: "user-a",
      credential_hash: hashText(credential), status: "active", protocol_version: "2", runtime_capability: "goal-driven-claude-code", image_digest: null, last_seen_at: null,
    });
    db.tasks.set("task-race", {
      task_id: "task-race", task_spec_id: "spec-race", dataset_snapshot_id: "dataset-race", method_source_id: null,
      title: "Reconnect race", attempt_count: 0, max_attempts: 3, lease_epoch: 0, status: "queued",
      execution_pool_id: "public-default", active_attempt_id: null, lease_worker_id: null,
      lease_token_hash: null, lease_expires_at: null,
    });
    const connected = await connect(db, "worker-b", credential, "machine-a");
    const oldSession = connected.session;
    const oldHeaders = authHeaders("worker-b", credential, "machine-a", oldSession);
    db.afterTaskLoad = () => {
      oldSession.disconnected_at = 1;
      oldSession.lease_expires_at = 0;
      const replacement: Session = {
        ...oldSession,
        session_id: "ws_replacement-session",
        instance_id: "machine-b",
        session_secret_hash: hashText("ws_replacement-session"),
        session_epoch: oldSession.session_epoch + 1,
        connected_at: oldSession.connected_at + 1,
        last_seen_at: oldSession.last_seen_at + 1,
        lease_expires_at: oldSession.last_seen_at + 1000,
        disconnected_at: null,
      };
      db.sessions.set("worker-b", replacement);
      db.sessionHistory.set(replacement.session_id, replacement);
    };

    const raced = await handleWorkerV2(new Request("https://app.test/api/worker/v2/tasks/task-race/accept", {
      method: "POST",
      headers: oldHeaders,
    }), envFor(db));

    expect(raced?.status).toBe(409);
    expect(await raced?.json()).toMatchObject({ error: { code: "TASK_CLAIM_CONFLICT" } });
    expect(db.tasks.get("task-race")?.status).toBe("queued");
    expect(db.attempts.size).toBe(0);
    expect(db.events).toEqual([]);
    expect(db.outbox).toEqual([]);
  });

  it("lets a public Worker claim another user's queued task exactly once", async () => {
    const db = new RuntimeFakeD1();
    const credential = "wc_test-persistent-credential";
    db.workers.set("worker-b", {
      worker_id: "worker-b", pool_id: "public-default", namespace: "infinity-public", created_by: "worker-owner",
      credential_hash: hashText(credential), status: "active", protocol_version: "2", runtime_capability: "goal-driven-claude-code", image_digest: null, last_seen_at: null,
    });
    db.tasks.set("task-owner-b", {
      task_id: "task-owner-b", task_spec_id: "spec-1", dataset_snapshot_id: "dataset-1", method_source_id: null,
      title: "Alice's task", attempt_count: 0, max_attempts: 3, lease_epoch: 0, status: "queued", execution_pool_id: "public-default",
      active_attempt_id: null, lease_worker_id: null, lease_token_hash: null, lease_expires_at: null,
    });
    const connected = await connect(db, "worker-b", credential, "machine-a");
    const headers = authHeaders("worker-b", credential, "machine-a", connected.session);
    const poll = await handleWorkerV2(new Request("https://app.test/api/worker/v2/poll", { method: "POST", headers }), envFor(db));
    expect(poll?.status).toBe(200);
    const pollPayload = await poll!.json();
    expect(pollPayload).toMatchObject({ tasks: [{ task_id: "task-owner-b", pool_id: "public-default" }] });
    expect(JSON.stringify(pollPayload)).not.toContain("created_by");

    const accept = await handleWorkerV2(new Request("https://app.test/api/worker/v2/tasks/task-owner-b/accept", { method: "POST", headers }), envFor(db));
    expect(accept?.status).toBe(201);
    const accepted = await accept!.json() as { attempt_id: string; lease_token: string; fencing_epoch: number };
    expect(accepted.fencing_epoch).toBe(1);
    expect(db.attempts.get(accepted.attempt_id)?.worker_id).toBe("worker-b");

    const secondAccept = await handleWorkerV2(new Request("https://app.test/api/worker/v2/tasks/task-owner-b/accept", { method: "POST", headers }), envFor(db));
    expect(secondAccept?.status).toBe(409);
    expect(await secondAccept?.json()).toMatchObject({ error: { code: "TASK_NOT_AVAILABLE" } });

    const renewed = await handleWorkerV2(new Request("https://app.test/api/worker/v2/tasks/task-owner-b/renew", {
      method: "POST",
      headers: new Headers({ ...Object.fromEntries(headers.entries()), "x-worker-attempt-id": accepted.attempt_id, "x-worker-lease-token": accepted.lease_token }),
    }), envFor(db));
    expect(renewed?.status).toBe(200);

    const forgedPool = new Headers(headers);
    forgedPool.set("x-worker-namespace", "someone-else");
    const rejected = await handleWorkerV2(new Request("https://app.test/api/worker/v2/heartbeat", { method: "POST", headers: forgedPool }), envFor(db));
    expect(rejected?.status).toBe(403);
    expect(await rejected?.json()).toMatchObject({ error: { code: "WORKER_POOL_MISMATCH" } });
  });

  it("streams an artifact part and finalizes it with an independent checksum", async () => {
    const db = new RuntimeFakeD1();
    const bucket = new MemoryBucket();
    const credential = "wc_test-persistent-credential";
    db.workers.set("worker-b", {
      worker_id: "worker-b", pool_id: "public-default", namespace: "infinity-public", created_by: "worker-owner",
      credential_hash: hashText(credential), status: "active", protocol_version: "2", runtime_capability: "goal-driven-claude-code", image_digest: null, last_seen_at: null,
    });
    db.tasks.set("task-artifact", {
      task_id: "task-artifact", task_spec_id: "spec-1", dataset_snapshot_id: "dataset-1", method_source_id: null,
      title: "Artifact task", attempt_count: 0, max_attempts: 3, lease_epoch: 0, status: "queued", execution_pool_id: "public-default",
      active_attempt_id: null, lease_worker_id: null, lease_token_hash: null, lease_expires_at: null,
    });
    const connected = await connect(db, "worker-b", credential, "machine-a");
    const headers = authHeaders("worker-b", credential, "machine-a", connected.session);
    const accept = await handleWorkerV2(new Request("https://app.test/api/worker/v2/tasks/task-artifact/accept", { method: "POST", headers }), envFor(db));
    const accepted = await accept!.json() as { attempt_id: string; lease_token: string };
    const bytes = new TextEncoder().encode("streamed artifact\n");
    const startHeaders = new Headers(headers);
    startHeaders.set("content-type", "application/json");
    startHeaders.set("x-worker-attempt-id", accepted.attempt_id);
    startHeaders.set("x-worker-lease-token", accepted.lease_token);
    const started = await handleWorkerV2(new Request("https://app.test/api/worker/v2/tasks/task-artifact/artifacts/start", {
      method: "POST",
      headers: startHeaders,
      body: JSON.stringify({ name: "result.zip", kind: "result", content_type: "application/zip", expected_size_bytes: bytes.byteLength, expected_sha256: hashText(new TextDecoder().decode(bytes)), manifest: { files: ["result.txt"] } }),
    }), envFor(db, bucket));
    expect(started?.status).toBe(201);
    const startedPayload = await started!.json() as { upload_id: string };

    const partHeaders = new Headers(headers);
    partHeaders.set("x-worker-attempt-id", accepted.attempt_id);
    partHeaders.set("x-worker-lease-token", accepted.lease_token);
    partHeaders.set("content-length", String(bytes.byteLength));
    const uploaded = await handleWorkerV2(new Request(`https://app.test/api/worker/v2/artifacts/${startedPayload.upload_id}/parts/1`, {
      method: "PUT", headers: partHeaders, body: bytes,
    }), envFor(db, bucket));
    expect(uploaded?.status).toBe(200);
    const partPayload = await uploaded!.json() as { etag: string };

    const completeHeaders = new Headers(startHeaders);
    const uploadRow = db.artifactUploads.get(startedPayload.upload_id)!;
    const taskUnderTest = db.tasks.get("task-artifact")!;
    taskUnderTest.cancel_requested_at = Date.now();
    const cancelledFinalize = await handleWorkerV2(new Request(`https://app.test/api/worker/v2/artifacts/${startedPayload.upload_id}/complete`, {
      method: "POST",
      headers: completeHeaders,
      body: JSON.stringify({ attempt_id: accepted.attempt_id, lease_token: accepted.lease_token, parts: [{ part_number: 1, etag: partPayload.etag }] }),
    }), envFor(db, bucket));
    expect(cancelledFinalize?.status).toBe(409);
    taskUnderTest.cancel_requested_at = null;
    uploadRow.finalize_owner = "dead-finalizer";
    uploadRow.finalize_started_at = 1;
    uploadRow.finalize_artifact_id = "stable-artifact-id";
    bucket.failCompleteOnce = true;
    const failedOnce = await handleWorkerV2(new Request(`https://app.test/api/worker/v2/artifacts/${startedPayload.upload_id}/complete`, {
      method: "POST",
      headers: completeHeaders,
      body: JSON.stringify({ attempt_id: accepted.attempt_id, lease_token: accepted.lease_token, parts: [{ part_number: 1, etag: partPayload.etag }] }),
    }), envFor(db, bucket));
    expect(failedOnce?.status).toBe(503);
    expect(uploadRow.finalize_owner).toBeNull();

    const completed = await handleWorkerV2(new Request(`https://app.test/api/worker/v2/artifacts/${startedPayload.upload_id}/complete`, {
      method: "POST",
      headers: completeHeaders,
      body: JSON.stringify({ attempt_id: accepted.attempt_id, lease_token: accepted.lease_token, parts: [{ part_number: 1, etag: partPayload.etag }] }),
    }), envFor(db, bucket));
    expect(completed?.status).toBe(201);
    expect(await completed?.json()).toMatchObject({ artifact_id: "stable-artifact-id", status: "published", file_size_bytes: bytes.byteLength });
    expect(db.tasks.get("task-artifact")?.status).toBe("succeeded");
    expect(bucket.objects.size).toBe(1);

    const duplicate = await handleWorkerV2(new Request(`https://app.test/api/worker/v2/artifacts/${startedPayload.upload_id}/complete`, {
      method: "POST",
      headers: completeHeaders,
      body: JSON.stringify({ attempt_id: accepted.attempt_id, lease_token: accepted.lease_token, parts: [{ part_number: 1, etag: partPayload.etag }] }),
    }), envFor(db, bucket));
    expect(duplicate?.status).toBe(200);
    expect(await duplicate?.json()).toMatchObject({ status: "published", duplicate: true });
    expect(bucket.objects.size).toBe(1);

    // Simulate an interrupted D1 metadata batch after Artifact/Attempt were
    // published but before the Task transition. The same fenced caller must
    // reconcile instead of reporting a false duplicate or deleting R2.
    const taskRow = db.tasks.get("task-artifact")!;
    taskRow.status = "running";
    taskRow.result_artifact_id = null;
    db.events.length = 0;
    db.outbox.length = 0;
    const reconciled = await handleWorkerV2(new Request(`https://app.test/api/worker/v2/artifacts/${startedPayload.upload_id}/complete`, {
      method: "POST",
      headers: completeHeaders,
      body: JSON.stringify({ attempt_id: accepted.attempt_id, lease_token: accepted.lease_token, parts: [{ part_number: 1, etag: partPayload.etag }] }),
    }), envFor(db, bucket));
    expect(reconciled?.status).toBe(201);
    expect(taskRow.status).toBe("succeeded");
    expect(taskRow.result_artifact_id).toBe("stable-artifact-id");
    expect(db.events).toContain(`task-succeeded:${accepted.attempt_id}`);
    expect(db.outbox).toContain(`task-succeeded:${accepted.attempt_id}`);
    expect(bucket.objects.size).toBe(1);

    // Cancellation that arrives after finalize ownership/R2 completion but
    // before the D1 success decision must win and remove only the unpublished
    // second object.
    taskRow.status = "running";
    taskRow.active_attempt_id = accepted.attempt_id;
    taskRow.result_artifact_id = null;
    taskRow.cancel_requested_at = null;
    db.attempts.get(accepted.attempt_id)!.status = "running";
    const startedAfterReset = await handleWorkerV2(new Request("https://app.test/api/worker/v2/tasks/task-artifact/artifacts/start", {
      method: "POST",
      headers: startHeaders,
      body: JSON.stringify({ name: "cancelled.zip", kind: "result", content_type: "application/zip", expected_size_bytes: bytes.byteLength, expected_sha256: hashText(new TextDecoder().decode(bytes)), manifest: {} }),
    }), envFor(db, bucket));
    const secondUpload = await startedAfterReset!.json() as { upload_id: string };
    const secondPart = await handleWorkerV2(new Request(`https://app.test/api/worker/v2/artifacts/${secondUpload.upload_id}/parts/1`, {
      method: "PUT", headers: partHeaders, body: bytes,
    }), envFor(db, bucket));
    const secondPartPayload = await secondPart!.json() as { etag: string };
    bucket.onStoredGet = () => { taskRow.cancel_requested_at = Date.now(); };
    const cancelledAfterClaim = await handleWorkerV2(new Request(`https://app.test/api/worker/v2/artifacts/${secondUpload.upload_id}/complete`, {
      method: "POST",
      headers: completeHeaders,
      body: JSON.stringify({ attempt_id: accepted.attempt_id, lease_token: accepted.lease_token, parts: [{ part_number: 1, etag: secondPartPayload.etag }] }),
    }), envFor(db, bucket));
    expect(cancelledAfterClaim?.status).toBe(409);
    expect(await cancelledAfterClaim?.json()).toMatchObject({ error: { code: "TASK_CANCELLED_DURING_FINALIZE" } });
    expect(taskRow.status).toBe("cancelled");
    expect(db.artifactUploads.get(secondUpload.upload_id)?.status).toBe("aborted");
    expect(bucket.objects.size).toBe(1);
  });
});
