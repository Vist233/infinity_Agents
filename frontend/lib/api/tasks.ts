// Task Execution API client. All calls share the same-origin runtime base
// (see lib/runtime-config) so local and deployed frontends behave alike.
import { getApiBase, withCsrfHeader } from "@/lib/runtime-config";

export type TaskStatus =
  | "draft"
  | "queued"
  | "claimed"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timeout";

/** Hard per-file input cap shared by direct Task Center and Agent confirmation. */
export const MAX_TASK_INPUT_BYTES = 25 * 1024 * 1024;

export interface TaskItem {
  task_id: string;
  task_spec_id: string;
  dataset_snapshot_id: string;
  project_id: string;
  method_source_id?: string | null;
  title: string;
  status: TaskStatus;
  attempt_count: number;
  max_attempts: number;
  error_message?: string | null;
  created_at: string;
}

// Task input contracts shared by the Analysis confirmation card and the direct
// Task Center submission path.

export interface TaskDraft {
  draft_id: string;
  session_id?: string;
  project_id?: string;
  revision: number;
  status: "draft" | "awaiting_user_confirmation" | "revising" | "cancelled" | "confirmed" | string;
  title: string;
  goal_summary: string;
  method: {
    filename: string;
    size_bytes: number;
    sha256?: string | null;
    preview: string;
  } | null;
  dataset: {
    resource_id?: string | null;
    filename?: string | null;
    size_bytes?: number | null;
    sha256?: string | null;
  };
  missing_inputs: string[];
  task_spec?: Record<string, unknown>;
}

/** The Cloudflare Analysis confirmation card emitted by request_task_creation. */
export interface ChatTaskConfirmation {
  confirmation_id: string;
  tool_name: string;
  title: string;
  analysis_type: string;
  research_question: string;
  method_document_name: string;
  method_document_content: string;
  dataset_name: string;
}

// Shared contracts for the persistent server-owned Worker cluster.
export interface ProjectInfo {
  project_id: string;
  name: string;
  created_at?: string;
}

export interface MethodSourceInfo {
  method_source_id: string;
  project_id: string;
  original_filename: string;
  stored_path?: string;
  file_hash_sha256?: string;
  file_size_bytes?: number;
}

export interface DatasetUploadInfo {
  resource_id: string;
  project_id: string;
  logical_name: string;
  file_hash_sha256: string;
  file_size_bytes: number;
  original_filename?: string;
}

export interface WorkerEnrollmentResponse {
  worker_id: string;
  namespace: string;
  worker_credential: string;
  execution_pool?: string;
  credential_expires_at: string | null;
  persistent: boolean;
  one_time: boolean;
}

export interface WorkerRegistration {
  worker_id: string;
  namespace: string;
  status: "active" | "revoked" | "draining" | string;
  presence: "online" | "offline" | "never_seen";
  credential_expires_at: string | null;
  last_seen_at: string | null;
  created_at: string | null;
  revoked_at: string | null;
  credential_available?: boolean;
  execution_pool?: string;
  ready?: boolean;
  protocol_version?: string;
  runtime_capability?: string;
  image_digest?: string | null;
  last_error?: string | null;
}

export interface PublicWorkerPool {
  pool_id: string;
  kind: "public";
  namespace: string;
  worker_count: number;
}

export interface PublicWorkerPoolResponse {
  pool: PublicWorkerPool;
  workers: WorkerRegistration[];
}

