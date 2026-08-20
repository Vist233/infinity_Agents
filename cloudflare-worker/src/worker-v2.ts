import type { Env } from "./env";
import { errorJson, json, nowSeconds } from "./http";
import { hashReadableStream, hashText, Sha256 } from "./sha256";

const WORKER_V2_PREFIX = "/api/worker/v2";
const PROTOCOL_VERSION = "2";
const RUNTIME_CAPABILITY = "goal-driven-claude-code";
const SESSION_TTL_SECONDS = 90;
const MAX_POLL_RESULTS = 1;
const MAX_PART_BYTES = 16 * 1024 * 1024;
const MAX_ARTIFACT_MANIFEST_BYTES = 256 * 1024;
const MAX_ERROR_LENGTH = 500;
const WORKER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

type D1RunResult = { meta?: { changes?: number } };

interface WorkerRow {
  worker_id: string;
  pool_id: string;
  namespace: string;
  created_by: string;
  credential_hash: string;
  status: "active" | "draining" | "revoked";
  protocol_version: string;
  runtime_capability: string;
  image_digest: string | null;
  last_seen_at: number | null;
}

interface PoolPolicyRow {
  pool_id: string;
  namespace: string;
  mode: "public";
}

interface SessionRow {
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
}

interface WorkerContext {
  worker: WorkerRow;
  policy: PoolPolicyRow;
  session: SessionRow;
  credentialHash: string;
}

interface AttemptRow {
  attempt_id: string;
  task_id: string;
  worker_id: string;
  session_id: string;
  fencing_epoch: number;
  lease_expires_at: number;
  status: string;
}

interface TaskQueueRow {
  task_id: string;
  task_spec_id: string;
  dataset_snapshot_id: string;
  method_source_id: string | null;
  title: string;
  attempt_count: number;
  max_attempts: number;
}

interface ArtifactUploadRow {
  upload_id: string;
  task_id: string;
  attempt_id: string;
  worker_id: string;
  object_key: string;
  name: string;
  kind: string;
  content_type: string;
  expected_size_bytes: number;
  expected_sha256: string;
  manifest_json: string;
  status: "open" | "completed" | "aborted";
}

interface ArtifactPartRow {
  part_number: number;
  etag: string;
  part_size_bytes: number;
  part_sha256: string;
}

function changed(result: unknown): number {
  return Number((result as D1RunResult | null | undefined)?.meta?.changes ?? 0);
}

function newToken(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `${prefix}_${btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")}`;
}

function safeTaskId(value: string): boolean {
  return WORKER_ID_PATTERN.test(value);
}

