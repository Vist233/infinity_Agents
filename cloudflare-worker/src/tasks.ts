import type { AuthedUser } from "./auth";
import type { Env } from "./env";
import { errorJson, json, nowSeconds } from "./http";
import { bindChatTaskConfirmation, getChatTaskConfirmationForUser } from "./db";

const DEFAULT_PROJECT_NAME = "Default Project";
const MAX_TITLE_LENGTH = 200;
const MAX_FILENAME_LENGTH = 240;
const DEFAULT_UPLOAD_LIMIT = 25 * 1024 * 1024;
const METHOD_EXTENSIONS = new Set([".html", ".htm", ".pdf", ".md", ".txt", ".doc", ".docx"]);

interface ProjectRow {
  project_id: string;
  name: string;
  created_at: number;
}

interface ResourceRow {
  resource_id: string;
  project_id: string;
  logical_name: string;
  object_key: string;
  content_type: string;
  file_size_bytes: number;
  file_hash_sha256: string;
}

interface TaskRow {
  task_id: string;
  task_spec_id: string;
  dataset_snapshot_id: string;
  project_id: string;
  method_source_id: string | null;
  title: string;
  status: string;
  attempt_count: number;
  max_attempts: number;
  result_artifact_id: string | null;
  error_message: string | null;
  created_by: string;
  created_at: number;
  updated_at: number;
  finished_at: number | null;
  chat_confirmation_id: string | null;
}

function iso(value: number | null | undefined): string | null {
  return value == null ? null : new Date(value * 1000).toISOString();
}

function safeName(value: string, fallback: string): string {
  const name = value.split(/[\\/]/).pop()?.trim() || fallback;
  return name.slice(0, MAX_FILENAME_LENGTH);
}

function uploadLimit(env: Env): number {
  const configured = Number(env.TASK_UPLOAD_MAX_BYTES);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_UPLOAD_LIMIT;
}

function taskId(): string {
  return crypto.randomUUID();
}

async function sha256(value: ArrayBuffer | Uint8Array | string): Promise<string> {
  const data = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function jsonBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const value = await request.json();
    return value && typeof value === "object" ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

async function defaultProject(env: Env, user: AuthedUser): Promise<ProjectRow> {
  const projectId = taskId();
  const row = await env.DB.prepare(
    `INSERT INTO projects (project_id, user_id, name, created_at)
     VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(user_id) DO UPDATE SET name = excluded.name
     RETURNING project_id, name, created_at`
  ).bind(projectId, user.userId, DEFAULT_PROJECT_NAME, nowSeconds()).first<ProjectRow>();
  if (!row) throw new Error("Default project could not be created");
  return row;
}

async function ownsProject(env: Env, projectId: string, user: AuthedUser): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT 1 AS ok FROM projects WHERE project_id = ?1 AND user_id = ?2"
  ).bind(projectId, user.userId).first<{ ok: number }>();
  return Boolean(row);
}

function publicProject(row: ProjectRow): Record<string, unknown> {
  return { project_id: row.project_id, name: row.name, created_at: iso(row.created_at) };
}