async function requestJson<T>(input: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
  response = await fetch(input, {
    credentials: "include",
    ...init,
    headers: withCsrfHeader(init?.headers),
  });
  } catch (error) {
    throw new Error(
      `Network request failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
  // A background list/refresh request must not navigate the whole workspace
  // away while the user is moving between agents.  Callers that represent an
  // explicit action can decide to invoke redirectToLogin themselves; the
  // error still carries the 401 status for that decision.
  if (!response.ok) {
    let detail = response.status === 401 ? "Authentication required" : `HTTP ${response.status}`;
    try {
      const payload = await response.json();
      if (payload && typeof payload.detail === "string") {
        detail = payload.detail;
      }
      if (payload?.error?.message && typeof payload.error.message === "string") {
        detail = payload.error.message;
      }
    } catch {
      // keep default detail
    }
    const error = new Error(detail) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  return response.json() as Promise<T>;
}

/** Generic authenticated GET against the Task API. */
export function getJson<T>(url: string): Promise<T> {
  return requestJson<T>(url);
}

export async function getDefaultProject(): Promise<ProjectInfo> {
  return requestJson(`${getApiBase()}/api/projects/default`);
}

export async function uploadMethodSource(file: File): Promise<MethodSourceInfo> {
  const form = new FormData();
  form.append("file", file);
  return requestJson(`${getApiBase()}/api/method-sources/upload`, { method: "POST", body: form });
}

export async function uploadDataset(file: File, projectId: string, sessionId?: string): Promise<DatasetUploadInfo> {
  const form = new FormData();
  form.append("project_id", projectId);
  form.append("file", file);
  if (sessionId) form.append("session_id", sessionId);
  return requestJson(`${getApiBase()}/api/dataset-snapshots/upload`, { method: "POST", body: form });
}

export async function createTaskSpec(input: {
  project_id: string;
  title: string;
  analysis_type?: string;
  research_question?: string;
}): Promise<{ task_spec_id: string; revision: number; status: string }> {
  return requestJson(`${getApiBase()}/api/task-specs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function freezeTaskSpec(taskSpecId: string): Promise<{ task_spec_id: string; status: string; frozen: boolean }> {
  return requestJson(`${getApiBase()}/api/task-specs/${encodeURIComponent(taskSpecId)}/freeze`, { method: "POST" });
}

export async function createDatasetSnapshot(input: {
  project_id: string;
  task_spec_id: string;
  original_filename: string;
  resource_id: string;
  file_hash_sha256?: string;
  validation_passed?: boolean;
}): Promise<{ dataset_snapshot_id: string }> {
  return requestJson(`${getApiBase()}/api/dataset-snapshots`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function createTask(input: {
  project_id: string;
  task_spec_id: string;
  dataset_snapshot_id: string;
  title: string;
  method_source_id?: string;
  idempotency_key?: string;
  chat_confirmation_id?: string | false;
  submission_source?: "task_center";
  agent_confirmation?: boolean;
  direct?: boolean;
}): Promise<{ task_id: string; status: string; duplicate?: boolean }> {
  const { direct, ...body } = input;
  const payload = direct
    ? { ...body, agent_confirmation: false, submission_source: "task_center" as const }
    : body;
  // The Edge keeps the Agent-confirmation and direct Task Center contracts
  // separate. Direct creation must reach the dedicated route so the server
  // can enforce agent_confirmation=false at the routing boundary.
  return requestJson(`${getApiBase()}${direct ? "/api/tasks/direct" : "/api/tasks"}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function createWorkerEnrollment(): Promise<WorkerEnrollmentResponse> {
  return requestJson(`${getApiBase()}/api/worker-enrollments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
}

export async function listWorkerEnrollments(): Promise<WorkerRegistration[]> {
  const data = await requestJson<{ workers: WorkerRegistration[] }>(`${getApiBase()}/api/worker-enrollments`);
  return data.workers || [];
}

export async function getWorkerCredential(workerId: string): Promise<WorkerEnrollmentResponse> {
  return requestJson<WorkerEnrollmentResponse>(
    `${getApiBase()}/api/worker-enrollments/${encodeURIComponent(workerId)}/credential`,
  );
}

export async function rotateWorkerCredential(workerId: string): Promise<WorkerEnrollmentResponse> {
  return requestJson<WorkerEnrollmentResponse>(
    `${getApiBase()}/api/worker-enrollments/${encodeURIComponent(workerId)}/rotate`,
    { method: "POST" },
  );
}

export async function getPublicWorkerPool(): Promise<PublicWorkerPoolResponse> {
  return requestJson<PublicWorkerPoolResponse>(`${getApiBase()}/api/admin/public-worker-pool`);
}

export async function createPublicWorker(): Promise<WorkerEnrollmentResponse & {
  worker_kind: "public";
  pool_id: string;
}> {
  return requestJson(`${getApiBase()}/api/admin/public-workers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
}

export async function getPublicWorkerCredential(workerId: string): Promise<WorkerEnrollmentResponse & {
  worker_kind: "public";
  pool_id: string;
}> {
  return requestJson(`${getApiBase()}/api/admin/public-workers/${encodeURIComponent(workerId)}/credential`);
}

export async function rotatePublicWorkerCredential(workerId: string): Promise<WorkerEnrollmentResponse & {
  worker_kind: "public";
  pool_id: string;
}> {
  return requestJson(`${getApiBase()}/api/admin/public-workers/${encodeURIComponent(workerId)}/rotate`, { method: "POST" });
}

export async function revokePublicWorker(workerId: string): Promise<{ worker_id: string; status: string }> {
  return requestJson(`${getApiBase()}/api/admin/public-workers/${encodeURIComponent(workerId)}/revoke`, { method: "POST" });
}

export async function submitTaskBundle(input: {
  methodFile: File;
  datasetFile: File;
  title?: string;
  idempotencyKey: string;
  projectId?: string;
}): Promise<{ task_id: string; status: string; attempt_count: number; duplicate?: boolean }> {
  if (input.methodFile.size > MAX_TASK_INPUT_BYTES || input.datasetFile.size > MAX_TASK_INPUT_BYTES) {
    throw new Error("Each task input file must be 25 MB or smaller");
  }
  const form = new FormData();
  form.append("method_file", input.methodFile);
  form.append("dataset_file", input.datasetFile);
  form.append("title", input.title || "");
  form.append("idempotency_key", input.idempotencyKey);
  if (input.projectId) form.append("project_id", input.projectId);
  return requestJson(`${getApiBase()}/api/tasks/submit-bundle`, { method: "POST", body: form });
}

export async function getTaskDraft(draftId: string): Promise<TaskDraft> {
  return requestJson<TaskDraft>(`${getApiBase()}/api/task-drafts/${encodeURIComponent(draftId)}`);
}

export async function cancelTaskDraft(draftId: string): Promise<{ draft_id: string; status: string }> {
  return requestJson(`${getApiBase()}/api/task-drafts/${encodeURIComponent(draftId)}/cancel`, { method: "POST" });
}

export async function cancelChatTaskConfirmation(confirmationId: string): Promise<{ confirmation_id: string; status: string }> {
  return requestJson(`${getApiBase()}/api/chat/task-confirmation/cancel`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirmation_id: confirmationId }),
  });
}

export async function confirmTaskDraft(input: {
  draftId: string;
  idempotencyKey: string;
  datasetResourceId?: string;
  methodContent?: string;
  title?: string;
}): Promise<{ task_id: string; status: string; attempt_count: number; duplicate?: boolean; event_type?: "task_confirmed" | string }> {
  return requestJson(`${getApiBase()}/api/task-drafts/${encodeURIComponent(input.draftId)}/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      idempotency_key: input.idempotencyKey,
      dataset_resource_id: input.datasetResourceId,
      method_content: input.methodContent,
      title: input.title,
    }),
  });
}

export async function listTasks(limit = 50): Promise<TaskItem[]> {
  const data = await requestJson<{ tasks: TaskItem[] }>(`${getApiBase()}/api/tasks?limit=${limit}`);
  return data.tasks || [];
}

export async function cancelTask(taskId: string): Promise<{ status: string }> {
  return requestJson(`${getApiBase()}/api/tasks/${taskId}/cancel`, { method: "POST" });
}

export function artifactDownloadUrl(artifactId: string): string {
  return `${getApiBase()}/api/artifacts/${artifactId}`;
}