function safePartNumber(value: string): number | null {
  if (!/^\d{1,6}$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

async function bodyJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const value = await request.json();
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function stringValue(body: Record<string, unknown> | null, key: string): string {
  return typeof body?.[key] === "string" ? body[key]!.trim() : "";
}

function rejectClientControlledFields(body: Record<string, unknown> | null): Response | null {
  const forbidden = [
    "namespace", "pool_id", "pool", "provider", "provider_id", "trust_level",
    "worker_kind", "created_by", "owner_user_id", "redis_url", "database_url",
    "account_token", "r2_prefix", "d1_database_id",
  ];
  if (forbidden.some((key) => Object.prototype.hasOwnProperty.call(body ?? {}, key))) {
    return errorJson("Worker infrastructure fields are server-controlled", 400, "WORKER_METADATA_FORBIDDEN");
  }
  return null;
}

function bearerCredential(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return null;
  const value = header.slice("Bearer ".length).trim();
  return value.length >= 16 && value.length <= 512 ? value : null;
}

function errorMessage(value: unknown, fallback: string): string {
  const text = String(value ?? fallback).replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return (text || fallback).slice(0, MAX_ERROR_LENGTH);
}

async function loadPolicy(env: Env): Promise<PoolPolicyRow | null> {
  return env.DB.prepare(
    "SELECT pool_id, namespace, mode FROM worker_pool_policy WHERE policy_id = 1 AND mode = 'public'",
  ).first<PoolPolicyRow>();
}

async function loadWorker(env: Env, workerId: string, credential: string): Promise<{ row: WorkerRow; hash: string } | null> {
  const hash = hashText(credential);
  const row = await env.DB.prepare(
    `SELECT worker_id, pool_id, namespace, created_by, credential_hash, status,
            protocol_version, runtime_capability, image_digest, last_seen_at
     FROM workers WHERE worker_id = ?1 AND credential_hash = ?2`,
  ).bind(workerId, hash).first<WorkerRow>();
  if (!row || row.status === "revoked") return null;
  return { row, hash };
}

function validateProtocolHeaders(request: Request, worker: WorkerRow): Response | null {
  const protocol = request.headers.get("x-worker-protocol-version");
  const runtime = request.headers.get("x-worker-runtime-capability");
  const image = request.headers.get("x-worker-image-digest");
  if (protocol !== worker.protocol_version || protocol !== PROTOCOL_VERSION) {
    return errorJson("Worker protocol is incompatible", 409, "WORKER_PROTOCOL_INCOMPATIBLE");
  }
  if (runtime !== worker.runtime_capability || runtime !== RUNTIME_CAPABILITY) {
    return errorJson("Worker runtime is incompatible", 409, "WORKER_RUNTIME_INCOMPATIBLE");
  }
  if (worker.image_digest && image !== worker.image_digest) {
    return errorJson("Worker image is incompatible", 409, "WORKER_IMAGE_INCOMPATIBLE");
  }
  return null;
}

async function authenticateSession(request: Request, env: Env): Promise<WorkerContext | Response> {
  const workerId = request.headers.get("x-worker-id")?.trim() ?? "";
  const instanceId = request.headers.get("x-worker-instance-id")?.trim() ?? "";
  const sessionId = request.headers.get("x-worker-session-id")?.trim() ?? "";
  const credential = bearerCredential(request);
  if (!workerId || !WORKER_ID_PATTERN.test(workerId) || !instanceId || !sessionId || !credential) {
    return errorJson("Worker credentials and session headers are required", 401, "WORKER_AUTH_REQUIRED");
  }
  const loaded = await loadWorker(env, workerId, credential);
  if (!loaded) return errorJson("Worker credential is invalid or revoked", 401, "WORKER_AUTH_INVALID");
  const policy = await loadPolicy(env);
  if (!policy || loaded.row.pool_id !== policy.pool_id || loaded.row.namespace !== policy.namespace) {
    return errorJson("Worker pool is not configured", 503, "WORKER_POOL_UNAVAILABLE");
  }
  const protocolError = validateProtocolHeaders(request, loaded.row);
  if (protocolError) return protocolError;
  const suppliedNamespace = request.headers.get("x-worker-namespace");
  const suppliedPool = request.headers.get("x-worker-pool-id");
  if ((suppliedNamespace && suppliedNamespace !== policy.namespace)
    || (suppliedPool && suppliedPool !== policy.pool_id)) {
    return errorJson("Worker pool metadata does not match the server binding", 403, "WORKER_POOL_MISMATCH");
  }
  const session = await env.DB.prepare(
    `SELECT session_id, worker_id, pool_id, namespace, instance_id,
            protocol_version, runtime_capability, image_digest,
            session_secret_hash, session_epoch, connected_at, last_seen_at,
            lease_expires_at, disconnected_at
     FROM worker_sessions_runtime
     WHERE session_id = ?1 AND worker_id = ?2 AND lease_expires_at > ?3
       AND disconnected_at IS NULL`,
  ).bind(sessionId, workerId, nowSeconds()).first<SessionRow>();
  if (!session || session.session_secret_hash !== hashText(sessionId)) {
    return errorJson("Worker session is expired or invalid", 401, "WORKER_SESSION_INVALID");
  }
  if (session.instance_id !== instanceId || session.pool_id !== policy.pool_id || session.namespace !== policy.namespace) {
    return errorJson("Worker session binding is invalid", 403, "WORKER_SESSION_MISMATCH");
  }
  const epochHeader = request.headers.get("x-worker-session-epoch");
  if (epochHeader && Number(epochHeader) !== session.session_epoch) {
    return errorJson("Worker session epoch is stale", 409, "WORKER_SESSION_STALE");
  }
  return { worker: loaded.row, policy, session, credentialHash: loaded.hash };
}

async function touchSession(env: Env, context: WorkerContext, now = nowSeconds()): Promise<boolean> {
  const leaseExpiresAt = now + SESSION_TTL_SECONDS;
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE worker_sessions_runtime
       SET last_seen_at = ?4, lease_expires_at = ?5
       WHERE session_id = ?1 AND worker_id = ?2 AND session_secret_hash = ?3
         AND lease_expires_at > ?4 AND disconnected_at IS NULL`,
    ).bind(context.session.session_id, context.worker.worker_id, hashText(context.session.session_id), now, leaseExpiresAt),
    env.DB.prepare(
      "UPDATE workers SET last_seen_at = ?2, updated_at = ?2 WHERE worker_id = ?1 AND status = 'active'",
    ).bind(context.worker.worker_id, now),
  ]);
  return changed(results[0]) === 1;
}

async function connectWorker(request: Request, env: Env): Promise<Response> {
  const body = await bodyJson(request);
  const forbidden = rejectClientControlledFields(body);
  if (forbidden) return forbidden;
  const workerId = stringValue(body, "worker_id");
  const instanceId = stringValue(body, "instance_id");
  const protocolVersion = stringValue(body, "protocol_version");
  const runtimeCapability = stringValue(body, "runtime_capability");
  const imageDigest = stringValue(body, "image_digest") || null;
  const credential = bearerCredential(request);
  if (!workerId || !WORKER_ID_PATTERN.test(workerId) || !instanceId || !credential) {
    return errorJson("worker_id, instance_id, and persistent credential are required", 400, "WORKER_CONNECT_INVALID");
  }
  if (protocolVersion !== PROTOCOL_VERSION || runtimeCapability !== RUNTIME_CAPABILITY) {
    return errorJson("Worker protocol or runtime is incompatible", 409, "WORKER_PROTOCOL_INCOMPATIBLE");
  }
  const loaded = await loadWorker(env, workerId, credential);
  if (!loaded) return errorJson("Worker credential is invalid or revoked", 401, "WORKER_AUTH_INVALID");
  const policy = await loadPolicy(env);
  if (!policy || loaded.row.pool_id !== policy.pool_id || loaded.row.namespace !== policy.namespace) {
    return errorJson("Worker pool is not configured", 503, "WORKER_POOL_UNAVAILABLE");
  }
  if (loaded.row.protocol_version !== protocolVersion || loaded.row.runtime_capability !== runtimeCapability) {
    return errorJson("Worker registration requires a compatible runtime", 409, "WORKER_PROTOCOL_INCOMPATIBLE");
  }
  if (loaded.row.image_digest && loaded.row.image_digest !== imageDigest) {
    return errorJson("Worker image is incompatible", 409, "WORKER_IMAGE_INCOMPATIBLE");
  }

  const now = nowSeconds();
  const current = await env.DB.prepare(
    `SELECT session_id, worker_id, pool_id, namespace, instance_id,
            protocol_version, runtime_capability, image_digest,
            session_secret_hash, session_epoch, connected_at, last_seen_at,
            lease_expires_at, disconnected_at
     FROM worker_sessions_runtime WHERE worker_id = ?1`,
  ).bind(workerId).first<SessionRow>();
  if (current && current.lease_expires_at > now && current.disconnected_at == null && current.instance_id !== instanceId) {
    return errorJson("This Worker credential already has an active instance", 409, "WORKER_ALREADY_CONNECTED");
  }
  if (current && current.lease_expires_at > now && current.disconnected_at == null && current.instance_id === instanceId) {
    const context: WorkerContext = { worker: loaded.row, policy, session: current, credentialHash: loaded.hash };
    if (!(await touchSession(env, context, now))) return errorJson("Worker session was superseded", 409, "WORKER_SESSION_STALE");
    return json({
      worker_id: workerId,
      pool_id: policy.pool_id,
      namespace: policy.namespace,
      session_id: current.session_id,
      session_epoch: current.session_epoch,
      lease_expires_at: now + SESSION_TTL_SECONDS,
      protocol_version: PROTOCOL_VERSION,
      runtime_capability: RUNTIME_CAPABILITY,
      ready: true,
      persistent_credential: true,
    });
  }

  const sessionId = newToken("ws");
  const sessionEpoch = (current?.session_epoch ?? 0) + 1;
  const leaseExpiresAt = now + SESSION_TTL_SECONDS;
  try {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM worker_sessions_runtime WHERE worker_id = ?1").bind(workerId),
      env.DB.prepare(
        `INSERT INTO worker_sessions_runtime
          (session_id, worker_id, pool_id, namespace, instance_id,
           protocol_version, runtime_capability, image_digest,
           session_secret_hash, session_epoch, connected_at, last_seen_at,
           lease_expires_at, disconnected_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11, ?12, NULL)`,
      ).bind(
        sessionId,
        workerId,
        policy.pool_id,
        policy.namespace,
        instanceId,
        PROTOCOL_VERSION,
        RUNTIME_CAPABILITY,
        imageDigest,
        hashText(sessionId),
        sessionEpoch,
        now,
        leaseExpiresAt,
      ),
      env.DB.prepare("UPDATE workers SET last_seen_at = ?2, updated_at = ?2 WHERE worker_id = ?1 AND status = 'active'").bind(workerId, now),
    ]);
  } catch {
    return errorJson("Worker session could not be created", 503, "WORKER_SESSION_UNAVAILABLE");
  }
  return json({
    worker_id: workerId,
    pool_id: policy.pool_id,
    namespace: policy.namespace,
    session_id: sessionId,
    session_epoch: sessionEpoch,
    lease_expires_at: leaseExpiresAt,
    protocol_version: PROTOCOL_VERSION,
    runtime_capability: RUNTIME_CAPABILITY,
    ready: true,
    persistent_credential: true,
  }, 201);
}

async function heartbeat(request: Request, env: Env, context: WorkerContext): Promise<Response> {
  const body = await bodyJson(request);
  const forbidden = rejectClientControlledFields(body);
  if (forbidden) return forbidden;
  if (!(await touchSession(env, context))) return errorJson("Worker session was superseded", 409, "WORKER_SESSION_STALE");
  return json({
    worker_id: context.worker.worker_id,
    pool_id: context.policy.pool_id,
    namespace: context.policy.namespace,
    status: "ready",
    lease_expires_at: nowSeconds() + SESSION_TTL_SECONDS,
  });
}

async function pollTasks(request: Request, env: Env, context: WorkerContext): Promise<Response> {
  const body = await bodyJson(request);
  const forbidden = rejectClientControlledFields(body);
  if (forbidden) return forbidden;
  if (!(await touchSession(env, context))) return errorJson("Worker session was superseded", 409, "WORKER_SESSION_STALE");
  const row = await env.DB.prepare(
    `SELECT task_id, task_spec_id, dataset_snapshot_id, method_source_id,
            title, attempt_count, max_attempts
     FROM tasks
     WHERE status = 'queued' AND execution_pool_id = ?1
       AND cancel_requested_at IS NULL
     ORDER BY created_at ASC, task_id ASC LIMIT ?2`,
  ).bind(context.policy.pool_id, MAX_POLL_RESULTS).first<TaskQueueRow>();
  return json({
    tasks: row ? [{
      task_id: row.task_id,
      task_spec_id: row.task_spec_id,
      dataset_snapshot_id: row.dataset_snapshot_id,
      method_source_id: row.method_source_id,
      title: row.title,
      attempt_count: row.attempt_count,
      max_attempts: row.max_attempts,
      pool_id: context.policy.pool_id,
    }] : [],
    next_poll_seconds: row ? 1 : 5,
  });
}

async function loadTaskForAccept(env: Env, taskId: string): Promise<(TaskQueueRow & { lease_epoch: number; status: string; execution_pool_id: string }) | null> {
  return env.DB.prepare(
    `SELECT task_id, task_spec_id, dataset_snapshot_id, method_source_id, title,
            attempt_count, max_attempts, lease_epoch, status, execution_pool_id
     FROM tasks WHERE task_id = ?1`,
  ).bind(taskId).first<TaskQueueRow & { lease_epoch: number; status: string; execution_pool_id: string }>();
}

async function acceptTask(taskId: string, request: Request, env: Env, context: WorkerContext): Promise<Response> {
  if (!safeTaskId(taskId)) return errorJson("Invalid task ID", 400, "INVALID_TASK_ID");
  const body = await bodyJson(request);
  const forbidden = rejectClientControlledFields(body);
  if (forbidden) return forbidden;
  const task = await loadTaskForAccept(env, taskId);
  if (!task) return errorJson("Task not found", 404, "TASK_NOT_FOUND");
  if (task.execution_pool_id !== context.policy.pool_id || task.status !== "queued") {
    return errorJson("Task is no longer available", 409, "TASK_NOT_AVAILABLE");
  }
  const now = nowSeconds();
  const fencingEpoch = Number(task.lease_epoch ?? 0) + 1;
  const attemptNumber = Number(task.attempt_count ?? 0) + 1;
  const attemptId = crypto.randomUUID();
  const leaseToken = newToken("lease");
  const leaseTokenHash = hashText(leaseToken);
  const leaseExpiresAt = now + SESSION_TTL_SECONDS;
  const eventPayload = JSON.stringify({
    task_id: taskId,
    attempt_id: attemptId,
    worker_id: context.worker.worker_id,
    fencing_epoch: fencingEpoch,
    status: "claimed",
  });
  let results: unknown[];
  try {
    results = await env.DB.batch([
      env.DB.prepare(
        `UPDATE tasks
         SET status = 'claimed', attempt_count = attempt_count + 1,
             active_attempt_id = ?2, lease_worker_id = ?3,
             lease_epoch = ?4, lease_token_hash = ?5,
             lease_expires_at = ?6, updated_at = ?7
         WHERE task_id = ?1 AND status = 'queued'
           AND execution_pool_id = ?8 AND lease_epoch = ?9
           AND cancel_requested_at IS NULL`,
      ).bind(taskId, attemptId, context.worker.worker_id, fencingEpoch, leaseTokenHash, leaseExpiresAt, now, context.policy.pool_id, task.lease_epoch),
      env.DB.prepare(
        `INSERT INTO task_attempts
          (attempt_id, task_id, worker_id, session_id, attempt_number,
           fencing_epoch, lease_token_hash, lease_expires_at, status,
           created_at, updated_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'claimed', ?9, ?9
         WHERE EXISTS (
           SELECT 1 FROM tasks
           WHERE task_id = ?2 AND active_attempt_id = ?1
             AND lease_epoch = ?6 AND status = 'claimed'
         )`,
      ).bind(attemptId, taskId, context.worker.worker_id, context.session.session_id, attemptNumber, fencingEpoch, leaseTokenHash, leaseExpiresAt, now),
      env.DB.prepare(
        `INSERT INTO task_events (task_event_id, task_id, event_type, event_data, created_at)
         SELECT ?1, ?2, 'task_claimed', ?3, ?4
         WHERE EXISTS (SELECT 1 FROM task_attempts WHERE attempt_id = ?5 AND status = 'claimed')`,
      ).bind(crypto.randomUUID(), taskId, eventPayload, now, attemptId),
      env.DB.prepare(
        `INSERT INTO outbox_events
          (event_id, idempotency_key, aggregate_type, aggregate_id, event_type,
           payload_json, status, attempts, next_attempt_at, created_at)
         SELECT ?1, ?2, 'task', ?3, 'task_claimed', ?4, 'pending', 0, ?5, ?5
         WHERE EXISTS (SELECT 1 FROM task_attempts WHERE attempt_id = ?6 AND status = 'claimed')`,
      ).bind(crypto.randomUUID(), `task-claimed:${attemptId}`, taskId, eventPayload, now, attemptId),
    ]);
  } catch {
    return errorJson("Task claim transaction failed", 503, "TASK_CLAIM_UNAVAILABLE");
  }
  if (changed(results[0]) !== 1 || changed(results[1]) !== 1) {
    return errorJson("Task was claimed by another Worker", 409, "TASK_CLAIM_CONFLICT");
  }
  return json({
    task_id: taskId,
    attempt_id: attemptId,
    lease_token: leaseToken,
    fencing_epoch: fencingEpoch,
    lease_expires_at: leaseExpiresAt,
    attempt_number: attemptNumber,
    status: "claimed",
  }, 201);
}

async function authenticateAttempt(
  request: Request,
  env: Env,
  context: WorkerContext,
  taskId: string,
  body: Record<string, unknown> | null,
): Promise<{ attempt: AttemptRow; leaseTokenHash: string } | Response> {
  const attemptId = request.headers.get("x-worker-attempt-id")?.trim() || stringValue(body, "attempt_id");
  const leaseToken = request.headers.get("x-worker-lease-token")?.trim() || stringValue(body, "lease_token");
  if (!attemptId || !leaseToken) return errorJson("Attempt and lease credentials are required", 401, "ATTEMPT_AUTH_REQUIRED");
  const leaseTokenHash = hashText(leaseToken);
  const attempt = await env.DB.prepare(
    `SELECT attempt_id, task_id, worker_id, session_id, fencing_epoch,
            lease_expires_at, status
     FROM task_attempts
     WHERE attempt_id = ?1 AND task_id = ?2 AND worker_id = ?3
       AND session_id = ?4 AND lease_token_hash = ?5
       AND status IN ('claimed', 'running') AND lease_expires_at > ?6`,
  ).bind(attemptId, taskId, context.worker.worker_id, context.session.session_id, leaseTokenHash, nowSeconds()).first<AttemptRow>();
  if (!attempt) return errorJson("Attempt lease is invalid or expired", 409, "ATTEMPT_FENCING_REJECTED");
  return { attempt, leaseTokenHash };
}

async function renewTask(taskId: string, request: Request, env: Env, context: WorkerContext): Promise<Response> {
  const body = await bodyJson(request);
  const forbidden = rejectClientControlledFields(body);
  if (forbidden) return forbidden;
  const auth = await authenticateAttempt(request, env, context, taskId, body);
  if (auth instanceof Response) return auth;
  const now = nowSeconds();
  const leaseExpiresAt = now + SESSION_TTL_SECONDS;
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE task_attempts SET lease_expires_at = ?6, updated_at = ?6
       WHERE attempt_id = ?1 AND task_id = ?2 AND worker_id = ?3
         AND session_id = ?4 AND lease_token_hash = ?5
         AND status IN ('claimed', 'running') AND lease_expires_at > ?7`,
    ).bind(auth.attempt.attempt_id, taskId, context.worker.worker_id, context.session.session_id, auth.leaseTokenHash, leaseExpiresAt, now),
    env.DB.prepare(
      `UPDATE tasks SET status = CASE WHEN status = 'claimed' THEN 'running' ELSE status END,
          lease_expires_at = ?6, updated_at = ?6
       WHERE task_id = ?1 AND active_attempt_id = ?2 AND lease_worker_id = ?3
         AND lease_token_hash = ?4 AND lease_epoch = ?5
         AND status IN ('claimed', 'running') AND lease_expires_at > ?7`,
    ).bind(taskId, auth.attempt.attempt_id, context.worker.worker_id, auth.leaseTokenHash, auth.attempt.fencing_epoch, leaseExpiresAt, now),
  ]);
  if (changed(results[0]) !== 1 || changed(results[1]) !== 1) return errorJson("Attempt lease is stale", 409, "ATTEMPT_FENCING_REJECTED");
  return json({ task_id: taskId, attempt_id: auth.attempt.attempt_id, lease_expires_at: leaseExpiresAt, status: "running" });
}

