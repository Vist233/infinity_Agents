import type { Env } from "./env";
import { errorJson, json, nowSeconds } from "./http";

/**
 * Cloudflare-native Worker control plane.
 *
 * The browser/API user never shares a D1 or Redis credential with a Worker.
 * New user-created Worker registrations receive an opaque, revocable,
 * non-expiring credential whose digest is stored in D1. The older one-time
 * enrollment-token path remains only for compatibility while existing clients
 * are migrated. Every attempt is fenced by a lease epoch; stale heartbeats,
 * uploads, and finalizers are rejected by D1 checks.
 *
 * This is deliberately a small control/data-plane contract. It does not give
 * a Worker a queue, D1, R2 parent credential, or provider secret.
 */

const OFFER_TTL_SECONDS = 30;
const LEASE_TTL_SECONDS = 120;
const CREDENTIAL_TTL_SECONDS = 30 * 24 * 60 * 60;
const DEFAULT_UPLOAD_LIMIT = 25 * 1024 * 1024;
const MAX_ERROR_LENGTH = 500;
const MAX_CAPABILITIES = 32;

interface WorkerContext {
  workerId: string;
  namespace: string;
  userId: string;
  trustLevel: string;
  status: string;
}

interface EnrollmentRow {
  worker_id: string;
  namespace: string;
  user_id: string;
  trust_level: string;
  status: string;
  credential_expires_at: number | null;
}

interface AttemptRow {
  attempt_id: string;
  task_id: string;
  worker_id: string;
  namespace: string;
  fencing_epoch: number;
  lease_expires_at: number;
  attempt_status: string;
  task_status: string;
  title: string;
  task_class: string;
  attempt_count: number;
  max_attempts: number;
  task_spec_id: string;
  dataset_snapshot_id: string;
  method_source_id: string | null;
  method_resource_id: string | null;
  method_filename: string | null;
  dataset_resource_id: string | null;
  dataset_filename: string | null;
}

function id(): string {
  return crypto.randomUUID();
}

function safeText(value: unknown, maxLength: number): string {
  return String(value ?? "").trim().slice(0, maxLength);
}

function safeFilename(value: unknown, fallback: string): string {
  const name = safeText(value, 240).split(/[\\/]/).pop()?.trim() || fallback;
  return name.slice(0, 240);
}

function uploadLimit(env: Env): number {
  const configured = Number(env.TASK_UPLOAD_MAX_BYTES);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_UPLOAD_LIMIT;
}

async function sha256(value: ArrayBuffer | Uint8Array | string): Promise<string> {
  const data = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomCredential(): string {
  return `wc_${id().replaceAll("-", "")}${id().replaceAll("-", "")}`;
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+([^\s]+)$/i);
  return match?.[1] && match[1].length <= 256 ? match[1] : null;
}

function unauthorized(): Response {
  return json(
    { error: { message: "Worker authentication required", code: "WORKER_UNAUTHENTICATED" } },
    401,
    { "www-authenticate": "Bearer" },
  );
}

async function bodyJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const value = await request.json();
    return value && typeof value === "object" ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function capabilities(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim().slice(0, 64))
    .filter(Boolean)
    .slice(0, MAX_CAPABILITIES);
}

async function authenticateWorker(request: Request, env: Env): Promise<WorkerContext | null> {
  const token = bearerToken(request);
  if (!token) return null;
  const hash = await sha256(token);
  const persistent = await env.DB.prepare(
    `SELECT worker_id, namespace, user_id, trust_level, status, credential_expires_at
     FROM worker_registrations
     WHERE credential_hash = ?1
       AND status = 'active'
       AND revoked_at IS NULL
       AND (credential_expires_at IS NULL OR credential_expires_at > ?2)`
  ).bind(hash, nowSeconds()).first<EnrollmentRow>();
  if (persistent) {
    return {
      workerId: persistent.worker_id,
      namespace: persistent.namespace,
      userId: persistent.user_id,
      trustLevel: persistent.trust_level,
      status: persistent.status,
    };
  }

  const legacy = await env.DB.prepare(
    `SELECT worker_id, namespace, user_id, trust_level, status, credential_expires_at
     FROM worker_enrollments
     WHERE credential_hash = ?1
       AND status = 'active'
       AND revoked_at IS NULL
       AND (credential_expires_at IS NULL OR credential_expires_at > ?2)`
  ).bind(hash, nowSeconds()).first<EnrollmentRow>();
  if (!legacy) return null;
  return {
    workerId: legacy.worker_id,
    namespace: legacy.namespace,
    userId: legacy.user_id,
    trustLevel: legacy.trust_level,
    status: legacy.status,
  };
}

