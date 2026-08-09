// Task Execution API client. All calls share the same-origin runtime base
// (see lib/runtime-config) so local and deployed frontends behave alike.
import { getApiBase, redirectToLogin, withCsrfHeader } from "@/lib/runtime-config";

export type TaskStatus =
  | "draft"
  | "queued"
  | "claimed"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timeout";

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
  trust_level: "owner_trusted" | "institution_trusted" | "student_untrusted";
  enrollment_token: string;
  expires_at: string;
  one_time: boolean;
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
  if (response.status === 401) {
    redirectToLogin();
  }
  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const payload = await response.json() as {
        detail?: string;
        error?: { message?: string };
      };
      if (payload && typeof payload.detail === "string") {
        detail = payload.detail;
      } else if (payload?.error && typeof payload.error.message === "string") {
        detail = payload.error.message;
      }
    } catch {
      // keep default detail
    }
    throw new Error(detail);
  }
  return response.json() as Promise<T>;
}

export async function getDefaultProject(): Promise<ProjectInfo> {
  return requestJson(`${getApiBase()}/api/projects/default`);
}

/** Generic authenticated GET against the Task API. */
export function getJson<T>(url: string): Promise<T> {
  return requestJson<T>(url);
}

export async function uploadMethodSource(file: File): Promise<MethodSourceInfo> {
  const form = new FormData();
  form.append("file", file);
  return requestJson(`${getApiBase()}/api/method-sources/upload`, { method: "POST", body: form });
}

export async function uploadDataset(file: File, projectId: string): Promise<DatasetUploadInfo> {
  const form = new FormData();
  form.append("project_id", projectId);
  form.append("file", file);
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
  return requestJson(`${getApiBase()}/api/task-specs/${taskSpecId}/freeze`, { method: "POST" });
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
  chat_confirmation_id?: string;
}): Promise<{ task_id: string; status: string; duplicate?: boolean }> {
  return requestJson(`${getApiBase()}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function findTaskByConfirmation(confirmationId: string): Promise<TaskItem | null> {
  const data = await requestJson<{ task: TaskItem | null }>(
    `${getApiBase()}/api/task-confirmations/${encodeURIComponent(confirmationId)}/task`,
  );
  return data.task;
}

export async function listTasks(limit = 50): Promise<TaskItem[]> {
  const data = await requestJson<{ tasks: TaskItem[] }>(`${getApiBase()}/api/tasks?limit=${limit}`);
  return data.tasks || [];
}

export async function cancelTask(taskId: string): Promise<{ status: string }> {
  return requestJson(`${getApiBase()}/api/tasks/${taskId}/cancel`, { method: "POST" });
}

/** Issue a short-lived, one-time token for an HTTPS Worker bootstrap. */
export async function createWorkerEnrollment(input: {
  worker_id: string;
  namespace: string;
  trust_level?: WorkerEnrollmentResponse["trust_level"];
  ttl_seconds?: number;
}): Promise<WorkerEnrollmentResponse> {
  return requestJson(`${getApiBase()}/api/worker-enrollments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export function artifactDownloadUrl(artifactId: string): string {
  return `${getApiBase()}/api/artifacts/${artifactId}`;
}

/** Download an artifact via fetch+Blob with the session cookie attached. */
export async function downloadArtifact(artifactId: string, filename = "artifact.zip"): Promise<void> {
  const res = await fetch(artifactDownloadUrl(artifactId), {
    credentials: "include",
    headers: withCsrfHeader(),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function taskEventStreamUrl(taskId: string): string {
  // EventSource sends same-origin cookies, so no shared task token is put in
  // the URL or browser history.
  return `${getApiBase()}/api/tasks/${taskId}/events/stream`;
}