async function taskSpec(taskId: string, request: Request, env: Env, context: WorkerContext): Promise<Response> {
  const auth = await authenticateAttempt(request, env, context, taskId, null);
  if (auth instanceof Response) return auth;
  const row = await env.DB.prepare(
    `SELECT t.task_id, t.active_attempt_id, t.cancel_requested_at,
            s.title, s.analysis_type, s.research_question, s.goal,
            s.prompt_template_version,
            ds.original_filename AS dataset_filename,
            ds.file_size_bytes AS dataset_size_bytes,
            ds.file_hash_sha256 AS dataset_sha256,
            ms.original_filename AS method_filename,
            mr.file_size_bytes AS method_size_bytes,
            mr.file_hash_sha256 AS method_sha256
     FROM tasks t
     JOIN task_specs s ON s.task_spec_id = t.task_spec_id
     JOIN dataset_snapshots ds ON ds.dataset_snapshot_id = t.dataset_snapshot_id
     LEFT JOIN method_sources ms ON ms.method_source_id = t.method_source_id
     LEFT JOIN task_resources mr ON mr.resource_id = ms.resource_id
     WHERE t.task_id = ?1 AND t.active_attempt_id = ?2
       AND t.lease_worker_id = ?3 AND t.lease_epoch = ?4`,
  ).bind(taskId, auth.attempt.attempt_id, context.worker.worker_id, auth.attempt.fencing_epoch).first<Record<string, unknown>>();
  if (!row) return errorJson("Task spec is no longer available", 409, "ATTEMPT_FENCING_REJECTED");
  return json({
    task_id: taskId,
    attempt_id: auth.attempt.attempt_id,
    fencing_epoch: auth.attempt.fencing_epoch,
    cancel_requested: row.cancel_requested_at != null,
    task_spec: {
      title: row.title,
      analysis_type: row.analysis_type,
      research_question: row.research_question,
      goal: row.goal,
      prompt_template_version: row.prompt_template_version,
    },
    inputs: {
      method: row.method_filename ? {
        logical_name: row.method_filename,
        file_size_bytes: row.method_size_bytes,
        sha256: row.method_sha256,
      } : null,
      dataset: {
        logical_name: row.dataset_filename,
        file_size_bytes: row.dataset_size_bytes,
        sha256: row.dataset_sha256,
      },
    },
  });
}