function publicAttempt(row: AttemptRow, origin: string): Record<string, unknown> {
  const resources = [
    row.method_resource_id && {
      resource_id: row.method_resource_id,
      kind: "method",
      logical_name: row.method_filename,
      sha256: null,
      url: `${origin}/api/worker/v1/attempts/${encodeURIComponent(row.attempt_id)}/resources/${encodeURIComponent(row.method_resource_id)}`,
    },
    row.dataset_resource_id && {
      resource_id: row.dataset_resource_id,
      kind: "dataset",
      logical_name: row.dataset_filename,
      sha256: null,
      url: `${origin}/api/worker/v1/attempts/${encodeURIComponent(row.attempt_id)}/resources/${encodeURIComponent(row.dataset_resource_id)}`,
    },
  ].filter(Boolean);
  return {
    attempt_id: row.attempt_id,
    task_id: row.task_id,
    fencing_epoch: row.fencing_epoch,
    lease_expires_at: new Date(row.lease_expires_at * 1000).toISOString(),
    status: row.attempt_status,
    task_status: row.task_status,
    task_class: row.task_class,
    title: row.title,
    attempt_count: row.attempt_count,
    max_attempts: row.max_attempts,
    task_spec_id: row.task_spec_id,
    dataset_snapshot_id: row.dataset_snapshot_id,
    method_source_id: row.method_source_id,
    resources,
    heartbeat_interval_seconds: 30,
    required_runtime: "infinity-worker-control-v1",
  };
}

async function loadAttempt(
  env: Env,
  context: WorkerContext,
  attemptId: string,
  epoch: number,
  activeOnly = true,
): Promise<AttemptRow | null> {
  const activeClause = activeOnly
    ? `AND a.status IN ('claimed', 'running')
       AND a.namespace = ?3
       AND a.fencing_epoch = ?4
       AND a.lease_expires_at > ?5
       AND t.status IN ('claimed', 'running')`
    : "";
  const args = activeOnly
    ? [attemptId, context.workerId, context.namespace, epoch, nowSeconds()]
    : [attemptId, context.workerId, context.namespace, epoch];
  return env.DB.prepare(
    `SELECT a.attempt_id, a.task_id, a.worker_id, a.namespace,
            a.fencing_epoch, a.lease_expires_at, a.status AS attempt_status,
            t.status AS task_status, t.title, t.task_class, t.attempt_count,
            t.max_attempts, t.task_spec_id, t.dataset_snapshot_id,
            t.method_source_id,
            ms.resource_id AS method_resource_id,
            ms.original_filename AS method_filename,
            ds.resource_id AS dataset_resource_id,
            ds.original_filename AS dataset_filename
     FROM worker_attempts a
     JOIN tasks t ON t.task_id = a.task_id
     LEFT JOIN method_sources ms ON ms.method_source_id = t.method_source_id
     LEFT JOIN dataset_snapshots ds ON ds.dataset_snapshot_id = t.dataset_snapshot_id
     WHERE a.attempt_id = ?1
       AND a.worker_id = ?2
       AND a.namespace = ?3
       AND a.fencing_epoch = ?4
       ${activeClause}`
  ).bind(...args).first<AttemptRow>();
}

async function handleEnroll(request: Request, env: Env): Promise<Response> {
  const body = await bodyJson(request);
  const token = safeText(body?.enrollment_token, 512);
  const publicKey = safeText(body?.public_key, 256);
  const version = safeText(body?.version, 120) || "unknown";
  const workerCapabilities = capabilities(body?.capabilities);
  if (
    !token
    || token.length > 512
    || !/^ed25519-spki\.[A-Za-z0-9_-]{20,240}$/.test(publicKey)
  ) {
    return errorJson("enrollment_token and public_key are required", 400, "INVALID_ENROLLMENT");
  }

  const tokenHash = await sha256(token);
  const current = await env.DB.prepare(
    `SELECT worker_id, namespace, expires_at, used_at, revoked_at, trust_level
     FROM worker_enrollments WHERE token_hash = ?1`
  ).bind(tokenHash).first<{
    worker_id: string;
    namespace: string;
    expires_at: number;
    used_at: number | null;
    revoked_at: number | null;
    trust_level: string;
  }>();
  const now = nowSeconds();
  if (!current || current.used_at != null || current.revoked_at != null || current.expires_at <= now) {
    return errorJson("Enrollment token is invalid or already used", 401, "ENROLLMENT_INVALID");
  }

  const credential = randomCredential();
  const credentialHash = await sha256(credential);
  const credentialExpiresAt = now + CREDENTIAL_TTL_SECONDS;
  const result = await env.DB.prepare(
    `UPDATE worker_enrollments
     SET used_at = ?2, credential_hash = ?3, credential_expires_at = ?4,
         public_key = ?5, version = ?6, capabilities_json = ?7,
         status = 'active', last_seen_at = ?2
     WHERE token_hash = ?1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?2`
  ).bind(
    tokenHash,
    now,
    credentialHash,
    credentialExpiresAt,
    publicKey,
    version,
    JSON.stringify(workerCapabilities),
  ).run();
  if ((result.meta?.changes ?? 0) !== 1) {
    return errorJson("Enrollment token was consumed by another request", 409, "ENROLLMENT_REPLAY");
  }
  return json({
    worker_id: current.worker_id,
    namespace: current.namespace,
    trust_level: current.trust_level,
    worker_credential: credential,
    credential_expires_at: new Date(credentialExpiresAt * 1000).toISOString(),
    control_base_url: new URL(request.url).origin,
  }, 201);
}

