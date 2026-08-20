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
  readonly tasks = new Map<string, Task>();
  readonly attempts = new Map<string, Attempt>();
  readonly events: string[] = [];
  readonly outbox: string[] = [];
  readonly artifactUploads = new Map<string, any>();
  readonly artifactParts = new Map<string, Map<number, any>>();
  readonly artifacts = new Map<string, any>();
  readonly policy = { pool_id: "public-default", namespace: "infinity-public", mode: "public" as const };

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
      const row = [...this.db.sessions.values()].find((candidate) =>
        candidate.session_id === sessionId && candidate.worker_id === workerId
          && candidate.lease_expires_at > now && candidate.disconnected_at == null);
      return (row as T) ?? null;
    }
    if (sql.includes("FROM artifact_uploads WHERE upload_id")) {
      const [uploadId, workerId] = this.args as [string, string];
      const row = this.db.artifactUploads.get(uploadId);
      return row && row.worker_id === workerId ? row as T : null;
    }
    if (sql.includes("FROM artifacts WHERE upload_id")) {
      return (this.db.artifacts.get(String(this.args[0])) as T) ?? null;
    }
    if (sql.includes("FROM task_attempts")) {
      const [attemptId, taskId, workerId, sessionId, tokenHash, now] = this.args as [string, string, string, string, string, number];
      const row = this.db.attempts.get(attemptId);
      return row && row.task_id === taskId && row.worker_id === workerId && row.session_id === sessionId
        && row.lease_token_hash === tokenHash && ["claimed", "running"].includes(row.status)
        && row.lease_expires_at > now ? row as T : null;
    }
    if (sql.includes("FROM tasks WHERE task_id")) {
      return (this.db.tasks.get(String(this.args[0])) as T) ?? null;
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
      this.db.sessions.set(workerId, {
        session_id: sessionId, worker_id: workerId, pool_id: poolId, namespace, instance_id: instanceId,
        protocol_version: protocol, runtime_capability: runtime, image_digest: image, session_secret_hash: secretHash,
        session_epoch: epoch, connected_at: connected, last_seen_at: connected, lease_expires_at: lease, disconnected_at: null,
      });
      return { meta: { changes: 1 } };
    }
    if (sql.includes("UPDATE worker_sessions_runtime") && sql.includes("SET last_seen_at")) {
      const [sessionId, workerId, secretHash, now, lease] = this.args as [string, string, string, number, number];
      const row = [...this.db.sessions.values()].find((candidate) => candidate.session_id === sessionId && candidate.worker_id === workerId);
      if (!row || row.session_secret_hash !== secretHash || row.lease_expires_at <= now || row.disconnected_at != null) return { meta: { changes: 0 } };
      row.last_seen_at = now;
      row.lease_expires_at = lease;
      return { meta: { changes: 1 } };
    }
    if (sql.includes("UPDATE workers SET last_seen_at")) {
      const row = this.db.workers.get(String(this.args[0]));
      if (!row || row.status !== "active") return { meta: { changes: 0 } };
      row.last_seen_at = Number(this.args[1]);
      return { meta: { changes: 1 } };
    }
    if (sql.includes("INSERT INTO artifact_uploads")) {
      const [uploadId, taskId, attemptId, workerId, objectKey, name, kind, contentType, expectedSize, expectedSha, manifest, createdAt] = this.args as [string, string, string, string, string, string, string, string, number, string, string, number];
      this.db.artifactUploads.set(uploadId, { upload_id: uploadId, task_id: taskId, attempt_id: attemptId, worker_id: workerId, object_key: objectKey, name, kind, content_type: contentType, expected_size_bytes: expectedSize, expected_sha256: expectedSha, manifest_json: manifest, status: "open", created_at: createdAt });
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
    if (sql.includes("UPDATE artifact_uploads SET status = 'completed'")) {
      const [uploadId, completedAt] = this.args as [string, number];
      const row = this.db.artifactUploads.get(uploadId);
      if (!row || row.status !== "open") return { meta: { changes: 0 } };
      row.status = "completed";
      row.completed_at = completedAt;
      return { meta: { changes: 1 } };
    }
    if (sql.includes("INSERT INTO artifacts")) {
      const [artifactId, taskId, name, kind, objectKey, size, sha256, contentType, createdAt, attemptId, workerId, manifest, uploadId] = this.args as [string, string, string, string, string, number, string, string, number, string, string, string, string];
      const upload = this.db.artifactUploads.get(uploadId);
      if (!upload || upload.status !== "completed") return { meta: { changes: 0 } };
      this.db.artifacts.set(uploadId, { artifact_id: artifactId, upload_id: uploadId, task_id: taskId, name, kind, object_key: objectKey, file_size_bytes: size, checksum_sha256: sha256, content_type: contentType, created_at: createdAt, attempt_id: attemptId, worker_id: workerId, manifest_json: manifest, status: "published", release_state: "published" });
      return { meta: { changes: 1 } };
    }
    if (sql.includes("UPDATE task_attempts SET status = 'succeeded'")) {
      const [attemptId] = this.args as [string];
      const row = this.db.attempts.get(attemptId);
      if (!row || !["claimed", "running"].includes(row.status)) return { meta: { changes: 0 } };
      row.status = "succeeded";
      return { meta: { changes: 1 } };
    }
    if (sql.includes("UPDATE tasks SET status = 'succeeded'")) {
      const [taskId, artifactId] = this.args as [string, string];
      const row = this.db.tasks.get(taskId);
      if (!row || !row.active_attempt_id || row.status === "succeeded") return { meta: { changes: 0 } };
      row.status = "succeeded";
      (row as any).result_artifact_id = artifactId;
      return { meta: { changes: 1 } };
    }
    if (sql.includes("UPDATE tasks") && sql.includes("SET status = 'claimed'")) {
      const [taskId, attemptId, workerId, epoch, tokenHash, lease, now, poolId, expectedEpoch] = this.args as [string, string, string, number, string, number, number, string, number];
      const row = this.db.tasks.get(taskId);
      if (!row || row.status !== "queued" || row.execution_pool_id !== poolId || row.lease_epoch !== expectedEpoch) return { meta: { changes: 0 } };
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
    if (sql.includes("INSERT INTO task_events")) { this.db.events.push(String(this.args[0])); return { meta: { changes: 1 } }; }
    if (sql.includes("INSERT INTO outbox_events")) { this.db.outbox.push(String(this.args[0])); return { meta: { changes: 1 } }; }
    if (sql.includes("UPDATE task_attempts SET lease_expires_at")) {
      const [attemptId, taskId, workerId, sessionId, tokenHash, lease, now] = this.args as [string, string, string, string, string, number, number];
      const row = this.db.attempts.get(attemptId);
      if (!row || row.task_id !== taskId || row.worker_id !== workerId || row.session_id !== sessionId || row.lease_token_hash !== tokenHash || row.lease_expires_at <= now) return { meta: { changes: 0 } };
      row.lease_expires_at = lease;
      row.status = "running";
      return { meta: { changes: 1 } };
    }
    if (sql.includes("UPDATE tasks SET status = CASE")) {
      const [taskId, attemptId, workerId, tokenHash, epoch, lease, now] = this.args as [string, string, string, string, number, number, number];
      const row = this.db.tasks.get(taskId);
      if (!row || row.active_attempt_id !== attemptId || row.lease_worker_id !== workerId || row.lease_token_hash !== tokenHash || row.lease_epoch !== epoch || row.lease_expires_at == null || row.lease_expires_at <= now) return { meta: { changes: 0 } };
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
    const completed = await handleWorkerV2(new Request(`https://app.test/api/worker/v2/artifacts/${startedPayload.upload_id}/complete`, {
      method: "POST",
      headers: completeHeaders,
      body: JSON.stringify({ attempt_id: accepted.attempt_id, lease_token: accepted.lease_token, parts: [{ part_number: 1, etag: partPayload.etag }] }),
    }), envFor(db, bucket));
    expect(completed?.status).toBe(201);
    expect(await completed?.json()).toMatchObject({ status: "published", file_size_bytes: bytes.byteLength });
    expect(db.tasks.get("task-artifact")?.status).toBe("succeeded");
    expect(bucket.objects.size).toBe(1);
  });
});
