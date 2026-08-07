// Task Execution API client. All calls share the same-origin runtime base
// (see lib/runtime-config) so local and deployed frontends behave alike.
import { getApiBase } from "@/lib/runtime-config";

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
  stored_path: string;
  file_hash_sha256?: string;
  file_size_bytes?: number;
}

export interface DatasetUploadInfo {
  stored_path: string;
  file_hash_sha256: string;
  file_size_bytes: number;
  original_filename?: string;
}

async function requestJson<T>(input: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(input, { credentials: "include", ...init });
  } catch (error) {
    throw new Error(
      `Network request failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
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

export async function getDefaultProject(): Promise<ProjectInfo> {
  return requestJson(`${getApiBase()}/api/projects/default`);
}

export async function uploadMethodSource(file: File): Promise<MethodSourceInfo> {
  const form = new FormData();
  form.append("file", file);
  return requestJson(`${getApiBase()}/api/method-sources/upload`, { method: "POST", body: form });
}

export async function uploadDataset(file: File): Promise<DatasetUploadInfo> {
  const form = new FormData();
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

export async function createDatasetSnapshot(input: {
  project_id: string;
  task_spec_id: string;
  original_filename: string;
  stored_path: string;
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
}): Promise<{ task_id: string; status: string; duplicate?: boolean }> {
  return requestJson(`${getApiBase()}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
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

export function taskEventStreamUrl(taskId: string): string {
  // EventSource cannot send credentials; keep same-origin relative URLs.
  return `${getApiBase()}/api/tasks/${taskId}/events/stream`;
}