async function taskInput(taskId: string, resource: string, request: Request, env: Env, context: WorkerContext): Promise<Response> {
  const auth = await authenticateAttempt(request, env, context, taskId, null);
  if (auth instanceof Response) return auth;
  if (resource !== "method" && resource !== "dataset") return errorJson("Unknown task input", 404, "TASK_INPUT_NOT_FOUND");
  const row = await env.DB.prepare(
    resource === "dataset"
      ? `SELECT tr.object_key, tr.logical_name, tr.content_type, tr.file_size_bytes, tr.file_hash_sha256
         FROM tasks t JOIN dataset_snapshots ds ON ds.dataset_snapshot_id = t.dataset_snapshot_id
         JOIN task_resources tr ON tr.resource_id = ds.resource_id
         WHERE t.task_id = ?1 AND t.active_attempt_id = ?2 AND t.lease_worker_id = ?3 AND t.lease_epoch = ?4`
      : `SELECT tr.object_key, tr.logical_name, tr.content_type, tr.file_size_bytes, tr.file_hash_sha256
         FROM tasks t JOIN method_sources ms ON ms.method_source_id = t.method_source_id
         JOIN task_resources tr ON tr.resource_id = ms.resource_id
         WHERE t.task_id = ?1 AND t.active_attempt_id = ?2 AND t.lease_worker_id = ?3 AND t.lease_epoch = ?4`,
  ).bind(taskId, auth.attempt.attempt_id, context.worker.worker_id, auth.attempt.fencing_epoch).first<{
    object_key: string;
    logical_name: string;
    content_type: string;
    file_size_bytes: number;
    file_hash_sha256: string;
  }>();
  if (!row || !env.RESOURCE_BUCKET) return errorJson("Task input not found", 404, "TASK_INPUT_NOT_FOUND");
  const object = await env.RESOURCE_BUCKET.get(row.object_key);
  if (!object) return errorJson("Task input object not found", 404, "TASK_INPUT_NOT_FOUND");
  const headers = new Headers({
    "cache-control": "no-store",
    "content-type": row.content_type,
    "content-length": String(row.file_size_bytes),
    "content-disposition": `attachment; filename="${row.logical_name.replaceAll('"', "_")}"`,
    "x-infinity-sha256": row.file_hash_sha256,
  });
  object.writeHttpMetadata(headers);
  return new Response(object.body, { headers });
}