async function storeUpload(
  env: Env,
  user: AuthedUser,
  projectId: string,
  kind: "method" | "dataset",
  file: File,
): Promise<ResourceRow | Response> {
  if (!env.RESOURCE_BUCKET) {
    return errorJson("Task resource storage is not configured", 503, "RESOURCE_STORAGE_UNAVAILABLE");
  }
  if (!file || file.size <= 0 || file.size > uploadLimit(env)) {
    return errorJson("Uploaded file is empty or exceeds the configured limit", 413, "UPLOAD_TOO_LARGE");
  }

  const name = safeName(file.name, kind === "dataset" ? "dataset.zip" : "method.txt");
  if (kind === "method" && !METHOD_EXTENSIONS.has(name.slice(name.lastIndexOf(".")).toLowerCase())) {
    return errorJson("Unsupported method source type", 400, "UNSUPPORTED_METHOD_SOURCE");
  }
  if (kind === "dataset" && !name.toLowerCase().endsWith(".zip")) {
    return errorJson("Dataset must be a ZIP archive", 400, "UNSUPPORTED_DATASET");
  }

  const bytes = await file.arrayBuffer();
  if (bytes.byteLength > uploadLimit(env)) {
    return errorJson("Uploaded file exceeds the configured limit", 413, "UPLOAD_TOO_LARGE");
  }
  if (kind === "dataset") {
    const header = new Uint8Array(bytes.slice(0, 4));
    if (header.length < 2 || header[0] !== 0x50 || header[1] !== 0x4b) {
      return errorJson("Dataset is not a ZIP archive", 400, "INVALID_DATASET");
    }
  }

  const resourceId = taskId();
  const hash = await sha256(bytes);
  const objectKey = `task-inputs/${user.userId}/${kind}/${resourceId}`;
  await env.RESOURCE_BUCKET.put(objectKey, bytes, {
    httpMetadata: { contentType: file.type || "application/octet-stream" },
    customMetadata: { owner_user_id: user.userId, project_id: projectId, kind },
  });
  const contentType = file.type || "application/octet-stream";
  await env.DB.prepare(
    `INSERT INTO task_resources
      (resource_id, project_id, user_id, kind, logical_name, object_key, content_type,
       file_size_bytes, file_hash_sha256, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`
  ).bind(
    resourceId,
    projectId,
    user.userId,
    kind,
    name,
    objectKey,
    contentType,
    bytes.byteLength,
    hash,
    nowSeconds(),
  ).run();

  return {
    resource_id: resourceId,
    project_id: projectId,
    logical_name: name,
    object_key: objectKey,
    content_type: contentType,
    file_size_bytes: bytes.byteLength,
    file_hash_sha256: hash,
  };
}

async function handleDefaultProject(env: Env, user: AuthedUser): Promise<Response> {
  try {
    return json(publicProject(await defaultProject(env, user)));
  } catch {
    return errorJson("Default project is unavailable", 503, "PROJECT_UNAVAILABLE");
  }
}