async function reapExpired(env: Env): Promise<void> {
  const now = nowSeconds();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE worker_attempts SET status = 'expired', updated_at = ?1, finished_at = ?1
       WHERE status IN ('claimed', 'running') AND lease_expires_at <= ?1`
    ).bind(now),
    env.DB.prepare(
      `UPDATE tasks
       SET status = CASE WHEN attempt_count < max_attempts THEN 'queued' ELSE 'timeout' END,
           lease_worker_id = NULL, lease_namespace = NULL, lease_expires_at = NULL, lease_claim_id = NULL,
           updated_at = ?1, finished_at = CASE WHEN attempt_count < max_attempts THEN NULL ELSE ?1 END
       WHERE status IN ('claimed', 'running') AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?1`
    ).bind(now),
  ]);
}

async function handlePoll(request: Request, env: Env, context: WorkerContext): Promise<Response> {
  await reapExpired(env);
  const body = await bodyJson(request);
  const availableSlots = Math.min(4, Math.max(0, Number(body?.available_slots ?? 1)));
  if (!Number.isFinite(availableSlots) || availableSlots < 1) {
    return json({ offers: [], poll_after_seconds: 15 });
  }

  const now = nowSeconds();
  const active = await env.DB.prepare(
    `SELECT attempt_id FROM worker_attempts
     WHERE worker_id = ?1 AND status IN ('claimed', 'running') AND lease_expires_at > ?2 LIMIT 1`
  ).bind(context.workerId, now).first<{ attempt_id: string }>();
  if (active) return json({ offers: [], poll_after_seconds: 15, active_attempt_id: active.attempt_id });

  const task = await env.DB.prepare(
    `SELECT t.task_id, t.title, t.task_class, t.attempt_count, t.max_attempts
     FROM tasks t
     WHERE t.status = 'queued' AND t.created_by = ?3
       AND (?1 <> 'student_untrusted' OR t.task_class = 'public')
       AND NOT EXISTS (
         SELECT 1 FROM worker_offers o
         WHERE o.task_id = t.task_id AND o.accepted_at IS NULL AND o.expires_at > ?2
       )
     ORDER BY t.created_at ASC LIMIT 1`
  ).bind(context.trustLevel, now, context.userId).first<{
    task_id: string;
    title: string;
    task_class: string;
    attempt_count: number;
    max_attempts: number;
  }>();
  if (!task) return json({ offers: [], poll_after_seconds: 15 });

  const offerId = id();
  const expiresAt = now + OFFER_TTL_SECONDS;
  try {
    await env.DB.prepare(
      `INSERT INTO worker_offers (offer_id, task_id, worker_id, namespace, expires_at, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
    ).bind(offerId, task.task_id, context.workerId, context.namespace, expiresAt, now).run();
  } catch {
    return json({ offers: [], poll_after_seconds: 5 });
  }
  return json({
    offers: [{
      offer_id: offerId,
      task_id: task.task_id,
      task_class: task.task_class,
      title: task.title,
      attempt_count: task.attempt_count,
      max_attempts: task.max_attempts,
      expires_at: new Date(expiresAt * 1000).toISOString(),
      expires_in_seconds: OFFER_TTL_SECONDS,
      required_runtime: "infinity-worker-control-v1",
    }],
    poll_after_seconds: 5,
  });
}