function artifactLimit(env: Env): number {
  const configured = Number(env.TASK_ARTIFACT_MAX_BYTES ?? "2147483648");
  return Number.isSafeInteger(configured) && configured > 0 ? Math.min(configured, 8 * 1024 * 1024 * 1024) : 2147483648;
}

function safeArtifactName(value: string): string | null {
  const name = value.split(/[\\/]/).pop()?.trim() ?? "";
  if (!name || name.length > 240 || name === "." || name === "..") return null;
  return name;
}

function manifestJson(value: unknown): string | null {
  if (value == null) return "{}";
  try {
    const jsonValue = typeof value === "string" ? JSON.parse(value) : value;
    if (!jsonValue || typeof jsonValue !== "object" || Array.isArray(jsonValue)) return null;
    const text = JSON.stringify(jsonValue);
    return new TextEncoder().encode(text).byteLength <= MAX_ARTIFACT_MANIFEST_BYTES ? text : null;
  } catch {
    return null;
  }
}

async function startArtifact(taskId: string, request: Request, env: Env, context: WorkerContext): Promise<Response> {
  const body = await bodyJson(request);
  const forbidden = rejectClientControlledFields(body);
  if (forbidden) return forbidden;
  const auth = await authenticateAttempt(request, env, context, taskId, body);
  if (auth instanceof Response) return auth;
  if (!env.RESOURCE_BUCKET) return errorJson("Artifact storage is not configured", 503, "ARTIFACT_STORAGE_UNAVAILABLE");
  const name = safeArtifactName(stringValue(body, "name"));
  const kind = stringValue(body, "kind");
  const contentType = stringValue(body, "content_type") || "application/zip";
  const expectedSize = Number(body?.expected_size_bytes);
  const expectedSha = stringValue(body, "expected_sha256").toLowerCase();
  const manifest = manifestJson(body?.manifest);
  if (!name || !kind || !Number.isSafeInteger(expectedSize) || expectedSize <= 0 || expectedSize > artifactLimit(env)
    || !/^[a-f0-9]{64}$/.test(expectedSha) || !manifest) {
    return errorJson("Invalid artifact metadata", 400, "INVALID_ARTIFACT_METADATA");
  }
  const objectKey = `task-artifacts/${taskId}/${auth.attempt.attempt_id}/${crypto.randomUUID()}-${name}`;
  let multipart: R2MultipartUpload;
  try {
    multipart = await env.RESOURCE_BUCKET.createMultipartUpload(objectKey, {
      httpMetadata: { contentType },
    });
  } catch {
    return errorJson("Artifact multipart session could not be created", 503, "ARTIFACT_UPLOAD_UNAVAILABLE");
  }
  const uploadId = multipart.uploadId;
  try {
    await env.DB.prepare(
      `INSERT INTO artifact_uploads
        (upload_id, task_id, attempt_id, worker_id, object_key, name, kind,
         content_type, expected_size_bytes, expected_sha256, manifest_json,
         status, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'open', ?12)`,
    ).bind(uploadId, taskId, auth.attempt.attempt_id, context.worker.worker_id, objectKey, name, kind, contentType, expectedSize, expectedSha, manifest, nowSeconds()).run();
  } catch {
    try { await multipart.abort(); } catch { /* best effort cleanup */ }
    return errorJson("Artifact multipart metadata could not be saved", 503, "ARTIFACT_UPLOAD_UNAVAILABLE");
  }
  return json({ upload_id: uploadId, object_key: objectKey, part_size_bytes: MAX_PART_BYTES, expected_size_bytes: expectedSize }, 201);
}