async function handleMethodUpload(request: Request, env: Env, user: AuthedUser): Promise<Response> {
  let form: FormData;
  try { form = await request.formData(); } catch { return errorJson("Invalid multipart upload", 400, "INVALID_UPLOAD"); }
  const file = form.get("file");
  if (!file || typeof file === "string") return errorJson("file is required", 400, "INVALID_UPLOAD");
  const project = await defaultProject(env, user);
  const resource = await storeUpload(env, user, project.project_id, "method", file);
  if (resource instanceof Response) return resource;
  const methodId = taskId();
  await env.DB.prepare(
    `INSERT INTO method_sources
      (method_source_id, project_id, user_id, original_filename, resource_id, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
  ).bind(methodId, project.project_id, user.userId, resource.logical_name, resource.resource_id, nowSeconds()).run();
  return json({
    method_source_id: methodId,
    project_id: project.project_id,
    original_filename: resource.logical_name,
    file_hash_sha256: resource.file_hash_sha256,
    file_size_bytes: resource.file_size_bytes,
  }, 201);
}

async function handleDatasetUpload(request: Request, env: Env, user: AuthedUser): Promise<Response> {
  let form: FormData;
  try { form = await request.formData(); } catch { return errorJson("Invalid multipart upload", 400, "INVALID_UPLOAD"); }
  const projectId = String(form.get("project_id") ?? "");
  const file = form.get("file");
  if (!projectId || !file || typeof file === "string") return errorJson("project_id and file are required", 400, "INVALID_UPLOAD");
  if (!(await ownsProject(env, projectId, user))) return errorJson("Project not found", 404, "PROJECT_NOT_FOUND");
  const resource = await storeUpload(env, user, projectId, "dataset", file);
  if (resource instanceof Response) return resource;
  return json({
    resource_id: resource.resource_id,
    project_id: projectId,
    logical_name: resource.logical_name,
    file_hash_sha256: resource.file_hash_sha256,
    file_size_bytes: resource.file_size_bytes,
  }, 201);
}

async function handleTaskSpec(request: Request, env: Env, user: AuthedUser): Promise<Response> {
  const body = await jsonBody(request);
  const projectId = String(body?.project_id ?? "");
  const title = String(body?.title ?? "").trim();
  if (!projectId || !title || title.length > MAX_TITLE_LENGTH) return errorJson("Invalid task specification", 400, "INVALID_TASK_SPEC");
  if (!(await ownsProject(env, projectId, user))) return errorJson("Project not found", 404, "PROJECT_NOT_FOUND");
  const id = taskId();
  const now = nowSeconds();
  await env.DB.prepare(
    `INSERT INTO task_specs
      (task_spec_id, project_id, user_id, title, analysis_type, research_question,
       revision, status, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, 'draft', ?7, ?7)`
  ).bind(id, projectId, user.userId, title, String(body?.analysis_type ?? "generic"), String(body?.research_question ?? ""), now).run();
  return json({ task_spec_id: id, revision: 1, status: "draft" }, 201);
}

async function handleFreezeTaskSpec(taskSpecId: string, env: Env, user: AuthedUser): Promise<Response> {
  const result = await env.DB.prepare(
    `UPDATE task_specs SET status = 'active', frozen_at = ?3, updated_at = ?3
     WHERE task_spec_id = ?1 AND user_id = ?2 AND status = 'draft'`
  ).bind(taskSpecId, user.userId, nowSeconds()).run();
  if ((result.meta?.changes ?? 0) !== 1) return errorJson("TaskSpec is already frozen or does not exist", 409, "TASK_SPEC_NOT_FREEZABLE");
  return json({ task_spec_id: taskSpecId, status: "active", frozen: true });
}

async function handleDatasetSnapshot(request: Request, env: Env, user: AuthedUser): Promise<Response> {
  const body = await jsonBody(request);
  const projectId = String(body?.project_id ?? "");
  const taskSpecId = String(body?.task_spec_id ?? "");
  const resourceId = String(body?.resource_id ?? "");
  const filename = safeName(String(body?.original_filename ?? "dataset.zip"), "dataset.zip");
  const spec = await env.DB.prepare(
    "SELECT task_spec_id FROM task_specs WHERE task_spec_id = ?1 AND project_id = ?2 AND user_id = ?3 AND status = 'active'"
  ).bind(taskSpecId, projectId, user.userId).first<{ task_spec_id: string }>();
  const resource = await env.DB.prepare(
    "SELECT * FROM task_resources WHERE resource_id = ?1 AND project_id = ?2 AND user_id = ?3 AND kind = 'dataset'"
  ).bind(resourceId, projectId, user.userId).first<ResourceRow>();
  if (!spec || !resource) return errorJson("Task input not found", 404, "TASK_INPUT_NOT_FOUND");
  const snapshotId = taskId();
  await env.DB.prepare(
    `INSERT INTO dataset_snapshots
      (dataset_snapshot_id, task_spec_id, project_id, user_id, original_filename,
       resource_id, file_hash_sha256, file_size_bytes, validation_passed, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, ?9)`
  ).bind(snapshotId, taskSpecId, projectId, user.userId, filename, resource.resource_id, resource.file_hash_sha256, resource.file_size_bytes, nowSeconds()).run();
  return json({ dataset_snapshot_id: snapshotId }, 201);
}

function publicTask(row: TaskRow): Record<string, unknown> {
  return {
    task_id: row.task_id,
    task_spec_id: row.task_spec_id,
    dataset_snapshot_id: row.dataset_snapshot_id,
    project_id: row.project_id,
    method_source_id: row.method_source_id,
    title: row.title,
    status: row.status,
    attempt_count: row.attempt_count,
    max_attempts: row.max_attempts,
    result_artifact_id: row.result_artifact_id,
    error_message: row.error_message,
    created_by: row.created_by,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
    finished_at: iso(row.finished_at),
  };
}

async function loadTask(taskIdValue: string, env: Env, user: AuthedUser): Promise<TaskRow | null> {
  return env.DB.prepare(
    `SELECT task_id, task_spec_id, dataset_snapshot_id, project_id, method_source_id,
            title, status, attempt_count, max_attempts, result_artifact_id,
            error_message, created_by, created_at, updated_at, finished_at,
            chat_confirmation_id
     FROM tasks WHERE task_id = ?1 AND created_by = ?2`
  ).bind(taskIdValue, user.userId).first<TaskRow>();
}

async function handleCreateTask(request: Request, env: Env, user: AuthedUser): Promise<Response> {
  const body = await jsonBody(request);
  const projectId = String(body?.project_id ?? "");
  const specId = String(body?.task_spec_id ?? "");
  const snapshotId = String(body?.dataset_snapshot_id ?? "");
  const title = String(body?.title ?? "").trim();
  const methodId = body?.method_source_id ? String(body.method_source_id) : null;
  const idempotencyKey = String(body?.idempotency_key ?? "");
  const chatConfirmationId = body?.chat_confirmation_id ? String(body.chat_confirmation_id).trim() : null;
  if (!chatConfirmationId) {
    return errorJson("Tasks must be submitted from an inline Agent confirmation", 400, "TASK_CONFIRMATION_REQUIRED");
  }
  if (!projectId || !specId || !snapshotId || !title || title.length > MAX_TITLE_LENGTH || !idempotencyKey || idempotencyKey.length > 255 || (chatConfirmationId && chatConfirmationId.length > 255)) {
    return errorJson("Invalid task submission", 400, "INVALID_TASK");
  }
  const spec = await env.DB.prepare(
    "SELECT task_spec_id FROM task_specs WHERE task_spec_id = ?1 AND project_id = ?2 AND user_id = ?3 AND status = 'active'"
  ).bind(specId, projectId, user.userId).first<{ task_spec_id: string }>();
  const snapshot = await env.DB.prepare(
    "SELECT dataset_snapshot_id FROM dataset_snapshots WHERE dataset_snapshot_id = ?1 AND task_spec_id = ?2 AND project_id = ?3 AND user_id = ?4 AND validation_passed = 1"
  ).bind(snapshotId, specId, projectId, user.userId).first<{ dataset_snapshot_id: string }>();
  if (!spec || !snapshot) return errorJson("Task input not found", 404, "TASK_INPUT_NOT_FOUND");
  if (methodId) {
    const method = await env.DB.prepare(
      "SELECT method_source_id FROM method_sources WHERE method_source_id = ?1 AND project_id = ?2 AND user_id = ?3"
    ).bind(methodId, projectId, user.userId).first<{ method_source_id: string }>();
    if (!method) return errorJson("Method source not found", 404, "METHOD_SOURCE_NOT_FOUND");
  }

  const fingerprint = await sha256(JSON.stringify({ projectId, specId, snapshotId, methodId, title, chatConfirmationId }));
  const existing = await env.DB.prepare(
    "SELECT task_id, request_hash FROM task_idempotency WHERE user_id = ?1 AND idempotency_key = ?2"
  ).bind(user.userId, idempotencyKey).first<{ task_id: string; request_hash: string }>();
  if (existing) {
    const duplicate = await loadTask(existing.task_id, env, user);
    if (chatConfirmationId && duplicate?.chat_confirmation_id === chatConfirmationId) {
      const confirmation = await getChatTaskConfirmationForUser(env, chatConfirmationId, user.userId);
      if (confirmation?.task_id === duplicate.task_id) {
        // A lost response can leave the card with freshly uploaded input IDs
        // but the same confirmation id. The confirmation-bound task is the
        // authoritative idempotent result; never turn the retry into a
        // conflict just because those transport artifacts changed.
        return json({ task_id: duplicate.task_id, status: duplicate.status, duplicate: true });
      }
    }
    if (existing.request_hash !== fingerprint) return errorJson("Idempotency key was reused with different input", 409, "IDEMPOTENCY_CONFLICT");
    if (chatConfirmationId && duplicate?.chat_confirmation_id !== chatConfirmationId) {
      return errorJson("Idempotency key is not bound to this confirmation", 409, "IDEMPOTENCY_CONFLICT");
    }
    return duplicate ? json({ task_id: duplicate.task_id, status: duplicate.status, duplicate: true }) : errorJson("Task not found", 404, "TASK_NOT_FOUND");
  }

  let id: string | null = null;
  if (chatConfirmationId) {
    const confirmation = await getChatTaskConfirmationForUser(env, chatConfirmationId, user.userId);
    if (!confirmation) return errorJson("Task confirmation not found", 404, "TASK_CONFIRMATION_NOT_FOUND");
    const now = nowSeconds();
    if (confirmation.expires_at <= now) return errorJson("Task confirmation expired", 410, "TASK_CONFIRMATION_EXPIRED");
    if (confirmation.status !== "pending") return errorJson("Task confirmation has already been used", 409, "TASK_CONFIRMATION_USED");

    id = confirmation.task_id || taskId();
    if (!confirmation.task_id) {
      const bound = await bindChatTaskConfirmation(env, chatConfirmationId, user.userId, id, now);
      if (!bound) {
        const raced = await getChatTaskConfirmationForUser(env, chatConfirmationId, user.userId);
        if (!raced || raced.expires_at <= now) return errorJson("Task confirmation expired", 410, "TASK_CONFIRMATION_EXPIRED");
        if (raced.status !== "pending" || !raced.task_id) return errorJson("Task confirmation has already been used", 409, "TASK_CONFIRMATION_USED");
        id = raced.task_id;
      }
    }
  } else {
    id = taskId();
  }
  const now = nowSeconds();
  if (chatConfirmationId) {
    const current = await getChatTaskConfirmationForUser(env, chatConfirmationId, user.userId);
    if (!current || current.status !== "pending" || current.task_id !== id) {
      return errorJson("Task confirmation has already been used", 409, "TASK_CONFIRMATION_USED");
    }
    if (current.expires_at <= now) return errorJson("Task confirmation expired", 410, "TASK_CONFIRMATION_EXPIRED");
  }
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO tasks
          (task_id, task_spec_id, dataset_snapshot_id, project_id, method_source_id,
           title, status, attempt_count, max_attempts, created_by, created_at, updated_at,
           chat_confirmation_id)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, 'queued', 0, 3, ?7, ?8, ?8, ?9
         WHERE ?9 IS NULL OR EXISTS (
           SELECT 1 FROM chat_task_confirmations
           WHERE confirmation_id = ?9 AND user_id = ?7 AND status = 'pending'
             AND task_id = ?1 AND expires_at > ?10
         )`
      ).bind(id, specId, snapshotId, projectId, methodId, title, user.userId, now, chatConfirmationId, now),
      env.DB.prepare(
        "INSERT INTO task_idempotency (user_id, idempotency_key, task_id, request_hash, created_at) VALUES (?1, ?2, ?3, ?4, ?5)"
      ).bind(user.userId, idempotencyKey, id, fingerprint, now),
      env.DB.prepare(
        "INSERT INTO task_events (task_event_id, task_id, event_type, event_data, created_at) VALUES (?1, ?2, 'task_queued', ?3, ?4)"
      ).bind(taskId(), id, JSON.stringify({ task_id: id, status: "queued" }), now),
    ]);
  } catch {
    const raced = await env.DB.prepare(
      "SELECT task_id, request_hash FROM task_idempotency WHERE user_id = ?1 AND idempotency_key = ?2"
    ).bind(user.userId, idempotencyKey).first<{ task_id: string; request_hash: string }>();
    if (raced?.request_hash === fingerprint) {
      const duplicate = await loadTask(raced.task_id, env, user);
      if (duplicate) return json({ task_id: duplicate.task_id, status: duplicate.status, duplicate: true });
    }
    if (chatConfirmationId && id) {
      const boundTask = await loadTask(id, env, user);
      if (boundTask?.chat_confirmation_id === chatConfirmationId) {
        return json({ task_id: boundTask.task_id, status: boundTask.status, duplicate: true });
      }
    }
    return errorJson("Task could not be queued", 503, "TASK_QUEUE_UNAVAILABLE");
  }
  return json({ task_id: id, status: "queued", attempt_count: 0, duplicate: false }, 201);
}