async function handleAcceptOffer(
  request: Request,
  env: Env,
  context: WorkerContext,
  offerId: string,
): Promise<Response> {
  const now = nowSeconds();
  const offer = await env.DB.prepare(
    `SELECT o.offer_id, o.task_id, o.expires_at, o.accepted_at,
            t.status, t.task_class, t.lease_epoch
     FROM worker_offers o JOIN tasks t ON t.task_id = o.task_id
     WHERE o.offer_id = ?1 AND o.worker_id = ?2 AND o.namespace = ?3`
  ).bind(offerId, context.workerId, context.namespace).first<{
    offer_id: string;
    task_id: string;
    expires_at: number;
    accepted_at: number | null;
    status: string;
    task_class: string;
    lease_epoch: number;
  }>();
  if (!offer || offer.accepted_at != null || offer.expires_at <= now || offer.status !== "queued") {
    return errorJson("Worker offer is expired or unavailable", 409, "OFFER_UNAVAILABLE");
  }
  if (context.trustLevel === "student_untrusted" && offer.task_class !== "public") {
    return errorJson("Worker is not trusted for this task", 403, "TASK_TRUST_MISMATCH");
  }
  const accepted = await env.DB.prepare(
    `UPDATE worker_offers SET accepted_at = ?3
     WHERE offer_id = ?1 AND worker_id = ?2 AND accepted_at IS NULL AND expires_at > ?3`
  ).bind(offerId, context.workerId, now).run();
  if ((accepted.meta?.changes ?? 0) !== 1) return errorJson("Offer was already accepted", 409, "OFFER_REPLAY");

  const attemptId = id();
  const claimId = id();
  const epoch = Number(offer.lease_epoch || 0) + 1;
  const leaseExpiresAt = now + LEASE_TTL_SECONDS;
  const eventId = id();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE tasks
       SET status = 'claimed', attempt_count = attempt_count + 1,
           lease_worker_id = ?2, lease_namespace = ?3, lease_epoch = ?4,
           lease_expires_at = ?5, lease_claim_id = ?6, updated_at = ?7
       WHERE task_id = ?1 AND status = 'queued' AND task_class = ?8`
    ).bind(offer.task_id, context.workerId, context.namespace, epoch, leaseExpiresAt, claimId, now, offer.task_class),
    env.DB.prepare(
      `INSERT INTO worker_attempts
        (attempt_id, task_id, worker_id, namespace, fencing_epoch,
         lease_expires_at, status, created_at, updated_at)
       SELECT ?1, task_id, ?2, ?3, ?4, ?5, 'claimed', ?6, ?6
       FROM tasks
       WHERE task_id = ?7 AND lease_claim_id = ?8 AND lease_worker_id = ?2`
    ).bind(attemptId, context.workerId, context.namespace, epoch, leaseExpiresAt, now, offer.task_id, claimId),
    env.DB.prepare(
      `INSERT INTO task_events (task_event_id, task_id, event_type, event_data, created_at)
       SELECT ?1, task_id, 'task_claimed', ?2, ?3 FROM tasks
       WHERE task_id = ?4 AND lease_claim_id = ?5`
    ).bind(eventId, JSON.stringify({ worker_id: context.workerId, attempt_id: attemptId, fencing_epoch: epoch }), now, offer.task_id, claimId),
  ]);

  const attempt = await loadAttempt(env, context, attemptId, epoch, false);
  if (!attempt) return errorJson("Task was claimed by another Worker", 409, "TASK_CLAIM_LOST");
  return json(publicAttempt(attempt, new URL(request.url).origin), 201);
}

async function handleHeartbeat(
  request: Request,
  env: Env,
  context: WorkerContext,
  attemptId: string,
): Promise<Response> {
  const body = await bodyJson(request);
  const epoch = Number(body?.fencing_epoch);
  if (!Number.isInteger(epoch) || epoch < 1) return errorJson("fencing_epoch is required", 400, "INVALID_EPOCH");
  const attempt = await loadAttempt(env, context, attemptId, epoch, true);
  if (!attempt) return errorJson("Attempt lease is expired or fenced", 409, "LEASE_FENCED");
  const now = nowSeconds();
  const leaseExpiresAt = now + LEASE_TTL_SECONDS;
  const progress = safeText(body?.progress, 240);
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE tasks SET status = 'running', lease_expires_at = ?5, updated_at = ?5
       WHERE task_id = ?1 AND lease_worker_id = ?2 AND lease_namespace = ?3 AND lease_epoch = ?4
         AND status IN ('claimed', 'running') AND lease_expires_at > ?6
         AND EXISTS (
           SELECT 1 FROM worker_attempts a
           WHERE a.attempt_id = ?7 AND a.task_id = tasks.task_id
             AND a.worker_id = ?2 AND a.namespace = ?3 AND a.fencing_epoch = ?4
             AND a.status IN ('claimed', 'running') AND a.lease_expires_at > ?6
         )`
    ).bind(attempt.task_id, context.workerId, context.namespace, epoch, leaseExpiresAt, now, attemptId),
    env.DB.prepare(
      `UPDATE worker_attempts SET status = 'running', lease_expires_at = ?5, updated_at = ?5
       WHERE attempt_id = ?1 AND worker_id = ?2 AND namespace = ?3 AND fencing_epoch = ?4
         AND status IN ('claimed', 'running') AND lease_expires_at > ?6
         AND EXISTS (SELECT 1 FROM tasks WHERE task_id = ?7 AND status = 'running' AND lease_worker_id = ?2 AND lease_namespace = ?3 AND lease_epoch = ?4)`
    ).bind(attemptId, context.workerId, context.namespace, epoch, leaseExpiresAt, now, attempt.task_id),
  ]);
  const changed = (results[0] as { meta?: { changes?: number } })?.meta?.changes ?? 0;
  if (changed !== 1) return errorJson("Attempt lease is expired or fenced", 409, "LEASE_FENCED");
  const updated = await loadAttempt(env, context, attemptId, epoch, true);
  if (!updated) return errorJson("Attempt lease is expired or fenced", 409, "LEASE_FENCED");
  return json({
    ...publicAttempt(updated, new URL(request.url).origin),
    progress: progress || null,
  });
}