async function readBoundedRequestBody(source: ReadableStream<Uint8Array>, maximumBytes: number): Promise<Uint8Array> {
  const reader = source.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const bytes = next.value instanceof Uint8Array ? next.value : new Uint8Array(next.value);
      size += bytes.byteLength;
      if (size > maximumBytes) {
        await reader.cancel("artifact part exceeds maximum size");
        throw new Error("artifact part exceeds maximum size");
      }
      chunks.push(bytes);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function artifactPart(uploadId: string, partText: string, request: Request, env: Env, context: WorkerContext): Promise<Response> {
  const partNumber = safePartNumber(partText);
  if (!partNumber || partNumber > 10000) return errorJson("Invalid artifact part number", 400, "INVALID_ARTIFACT_PART");
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > MAX_PART_BYTES) return errorJson("Artifact part is too large", 413, "ARTIFACT_PART_TOO_LARGE");
  const upload = await env.DB.prepare(
    `SELECT upload_id, task_id, attempt_id, worker_id, object_key, name, kind,
            content_type, expected_size_bytes, expected_sha256, manifest_json, status
     FROM artifact_uploads WHERE upload_id = ?1 AND worker_id = ?2 AND status = 'open'`,
  ).bind(uploadId, context.worker.worker_id).first<ArtifactUploadRow>();
  if (!upload) return errorJson("Artifact upload not found", 404, "ARTIFACT_UPLOAD_NOT_FOUND");
  const auth = await authenticateAttempt(request, env, context, upload.task_id, null);
  if (auth instanceof Response || auth.attempt.attempt_id !== upload.attempt_id) return errorJson("Artifact lease is invalid", 409, "ATTEMPT_FENCING_REJECTED");
  if (!env.RESOURCE_BUCKET || !request.body) return errorJson("Artifact part body is required", 400, "INVALID_ARTIFACT_PART");
  try {
    // R2's production multipart implementation is stricter than the local
    // fake when it receives a transformed request stream. Read only one
    // bounded part, hash the exact bytes, and pass that stable byte buffer to
    // R2. The Worker client still streams the archive one part at a time, so
    // memory is bounded by MAX_PART_BYTES rather than the full artifact.
    const body = await readBoundedRequestBody(request.body, MAX_PART_BYTES);
    const hash = new Sha256().update(body).digestHex();
    const result = { size: body.byteLength, sha256: hash };
    const multipart = env.RESOURCE_BUCKET.resumeMultipartUpload(upload.object_key, upload.upload_id);
    const uploaded = await multipart.uploadPart(partNumber, body);
    if (result.size <= 0 || (contentLength > 0 && result.size !== contentLength)) return errorJson("Artifact part size is invalid", 400, "INVALID_ARTIFACT_PART");
    await env.DB.prepare(
      `INSERT OR REPLACE INTO artifact_upload_parts
        (upload_id, part_number, etag, part_size_bytes, part_sha256, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    ).bind(uploadId, partNumber, uploaded.etag, result.size, result.sha256, nowSeconds()).run();
    return json({ upload_id: uploadId, part_number: partNumber, etag: uploaded.etag, size_bytes: result.size, sha256: result.sha256 });
  } catch (error) {
    console.error("Worker artifact part upload failed", {
      task_id: upload.task_id,
      attempt_id: upload.attempt_id,
      part_number: partNumber,
      message: error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160),
    });
    return errorJson("Artifact part upload failed", 503, "ARTIFACT_UPLOAD_UNAVAILABLE");
  }
}

async function completeArtifact(uploadId: string, request: Request, env: Env, context: WorkerContext): Promise<Response> {
  const body = await bodyJson(request);
  const forbidden = rejectClientControlledFields(body);
  if (forbidden) return forbidden;
  const upload = await env.DB.prepare(
    `SELECT upload_id, task_id, attempt_id, worker_id, object_key, name, kind,
            content_type, expected_size_bytes, expected_sha256, manifest_json, status
     FROM artifact_uploads WHERE upload_id = ?1 AND worker_id = ?2`,
  ).bind(uploadId, context.worker.worker_id).first<ArtifactUploadRow>();
  if (!upload) return errorJson("Artifact upload not found", 404, "ARTIFACT_UPLOAD_NOT_FOUND");
  if (upload.status === "completed") {
    const existing = await env.DB.prepare("SELECT artifact_id, name, file_size_bytes, checksum_sha256 FROM artifacts WHERE upload_id = ?1").bind(uploadId).first<Record<string, unknown>>();
    if (!existing) return errorJson("Completed artifact metadata is missing", 503, "ARTIFACT_FINALIZE_INCONSISTENT");
    return json({ artifact_id: existing?.artifact_id, name: existing?.name, file_size_bytes: existing?.file_size_bytes, checksum_sha256: existing?.checksum_sha256, status: "published", duplicate: true });
  }
  const auth = await authenticateAttempt(request, env, context, upload.task_id, body);
  if (auth instanceof Response || auth.attempt.attempt_id !== upload.attempt_id) return errorJson("Artifact lease is invalid", 409, "ATTEMPT_FENCING_REJECTED");
  if (upload.status !== "open" || !env.RESOURCE_BUCKET) return errorJson("Artifact upload is not open", 409, "ARTIFACT_UPLOAD_CLOSED");
  const rawParts = await env.DB.prepare(
    "SELECT part_number, etag, part_size_bytes, part_sha256 FROM artifact_upload_parts WHERE upload_id = ?1 ORDER BY part_number ASC",
  ).bind(uploadId).all<ArtifactPartRow>();
  const storedParts = rawParts.results ?? [];
  if (!storedParts.length || storedParts.some((part, index) => part.part_number !== index + 1)) {
    return errorJson("Artifact parts are incomplete", 409, "ARTIFACT_PARTS_INCOMPLETE");
  }
  const requestedParts = Array.isArray(body?.parts) ? body.parts : [];
  if (requestedParts.length !== storedParts.length) return errorJson("Artifact part list does not match", 400, "ARTIFACT_PARTS_MISMATCH");
  const parts = requestedParts.map((part) => ({ partNumber: Number((part as Record<string, unknown>)?.part_number), etag: String((part as Record<string, unknown>)?.etag ?? "") }));
  if (parts.some((part, index) => part.partNumber !== storedParts[index].part_number || part.etag !== storedParts[index].etag)) {
    return errorJson("Artifact part list does not match", 400, "ARTIFACT_PARTS_MISMATCH");
  }
  let objectKey = upload.object_key;
  try {
    const multipart = env.RESOURCE_BUCKET.resumeMultipartUpload(upload.object_key, upload.upload_id);
    await multipart.complete(parts);
    const object = await env.RESOURCE_BUCKET.get(objectKey);
    if (!object || !object.body) throw new Error("completed artifact is missing");
    const measured = await hashReadableStream(object.body, artifactLimit(env));
    if (measured.size !== upload.expected_size_bytes || measured.sha256 !== upload.expected_sha256) {
      await env.RESOURCE_BUCKET.delete(objectKey);
      return errorJson("Artifact checksum or size does not match", 409, "ARTIFACT_VALIDATION_FAILED");
    }
    const artifactId = crypto.randomUUID();
    const now = nowSeconds();
    const payload = JSON.stringify({ task_id: upload.task_id, attempt_id: upload.attempt_id, artifact_id: artifactId, status: "succeeded" });
    const results = await env.DB.batch([
      env.DB.prepare(
        `UPDATE artifact_uploads SET status = 'completed', completed_at = ?2
         WHERE upload_id = ?1 AND task_id = ?3 AND attempt_id = ?4
           AND worker_id = ?5 AND status = 'open'`,
      ).bind(uploadId, now, upload.task_id, upload.attempt_id, context.worker.worker_id),
      env.DB.prepare(
        `INSERT INTO artifacts
          (artifact_id, task_id, name, kind, object_key, file_size_bytes,
           checksum_sha256, content_type, created_at, attempt_id, worker_id,
           status, manifest_json, release_state, upload_id, released_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
                'published', ?12, 'published', ?13, ?9
         WHERE EXISTS (SELECT 1 FROM artifact_uploads WHERE upload_id = ?13 AND status = 'completed')`,
      ).bind(artifactId, upload.task_id, upload.name, upload.kind, objectKey, measured.size, measured.sha256, upload.content_type, now, upload.attempt_id, context.worker.worker_id, upload.manifest_json, uploadId),
      env.DB.prepare(
        `UPDATE task_attempts SET status = 'succeeded', updated_at = ?7, finished_at = ?7
         WHERE attempt_id = ?1 AND task_id = ?2 AND worker_id = ?3
           AND session_id = ?4 AND lease_token_hash = ?5
           AND status IN ('claimed', 'running') AND lease_expires_at > ?6`,
      ).bind(upload.attempt_id, upload.task_id, context.worker.worker_id, context.session.session_id, auth.leaseTokenHash, now, now),
      env.DB.prepare(
        `UPDATE tasks SET status = 'succeeded', result_artifact_id = ?2,
             lease_expires_at = ?3, updated_at = ?3, finished_at = ?3,
             error_message = NULL
         WHERE task_id = ?1 AND active_attempt_id = ?4
           AND lease_worker_id = ?5 AND lease_epoch = ?6
           AND lease_token_hash = ?7 AND status IN ('claimed', 'running')`,
      ).bind(upload.task_id, artifactId, now, upload.attempt_id, context.worker.worker_id, auth.attempt.fencing_epoch, auth.leaseTokenHash),
      env.DB.prepare(
        `INSERT INTO task_events (task_event_id, task_id, event_type, event_data, created_at)
         SELECT ?1, ?2, 'task_succeeded', ?3, ?4
         WHERE EXISTS (SELECT 1 FROM tasks WHERE task_id = ?2 AND status = 'succeeded' AND result_artifact_id = ?5)`,
      ).bind(crypto.randomUUID(), upload.task_id, payload, now, artifactId),
      env.DB.prepare(
        `INSERT INTO outbox_events
          (event_id, idempotency_key, aggregate_type, aggregate_id, event_type,
           payload_json, status, attempts, next_attempt_at, created_at)
         SELECT ?1, ?2, 'task', ?3, 'task_succeeded', ?4, 'pending', 0, ?5, ?5
         WHERE EXISTS (SELECT 1 FROM tasks WHERE task_id = ?3 AND status = 'succeeded' AND result_artifact_id = ?6)`,
      ).bind(crypto.randomUUID(), `task-succeeded:${upload.attempt_id}`, upload.task_id, payload, now, artifactId),
    ]);
    if (changed(results[0]) !== 1 || changed(results[1]) !== 1 || changed(results[2]) !== 1 || changed(results[3]) !== 1) {
      await env.RESOURCE_BUCKET.delete(objectKey);
      return errorJson("Artifact finalize lost the active lease", 409, "ATTEMPT_FENCING_REJECTED");
    }
    return json({ artifact_id: artifactId, name: upload.name, file_size_bytes: measured.size, checksum_sha256: measured.sha256, status: "published" }, 201);
  } catch {
    if (objectKey) {
      try { await env.RESOURCE_BUCKET.delete(objectKey); } catch { /* best effort cleanup */ }
    }
    return errorJson("Artifact finalize failed", 503, "ARTIFACT_FINALIZE_UNAVAILABLE");
  }
}

async function finishTask(taskId: string, request: Request, env: Env, context: WorkerContext, target: "failed" | "cancelled"): Promise<Response> {
  const body = await bodyJson(request);
  const forbidden = rejectClientControlledFields(body);
  if (forbidden) return forbidden;
  const auth = await authenticateAttempt(request, env, context, taskId, body);
  if (auth instanceof Response) return auth;
  const now = nowSeconds();
  const errorCode = errorMessage(body?.error_code, target === "cancelled" ? "cancelled" : "worker_failed");
  const errorText = errorMessage(body?.error_message, target === "cancelled" ? "Task cancelled" : "Worker reported failure");
  const payload = JSON.stringify({ task_id: taskId, attempt_id: auth.attempt.attempt_id, status: target, error_code: errorCode });
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE task_attempts SET status = ?7, error_code = ?5, error_message = ?6,
          updated_at = ?8, finished_at = ?8
       WHERE attempt_id = ?1 AND task_id = ?2 AND worker_id = ?3
         AND session_id = ?4 AND lease_token_hash = ?9
         AND status IN ('claimed', 'running') AND lease_expires_at > ?8`,
    ).bind(auth.attempt.attempt_id, taskId, context.worker.worker_id, context.session.session_id, errorCode, errorText, target, now, auth.leaseTokenHash),
    env.DB.prepare(
      `UPDATE tasks SET status = ?5, error_message = ?6, lease_expires_at = ?7,
          updated_at = ?7, finished_at = ?7
       WHERE task_id = ?1 AND active_attempt_id = ?2 AND lease_worker_id = ?3
         AND lease_epoch = ?4 AND lease_token_hash = ?8
         AND status IN ('claimed', 'running')`,
    ).bind(taskId, auth.attempt.attempt_id, context.worker.worker_id, auth.attempt.fencing_epoch, target, errorText, now, auth.leaseTokenHash),
    env.DB.prepare(
      `INSERT INTO task_events (task_event_id, task_id, event_type, event_data, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5
       WHERE EXISTS (SELECT 1 FROM tasks WHERE task_id = ?2 AND status = ?6 AND active_attempt_id = ?7)`,
    ).bind(crypto.randomUUID(), taskId, target === "cancelled" ? "task_cancelled" : "task_failed", payload, now, target, auth.attempt.attempt_id),
    env.DB.prepare(
      `INSERT INTO outbox_events
        (event_id, idempotency_key, aggregate_type, aggregate_id, event_type,
         payload_json, status, attempts, next_attempt_at, created_at)
       SELECT ?1, ?2, 'task', ?3, ?4, ?5, 'pending', 0, ?6, ?6
       WHERE EXISTS (SELECT 1 FROM tasks WHERE task_id = ?3 AND status = ?7 AND active_attempt_id = ?8)`,
    ).bind(crypto.randomUUID(), `${target}:${auth.attempt.attempt_id}`, taskId, target === "cancelled" ? "task_cancelled" : "task_failed", payload, now, target, auth.attempt.attempt_id),
  ]);
  if (changed(results[0]) !== 1 || changed(results[1]) !== 1) return errorJson("Attempt lease is stale", 409, "ATTEMPT_FENCING_REJECTED");
  return json({ task_id: taskId, attempt_id: auth.attempt.attempt_id, status: target });
}

