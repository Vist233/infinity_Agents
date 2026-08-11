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

export interface WorkerEnrollmentInfo {
  worker_id: string;
  namespace: string;
  credential: string;
  persistent: boolean;
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
    } catch {
      // keep default detail
    }
    throw new Error(detail);
  }
  return response.json() as Promise<T>;
}

/** Generic authenticated GET against the Task API. */
export function getJson<T>(url: string): Promise<T> {
  return requestJson<T>(url);
}

export async function submitTaskBundle(input: {
  methodFile: File;
  datasetFile: File;
  title?: string;
  idempotencyKey: string;
  projectId?: string;
}): Promise<{ task_id: string; status: string; attempt_count: number; duplicate?: boolean }> {
  const form = new FormData();
  form.append("method_file", input.methodFile);
  form.append("dataset_file", input.datasetFile);
  form.append("title", input.title || "");
  form.append("idempotency_key", input.idempotencyKey);
  if (input.projectId) form.append("project_id", input.projectId);
  return requestJson(`${getApiBase()}/api/tasks/submit-bundle`, { method: "POST", body: form });
}

export async function listTasks(limit = 50): Promise<TaskItem[]> {
  const data = await requestJson<{ tasks: TaskItem[] }>(`${getApiBase()}/api/tasks?limit=${limit}`);
  return data.tasks || [];
}

export async function issueWorkerEnrollment(input: { worker_id: string; namespace: string }): Promise<WorkerEnrollmentInfo> {
  return requestJson(`${getApiBase()}/api/worker-enrollments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function cancelTask(taskId: string): Promise<{ status: string }> {
  return requestJson(`${getApiBase()}/api/tasks/${taskId}/cancel`, { method: "POST" });
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
  if (res.status === 401) {
    redirectToLogin();
    throw new Error("Authentication required");
  }
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const payload = await res.json();
      if (payload && typeof payload.detail === "string") detail = payload.detail;
    } catch {
      // Keep the HTTP fallback for non-JSON errors.
    }
    throw new Error(detail);
  }
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