async function handleFailure(
  request: Request,
  env: Env,
  context: WorkerContext,
  attemptId: string,
): Promise<Response> {
  const body = await bodyJson(request);
  const epoch = Number(body?.fencing_epoch);
  if (!Number.isInteger(epoch) || epoch < 1) return errorJson("fencing_epoch is required", 400, "INVALID_EPOCH");
  const attempt = await loadAttempt(env, context, attemptId, epoch, true);
  if (!attempt) return errorJson("Attempt lease is expired or fenced", 409, "LEASE_FENCED");
  const retryable = body?.retryable === true && attempt.attempt_count < attempt.max_attempts;
  const nextStatus = retryable ? "queued" : "failed";
  const errorCode = safeText(body?.error_code, 80) || "WORKER_FAILURE";
  const errorMessage = safeText(body?.error_message, MAX_ERROR_LENGTH) || "Worker reported a failure";
  const now = nowSeconds();
  const taskEventId = id();
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE tasks SET status = ?2, error_message = ?3,
           finished_at = CASE WHEN ?2 = 'queued' THEN NULL ELSE ?4 END,
           lease_worker_id = NULL, lease_namespace = NULL, lease_expires_at = NULL, lease_claim_id = NULL, updated_at = ?4
       WHERE task_id = ?1 AND lease_worker_id = ?5 AND lease_namespace = ?6 AND lease_epoch = ?7
         AND status IN ('claimed', 'running')
         AND EXISTS (
           SELECT 1 FROM worker_attempts a
           WHERE a.attempt_id = ?8 AND a.worker_id = ?5 AND a.namespace = ?6 AND a.fencing_epoch = ?7
             AND a.status IN ('claimed', 'running') AND a.lease_expires_at > ?4
         )`
    ).bind(attempt.task_id, nextStatus, errorMessage, now, context.workerId, context.namespace, epoch, attemptId),
    env.DB.prepare(
      `UPDATE worker_attempts
       SET status = 'failed', error_code = ?5, error_message = ?6,
           updated_at = ?7, finished_at = ?7
       WHERE attempt_id = ?1 AND worker_id = ?2 AND namespace = ?3 AND fencing_epoch = ?4
         AND status IN ('claimed', 'running') AND lease_expires_at > ?7
         AND EXISTS (SELECT 1 FROM tasks WHERE task_id = ?8 AND status = ?9 AND result_artifact_id IS NULL AND lease_worker_id IS NULL)`
    ).bind(attemptId, context.workerId, context.namespace, epoch, errorCode, errorMessage, now, attempt.task_id, nextStatus),
    env.DB.prepare(
      `INSERT INTO task_events (task_event_id, task_id, event_type, event_data, created_at)
       SELECT ?1, task_id, ?3, ?4, ?5 FROM tasks
       WHERE task_id = ?2 AND status = ?6 AND result_artifact_id IS NULL
         AND EXISTS (SELECT 1 FROM worker_attempts WHERE attempt_id = ?7 AND status = 'failed')`
    ).bind(taskEventId, attempt.task_id, retryable ? "task_requeued" : "task_failed", JSON.stringify({ error_code: errorCode, attempt_id: attemptId }), now, nextStatus, attemptId),
  ]);
  const taskChanged = (results[0] as { meta?: { changes?: number } })?.meta?.changes ?? 0;
  if (taskChanged !== 1) return errorJson("Attempt lease is expired or fenced", 409, "LEASE_FENCED");
  return json({ attempt_id: attemptId, task_id: attempt.task_id, status: nextStatus, retryable });
}

async function handleResource(
  request: Request,
  env: Env,
  context: WorkerContext,
  attemptId: string,
  resourceId: string,
): Promise<Response> {
  if (!env.RESOURCE_BUCKET) return errorJson("Task resource storage is not configured", 503, "RESOURCE_STORAGE_UNAVAILABLE");
  const epoch = Number(request.headers.get("x-fencing-epoch"));
  if (!Number.isInteger(epoch) || epoch < 1) return errorJson("x-fencing-epoch is required", 400, "INVALID_EPOCH");
  const attempt = await loadAttempt(env, context, attemptId, epoch, true);
  if (!attempt) return errorJson("Attempt lease is expired or fenced", 409, "LEASE_FENCED");
  const resource = await env.DB.prepare(
    `SELECT r.object_key, r.logical_name, r.content_type
     FROM task_resources r
     WHERE r.resource_id = ?1 AND (
       r.resource_id = (SELECT resource_id FROM method_sources WHERE method_source_id = ?2)
       OR r.resource_id = (SELECT resource_id FROM dataset_snapshots WHERE dataset_snapshot_id = ?3)
     )`
  ).bind(resourceId, attempt.method_source_id, attempt.dataset_snapshot_id).first<{
    object_key: string;
    logical_name: string;
    content_type: string;
  }>();
  if (!resource) return errorJson("Attempt resource not found", 404, "RESOURCE_NOT_FOUND");
  const object = await env.RESOURCE_BUCKET.get(resource.object_key);
  if (!object) return errorJson("Attempt resource not found", 404, "RESOURCE_NOT_FOUND");
  const headers = new Headers({
    "cache-control": "no-store",
    "content-type": resource.content_type || "application/octet-stream",
    "content-disposition": `attachment; filename="${safeFilename(resource.logical_name, "input.bin")}"`,
  });
  object.writeHttpMetadata(headers);
  return new Response(object.body, { headers });
}

async function handleArtifactUpload(
  request: Request,
  env: Env,
  context: WorkerContext,
  attemptId: string,
): Promise<Response> {
  if (!env.RESOURCE_BUCKET) return errorJson("Task resource storage is not configured", 503, "RESOURCE_STORAGE_UNAVAILABLE");
  let form: FormData;
  try { form = await request.formData(); } catch { return errorJson("Invalid multipart upload", 400, "INVALID_UPLOAD"); }
  const epoch = Number(form.get("fencing_epoch"));
  const fileEntry = form.get("file") as unknown as File | string | null;
  if (!Number.isInteger(epoch) || epoch < 1 || !fileEntry || typeof fileEntry === "string") {
    return errorJson("fencing_epoch and file are required", 400, "INVALID_UPLOAD");
  }
  const file = fileEntry;
  if (file.size <= 0 || file.size > uploadLimit(env)) return errorJson("Artifact exceeds the configured limit", 413, "UPLOAD_TOO_LARGE");
  const attempt = await loadAttempt(env, context, attemptId, epoch, true);
  if (!attempt) return errorJson("Attempt lease is expired or fenced", 409, "LEASE_FENCED");
  const bytes = await file.arrayBuffer();
  const checksum = await sha256(bytes);
  const artifactId = id();
  const key = `task-outputs/quarantine/${context.workerId}/${attemptId}/${artifactId}-${safeFilename(file.name, "artifact.bin")}`;
  await env.RESOURCE_BUCKET.put(key, bytes, {
    httpMetadata: { contentType: file.type || "application/octet-stream" },
    customMetadata: { task_id: attempt.task_id, attempt_id: attemptId, worker_id: context.workerId, status: "quarantine" },
  });
  try {
    await env.DB.prepare(
      `INSERT INTO artifacts
        (artifact_id, task_id, attempt_id, worker_id, name, kind, object_key,
         file_size_bytes, checksum_sha256, content_type, status, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 'quarantine', ?6, ?7, ?8, ?9, 'quarantine', ?10)`
    ).bind(
      artifactId,
      attempt.task_id,
      attemptId,
      context.workerId,
      safeFilename(file.name, "artifact.bin"),
      key,
      bytes.byteLength,
      checksum,
      file.type || "application/octet-stream",
      nowSeconds(),
    ).run();
  } catch {
    await env.RESOURCE_BUCKET.delete(key);
    return errorJson("Artifact could not be registered", 503, "ARTIFACT_UNAVAILABLE");
  }
  return json({ artifact_id: artifactId, task_id: attempt.task_id, attempt_id: attemptId, checksum_sha256: checksum, file_size_bytes: bytes.byteLength }, 201);
}

async function handleFinalize(
  request: Request,
  env: Env,
  context: WorkerContext,
  attemptId: string,
): Promise<Response> {
  const body = await bodyJson(request);
  const epoch = Number(body?.fencing_epoch);
  const artifactId = safeText(body?.artifact_id, 120);
  const manifest = body?.manifest && typeof body.manifest === "object" ? body.manifest as Record<string, unknown> : null;
  if (!Number.isInteger(epoch) || epoch < 1 || !artifactId || !manifest) return errorJson("fencing_epoch, artifact_id and manifest are required", 400, "INVALID_FINALIZE");
  const attempt = await loadAttempt(env, context, attemptId, epoch, true);
  if (!attempt) return errorJson("Attempt lease is expired or fenced", 409, "LEASE_FENCED");
  if (safeText(manifest.task_id, 120) !== attempt.task_id || safeText(manifest.attempt_id, 120) !== attemptId || Number(manifest.fencing_epoch) !== epoch) {
    return errorJson("Manifest is not bound to this attempt", 400, "MANIFEST_MISMATCH");
  }
  const manifestText = JSON.stringify(manifest);
  if (manifestText.length > 128 * 1024) return errorJson("Manifest is too large", 413, "MANIFEST_TOO_LARGE");
  const artifact = await env.DB.prepare(
    `SELECT artifact_id, object_key, checksum_sha256, file_size_bytes, status
     FROM artifacts
     WHERE artifact_id = ?1 AND task_id = ?2 AND attempt_id = ?3 AND worker_id = ?4 AND status = 'quarantine'`
  ).bind(artifactId, attempt.task_id, attemptId, context.workerId).first<{
    artifact_id: string;
    object_key: string;
    checksum_sha256: string;
    file_size_bytes: number;
    status: string;
  }>();
  if (!artifact) return errorJson("Quarantine artifact not found", 404, "ARTIFACT_NOT_FOUND");
  if (!env.RESOURCE_BUCKET || !(await env.RESOURCE_BUCKET.head(artifact.object_key))) {
    return errorJson("Quarantine artifact is missing", 409, "ARTIFACT_MISSING");
  }
  const suppliedChecksum = safeText(manifest.checksum_sha256, 128);
  if (suppliedChecksum && suppliedChecksum !== artifact.checksum_sha256) return errorJson("Manifest checksum does not match artifact", 400, "CHECKSUM_MISMATCH");

  const now = nowSeconds();
  const eventId = id();
  const results = await env.DB.batch([
    // A Worker can only move its Attempt into verification_pending. It cannot
    // publish a user-visible result merely by self-reporting success.
    env.DB.prepare(
      `UPDATE tasks SET status = 'running', result_artifact_id = NULL,
           finished_at = NULL, updated_at = ?3,
           lease_worker_id = NULL, lease_namespace = NULL, lease_expires_at = NULL, lease_claim_id = NULL
       WHERE task_id = ?1 AND lease_worker_id = ?4 AND lease_namespace = ?5 AND lease_epoch = ?6
         AND status IN ('claimed', 'running') AND lease_expires_at > ?3`
    ).bind(attempt.task_id, artifactId, now, context.workerId, context.namespace, epoch),
    env.DB.prepare(
      `UPDATE worker_attempts SET status = 'succeeded', updated_at = ?4, finished_at = ?4
       WHERE attempt_id = ?1 AND worker_id = ?2 AND namespace = ?3 AND fencing_epoch = ?5
         AND EXISTS (SELECT 1 FROM tasks WHERE task_id = ?6 AND status = 'running' AND result_artifact_id IS NULL AND lease_worker_id IS NULL)`
    ).bind(attemptId, context.workerId, context.namespace, now, epoch, attempt.task_id),
    env.DB.prepare(
      `UPDATE artifacts SET manifest_json = ?4
       WHERE artifact_id = ?1 AND task_id = ?2 AND attempt_id = ?3 AND status = 'quarantine'`
    ).bind(artifactId, attempt.task_id, attemptId, manifestText),
    env.DB.prepare(
      `INSERT INTO task_events (task_event_id, task_id, event_type, event_data, created_at)
       SELECT ?1, ?2, 'artifact_quarantined', ?3, ?4 FROM tasks
       WHERE task_id = ?2 AND status = 'running' AND result_artifact_id IS NULL
         AND EXISTS (SELECT 1 FROM worker_attempts WHERE attempt_id = ?5 AND status = 'succeeded')`
    ).bind(eventId, attempt.task_id, JSON.stringify({ attempt_id: attemptId, artifact_id: artifactId, status: "verification_pending" }), now, attemptId),
  ]);
  const taskChanged = (results[0] as { meta?: { changes?: number } })?.meta?.changes ?? 0;
  if (taskChanged !== 1) return errorJson("Attempt lease is expired or fenced", 409, "LEASE_FENCED");
  return json({ task_id: attempt.task_id, attempt_id: attemptId, artifact_id: artifactId, status: "verification_pending", verifier_required: true }, 202);
}

async function verifierAuthorized(request: Request, env: Env): Promise<boolean> {
  const configured = env.WORKER_VERIFIER_TOKEN?.trim();
  const supplied = request.headers.get("x-worker-verifier-token")?.trim();
  if (!configured || !supplied || supplied.length > 512) return false;
  return (await sha256(configured)) === (await sha256(supplied));
}

async function handleVerifiedPublish(request: Request, env: Env, attemptId: string): Promise<Response> {
  if (!env.WORKER_VERIFIER_TOKEN) return errorJson("Trusted verifier is not configured", 503, "VERIFIER_NOT_CONFIGURED");
  if (!(await verifierAuthorized(request, env))) return errorJson("Trusted verifier authentication required", 401, "VERIFIER_UNAUTHENTICATED");
  const body = await bodyJson(request);
  const artifactId = safeText(body?.artifact_id, 120);
  if (!artifactId || body?.passed !== true) return errorJson("A passing verifier result is required", 400, "VERIFICATION_REQUIRED");
  const row = await env.DB.prepare(
    `SELECT a.artifact_id, a.task_id, a.attempt_id, a.checksum_sha256, a.manifest_json,
            t.status AS task_status, wa.fencing_epoch, wa.status AS attempt_status
     FROM artifacts a
     JOIN tasks t ON t.task_id = a.task_id
     JOIN worker_attempts wa ON wa.attempt_id = a.attempt_id AND wa.task_id = a.task_id
     WHERE a.artifact_id = ?1 AND a.attempt_id = ?2 AND a.status = 'quarantine'
       AND t.status = 'running' AND wa.status = 'succeeded'`
  ).bind(artifactId, attemptId).first<{
    artifact_id: string;
    task_id: string;
    attempt_id: string;
    checksum_sha256: string;
    manifest_json: string | null;
    task_status: string;
    fencing_epoch: number;
    attempt_status: string;
  }>();
  if (!row || !row.manifest_json) return errorJson("Quarantine artifact is not ready for verification", 409, "VERIFICATION_NOT_READY");
  let manifest: Record<string, unknown>;
  try {
    const parsed = JSON.parse(row.manifest_json);
    if (!parsed || typeof parsed !== "object") throw new Error("manifest");
    manifest = parsed as Record<string, unknown>;
  } catch {
    return errorJson("Quarantine manifest is invalid", 422, "MANIFEST_INVALID");
  }
  if (safeText(manifest.task_id, 120) !== row.task_id || safeText(manifest.attempt_id, 120) !== attemptId || Number(manifest.fencing_epoch) !== row.fencing_epoch) {
    return errorJson("Quarantine manifest is not bound to the Attempt", 422, "MANIFEST_MISMATCH");
  }
  if (safeText(manifest.checksum_sha256, 128) !== row.checksum_sha256) return errorJson("Quarantine checksum is invalid", 422, "CHECKSUM_MISMATCH");
  const now = nowSeconds();
  const eventId = id();
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE tasks SET status = 'succeeded', result_artifact_id = ?2,
           finished_at = ?3, updated_at = ?3
       WHERE task_id = ?1 AND status = 'running' AND result_artifact_id IS NULL`
    ).bind(row.task_id, artifactId, now),
    env.DB.prepare(
      `UPDATE artifacts SET kind = 'result', status = 'published'
       WHERE artifact_id = ?1 AND task_id = ?2 AND attempt_id = ?3 AND status = 'quarantine'
         AND EXISTS (SELECT 1 FROM tasks WHERE task_id = ?2 AND status = 'succeeded' AND result_artifact_id = ?1)`
    ).bind(artifactId, row.task_id, attemptId),
    env.DB.prepare(
      `INSERT INTO task_events (task_event_id, task_id, event_type, event_data, created_at)
       SELECT ?1, ?2, 'task_succeeded', ?3, ?4 FROM tasks
       WHERE task_id = ?2 AND status = 'succeeded' AND result_artifact_id = ?5`
    ).bind(eventId, row.task_id, JSON.stringify({ attempt_id: attemptId, artifact_id: artifactId, verified: true }), now, artifactId),
  ]);
  const changed = (results[0] as { meta?: { changes?: number } })?.meta?.changes ?? 0;
  if (changed !== 1) return errorJson("Task is no longer awaiting verification", 409, "VERIFICATION_REPLAY");
  return json({ task_id: row.task_id, attempt_id: attemptId, artifact_id: artifactId, status: "succeeded", verified: true });
}