export async function handleWorkerV2(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(`${WORKER_V2_PREFIX}/`)) return null;
  if (request.method !== "POST" && request.method !== "GET" && request.method !== "PUT") {
    return errorJson("Method not allowed", 405, "METHOD_NOT_ALLOWED");
  }
  if (url.pathname === `${WORKER_V2_PREFIX}/connect`) {
    return request.method === "POST" ? connectWorker(request, env) : errorJson("Method not allowed", 405, "METHOD_NOT_ALLOWED");
  }
  const resolved = await authenticateSession(request, env);
  if (resolved instanceof Response) return resolved;
  const context = resolved;
  if (url.pathname === `${WORKER_V2_PREFIX}/heartbeat`) {
    return request.method === "POST" ? heartbeat(request, env, context) : errorJson("Method not allowed", 405, "METHOD_NOT_ALLOWED");
  }
  if (url.pathname === `${WORKER_V2_PREFIX}/poll`) {
    return request.method === "POST" ? pollTasks(request, env, context) : errorJson("Method not allowed", 405, "METHOD_NOT_ALLOWED");
  }
  const accept = url.pathname.match(new RegExp(`^${WORKER_V2_PREFIX}/tasks/([^/]+)/accept$`));
  if (accept) return request.method === "POST" ? acceptTask(decodeURIComponent(accept[1]), request, env, context) : errorJson("Method not allowed", 405, "METHOD_NOT_ALLOWED");
  const renew = url.pathname.match(new RegExp(`^${WORKER_V2_PREFIX}/tasks/([^/]+)/renew$`));
  if (renew) return request.method === "POST" ? renewTask(decodeURIComponent(renew[1]), request, env, context) : errorJson("Method not allowed", 405, "METHOD_NOT_ALLOWED");
  const spec = url.pathname.match(new RegExp(`^${WORKER_V2_PREFIX}/tasks/([^/]+)/spec$`));
  if (spec) return request.method === "GET" ? taskSpec(decodeURIComponent(spec[1]), request, env, context) : errorJson("Method not allowed", 405, "METHOD_NOT_ALLOWED");
  const input = url.pathname.match(new RegExp(`^${WORKER_V2_PREFIX}/tasks/([^/]+)/inputs/(method|dataset)$`));
  if (input) return request.method === "GET" ? taskInput(decodeURIComponent(input[1]), input[2], request, env, context) : errorJson("Method not allowed", 405, "METHOD_NOT_ALLOWED");
  const start = url.pathname.match(new RegExp(`^${WORKER_V2_PREFIX}/tasks/([^/]+)/artifacts/start$`));
  if (start) return request.method === "POST" ? startArtifact(decodeURIComponent(start[1]), request, env, context) : errorJson("Method not allowed", 405, "METHOD_NOT_ALLOWED");
  const fail = url.pathname.match(new RegExp(`^${WORKER_V2_PREFIX}/tasks/([^/]+)/(fail|cancelled)$`));
  if (fail) return request.method === "POST" ? finishTask(decodeURIComponent(fail[1]), request, env, context, fail[2] as "failed" | "cancelled") : errorJson("Method not allowed", 405, "METHOD_NOT_ALLOWED");
  const part = url.pathname.match(new RegExp(`^${WORKER_V2_PREFIX}/artifacts/([^/]+)/parts/(\\d+)$`));
  if (part) return request.method === "PUT" ? artifactPart(decodeURIComponent(part[1]), part[2], request, env, context) : errorJson("Method not allowed", 405, "METHOD_NOT_ALLOWED");
  const complete = url.pathname.match(new RegExp(`^${WORKER_V2_PREFIX}/artifacts/([^/]+)/complete$`));
  if (complete) return request.method === "POST" ? completeArtifact(decodeURIComponent(complete[1]), request, env, context) : errorJson("Method not allowed", 405, "METHOD_NOT_ALLOWED");
  return errorJson("Not found", 404, "NOT_FOUND");
}