async function handleListTasks(request: Request, env: Env, user: AuthedUser): Promise<Response> {
  const limit = Math.min(100, Math.max(1, Number(new URL(request.url).searchParams.get("limit") || 50)));
  const result = await env.DB.prepare(
    `SELECT task_id, task_spec_id, dataset_snapshot_id, project_id, method_source_id,
            title, status, attempt_count, max_attempts, result_artifact_id,
            error_message, created_by, created_at, updated_at, finished_at,
            chat_confirmation_id
     FROM tasks WHERE created_by = ?1 ORDER BY created_at DESC LIMIT ?2`
  ).bind(user.userId, limit).all<TaskRow>();
  return json({ tasks: (result.results ?? []).map(publicTask) });
}

async function handleTaskByConfirmation(confirmationId: string, env: Env, user: AuthedUser): Promise<Response> {
  const task = await env.DB.prepare(
    `SELECT task_id, task_spec_id, dataset_snapshot_id, project_id, method_source_id,
            title, status, attempt_count, max_attempts, result_artifact_id,
            error_message, created_by, created_at, updated_at, finished_at,
            chat_confirmation_id
     FROM tasks WHERE chat_confirmation_id = ?1 AND created_by = ?2`
  ).bind(confirmationId, user.userId).first<TaskRow>();
  return json({ task: task ? publicTask(task) : null });
}