async function workerHealth(env: Env, context: WorkerContext): Promise<Response> {
  const now = nowSeconds();
  const attempts = await env.DB.prepare(
    `SELECT attempt_id, task_id, fencing_epoch, lease_expires_at, status
     FROM worker_attempts WHERE worker_id = ?1 AND namespace = ?2 AND status IN ('claimed', 'running') ORDER BY created_at DESC LIMIT 4`
  ).bind(context.workerId, context.namespace).all<Record<string, unknown>>();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE worker_registrations SET last_seen_at = ?3
       WHERE worker_id = ?1 AND namespace = ?2 AND status = 'active'`
    ).bind(context.workerId, context.namespace, now),
    env.DB.prepare(
      `UPDATE worker_enrollments SET last_seen_at = ?3
       WHERE worker_id = ?1 AND namespace = ?2 AND status = 'active'`
    ).bind(context.workerId, context.namespace, now),
  ]);
  return json({ worker_id: context.workerId, namespace: context.namespace, trust_level: context.trustLevel, status: "active", attempts: attempts.results ?? [] });
}

export async function handleWorkerControlApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.protocol !== "https:") {
    return errorJson("HTTPS is required for Worker control", 400, "HTTPS_REQUIRED");
  }
  const { pathname } = url;
  if (request.method === "POST" && pathname === "/api/worker/v1/enroll") return handleEnroll(request, env);

  const verifierMatch = pathname.match(/^\/api\/worker\/v1\/verifier\/attempts\/([^/]+)\/publish$/);
  if (verifierMatch && request.method === "POST") return handleVerifiedPublish(request, env, decodeURIComponent(verifierMatch[1]));

  const context = await authenticateWorker(request, env);
  if (!context) return unauthorized();
  if (request.method === "GET" && pathname === "/api/worker/v1/health") return workerHealth(env, context);
  if (request.method === "POST" && pathname === "/api/worker/v1/poll") return handlePoll(request, env, context);

  const offerMatch = pathname.match(/^\/api\/worker\/v1\/offers\/([^/]+)\/accept$/);
  if (offerMatch && request.method === "POST") return handleAcceptOffer(request, env, context, decodeURIComponent(offerMatch[1]));

  const heartbeatMatch = pathname.match(/^\/api\/worker\/v1\/attempts\/([^/]+)\/heartbeat$/);
  if (heartbeatMatch && request.method === "POST") return handleHeartbeat(request, env, context, decodeURIComponent(heartbeatMatch[1]));

  const failureMatch = pathname.match(/^\/api\/worker\/v1\/attempts\/([^/]+)\/fail$/);
  if (failureMatch && request.method === "POST") return handleFailure(request, env, context, decodeURIComponent(failureMatch[1]));

  const resourceMatch = pathname.match(/^\/api\/worker\/v1\/attempts\/([^/]+)\/resources\/([^/]+)$/);
  if (resourceMatch && request.method === "GET") {
    return handleResource(request, env, context, decodeURIComponent(resourceMatch[1]), decodeURIComponent(resourceMatch[2]));
  }

  const artifactMatch = pathname.match(/^\/api\/worker\/v1\/attempts\/([^/]+)\/artifacts$/);
  if (artifactMatch && request.method === "POST") return handleArtifactUpload(request, env, context, decodeURIComponent(artifactMatch[1]));

  const finalizeMatch = pathname.match(/^\/api\/worker\/v1\/attempts\/([^/]+)\/finalize$/);
  if (finalizeMatch && request.method === "POST") return handleFinalize(request, env, context, decodeURIComponent(finalizeMatch[1]));

  return errorJson("Not found", 404, "NOT_FOUND");
}