async function handleTaskEvents(task: TaskRow, env: Env): Promise<Response> {
  const result = await env.DB.prepare(
    "SELECT task_event_id, event_type, event_data, created_at FROM task_events WHERE task_id = ?1 ORDER BY created_at ASC LIMIT 200"
  ).bind(task.task_id).all<{ task_event_id: string; event_type: string; event_data: string; created_at: number }>();
  const events = (result.results ?? []).map((event) => ({
    task_event_id: event.task_event_id,
    event_type: event.event_type,
    event_data: safeJson(event.event_data),
    created_at: iso(event.created_at),
  }));
  return json(events);
}

function safeJson(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

async function handleTaskEventStream(task: TaskRow, env: Env): Promise<Response> {
  const result = await env.DB.prepare(
    "SELECT task_event_id, event_type, event_data, created_at FROM task_events WHERE task_id = ?1 ORDER BY created_at ASC LIMIT 200"
  ).bind(task.task_id).all<{ task_event_id: string; event_type: string; event_data: string; created_at: number }>();
  const lines = (result.results ?? []).map((event) =>
    `id: ${event.task_event_id}\nevent: update\ndata: ${JSON.stringify({
      event_type: event.event_type,
      event_data: safeJson(event.event_data),
      created_at: iso(event.created_at),
    })}\n\n`
  );
  lines.push(`event: task_state\ndata: ${JSON.stringify({ status: task.status })}\n\n`);
  lines.push(": keep-alive\n\n");
  return new Response(lines.join(""), { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" } });
}

async function handleCancelTask(task: TaskRow, env: Env): Promise<Response> {
  if (["succeeded", "failed", "cancelled", "timeout"].includes(task.status)) {
    return errorJson(`Cannot cancel task in status: ${task.status}`, 409, "TASK_NOT_CANCELLABLE");
  }
  const now = nowSeconds();
  const result = await env.DB.prepare(
    "UPDATE tasks SET status = 'cancelled', finished_at = ?2, updated_at = ?2 WHERE task_id = ?1 AND status IN ('queued', 'claimed', 'running')"
  ).bind(task.task_id, now).run();
  if ((result.meta?.changes ?? 0) !== 1) return errorJson("Task could not be cancelled", 409, "TASK_NOT_CANCELLABLE");
  await env.DB.prepare(
    "INSERT INTO task_events (task_event_id, task_id, event_type, event_data, created_at) VALUES (?1, ?2, 'task_cancelled', ?3, ?4)"
  ).bind(taskId(), task.task_id, JSON.stringify({ task_id: task.task_id, status: "cancelled" }), now).run();
  return json({ task_id: task.task_id, status: "cancelled" });
}

async function handleArtifact(artifactId: string, env: Env, user: AuthedUser): Promise<Response> {
  const artifact = await env.DB.prepare(
    `SELECT a.name, a.content_type, a.object_key
     FROM artifacts a JOIN tasks t ON t.task_id = a.task_id
     WHERE a.artifact_id = ?1 AND t.created_by = ?2 AND a.status = 'published'`
  ).bind(artifactId, user.userId).first<{ name: string; content_type: string | null; object_key: string }>();
  if (!artifact || !env.RESOURCE_BUCKET) return errorJson("Artifact not found", 404, "ARTIFACT_NOT_FOUND");
  const object = await env.RESOURCE_BUCKET.get(artifact.object_key);
  if (!object) return errorJson("Artifact not found", 404, "ARTIFACT_NOT_FOUND");
  const headers = new Headers({ "cache-control": "no-store", "content-type": artifact.content_type || "application/zip", "content-disposition": `attachment; filename="${safeName(artifact.name, "artifact.zip")}"` });
  object.writeHttpMetadata(headers);
  return new Response(object.body, { headers });
}

function adminAllowed(env: Env, user: AuthedUser): boolean {
  const allowed = (env.WORKER_ENROLLMENT_ADMIN_USER_IDS || "").split(",").map((value) => value.trim()).filter(Boolean);
  return allowed.includes(user.userId);
}

async function handleWorkerEnrollment(request: Request, env: Env, user: AuthedUser): Promise<Response> {
  if (!adminAllowed(env, user)) return errorJson("Worker enrollment requires operator permission", 403, "FORBIDDEN");
  const body = await jsonBody(request);
  const workerId = String(body?.worker_id ?? "").trim();
  const namespace = String(body?.namespace ?? "").trim();
  const requestedTrust = String(body?.trust_level ?? "owner_trusted").trim();
  const trustLevels = new Set(["owner_trusted", "institution_trusted", "student_untrusted"]);
  if (!trustLevels.has(requestedTrust)) return errorJson("Invalid Worker trust level", 400, "INVALID_TRUST_LEVEL");
  const trustLevel = requestedTrust as "owner_trusted" | "institution_trusted" | "student_untrusted";
  const requestedTtl = Number(body?.ttl_seconds || 600);
  const ttl = Number.isFinite(requestedTtl) ? Math.min(3600, Math.max(30, requestedTtl)) : 600;
  if (!workerId || workerId.length > 120 || !namespace || namespace.length > 120) return errorJson("Invalid worker enrollment request", 400, "INVALID_ENROLLMENT");
  const rawToken = `${taskId()}${taskId().replaceAll("-", "")}`;
  const tokenHash = await sha256(rawToken);
  const expires = nowSeconds() + ttl;
  await env.DB.prepare(
    `INSERT INTO worker_enrollments
      (worker_id, namespace, user_id, token_hash, expires_at, created_at, trust_level, status)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'pending')
     ON CONFLICT(worker_id, namespace) DO UPDATE SET
       user_id = excluded.user_id, token_hash = excluded.token_hash,
       expires_at = excluded.expires_at, used_at = NULL, revoked_at = NULL,
       credential_hash = NULL, credential_expires_at = NULL, public_key = NULL,
       trust_level = excluded.trust_level, status = 'pending', version = NULL,
       capabilities_json = '[]', last_seen_at = NULL`
  ).bind(workerId, namespace, user.userId, tokenHash, expires, nowSeconds(), trustLevel).run();
  return json({ worker_id: workerId, namespace, trust_level: trustLevel, enrollment_token: rawToken, expires_at: iso(expires), one_time: true }, 201);
}

async function handleRevokeEnrollment(workerId: string, request: Request, env: Env, user: AuthedUser): Promise<Response> {
  if (!adminAllowed(env, user)) return errorJson("Worker enrollment requires operator permission", 403, "FORBIDDEN");
  const namespace = new URL(request.url).searchParams.get("namespace") || "";
  if (!namespace) return errorJson("namespace is required", 400, "INVALID_ENROLLMENT");
  const result = await env.DB.prepare(
    "UPDATE worker_enrollments SET revoked_at = ?3, status = 'revoked', credential_hash = NULL, credential_expires_at = NULL WHERE worker_id = ?1 AND namespace = ?2 AND user_id = ?4 AND revoked_at IS NULL"
  ).bind(workerId, namespace, nowSeconds(), user.userId).run();
  if ((result.meta?.changes ?? 0) !== 1) return errorJson("Active Worker enrollment not found", 404, "ENROLLMENT_NOT_FOUND");
  return json({ worker_id: workerId, namespace, status: "revoked" });
}

export async function handleTaskApi(request: Request, env: Env, user: AuthedUser): Promise<Response | null> {
  const url = new URL(request.url);
  const { pathname } = url;
  const method = request.method;

  if (method === "GET" && pathname === "/api/projects/default") return handleDefaultProject(env, user);
  if (method === "POST" && pathname === "/api/method-sources/upload") return handleMethodUpload(request, env, user);
  if (method === "POST" && pathname === "/api/dataset-snapshots/upload") return handleDatasetUpload(request, env, user);
  if (method === "POST" && pathname === "/api/task-specs") return handleTaskSpec(request, env, user);

  const freezeMatch = pathname.match(/^\/api\/task-specs\/([^/]+)\/freeze$/);
  if (freezeMatch) {
    return method === "POST" ? handleFreezeTaskSpec(decodeURIComponent(freezeMatch[1]), env, user) : errorJson("Method not allowed", 405, "METHOD_NOT_ALLOWED");
  }
  if (method === "POST" && pathname === "/api/dataset-snapshots") return handleDatasetSnapshot(request, env, user);
  if (method === "POST" && pathname === "/api/tasks") return handleCreateTask(request, env, user);
  if (method === "GET" && pathname === "/api/tasks") return handleListTasks(request, env, user);

  const confirmationTaskMatch = pathname.match(/^\/api\/task-confirmations\/([^/]+)\/task$/);
  if (confirmationTaskMatch && method === "GET") {
    return handleTaskByConfirmation(decodeURIComponent(confirmationTaskMatch[1]), env, user);
  }

  const taskMatch = pathname.match(/^\/api\/tasks\/([^/]+)(?:\/(cancel|events|events\/stream|artifacts))?$/);
  if (taskMatch) {
    const current = await loadTask(decodeURIComponent(taskMatch[1]), env, user);
    if (!current) return errorJson("Task not found", 404, "TASK_NOT_FOUND");
    const suffix = taskMatch[2];
    if (!suffix && method === "GET") return json(publicTask(current));
    if (suffix === "cancel" && method === "POST") return handleCancelTask(current, env);
    if (suffix === "events" && method === "GET") return handleTaskEvents(current, env);
    if (suffix === "events/stream" && method === "GET") return handleTaskEventStream(current, env);
    if (suffix === "artifacts" && method === "GET") {
      const result = await env.DB.prepare(
        "SELECT artifact_id, name, kind, file_size_bytes, checksum_sha256, created_at FROM artifacts WHERE task_id = ?1 AND status = 'published' ORDER BY created_at DESC"
      ).bind(current.task_id).all<Record<string, unknown>>();
      return json((result.results ?? []).map((artifact) => ({ ...artifact, created_at: iso(Number(artifact.created_at)) })));
    }
    return errorJson("Method not allowed", 405, "METHOD_NOT_ALLOWED");
  }

  const artifactMatch = pathname.match(/^\/api\/artifacts\/([^/]+)$/);
  if (artifactMatch && method === "GET") return handleArtifact(decodeURIComponent(artifactMatch[1]), env, user);
  if (method === "POST" && pathname === "/api/worker-enrollments") return handleWorkerEnrollment(request, env, user);
  const revokeMatch = pathname.match(/^\/api\/worker-enrollments\/([^/]+)\/revoke$/);
  if (revokeMatch && method === "POST") return handleRevokeEnrollment(decodeURIComponent(revokeMatch[1]), request, env, user);

  return null;
}
