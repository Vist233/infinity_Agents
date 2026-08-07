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
    response = await fetch(input, { credentials: "include", ...init, headers: { ...authHeaders(), ...(init?.headers || {}) } });
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

// Optional shared secret (backend TASK_API_TOKEN). When the backend runs in
// protected mode, the browser injects this key; unset = open local mode.
function getTaskApiKey(): string {
  return process.env.NEXT_PUBLIC_TASK_API_TOKEN?.trim() || "";
}

function authHeaders(): Record<string, string> {
  const key = getTaskApiKey();
  return key ? { "X-API-Key": key } : {};
}

export async function getDefaultProject(): Promise<ProjectInfo> {
  return requestJson(`${getApiBase()}/api/projects/default`);
}

/** Generic authenticated GET against the Task API (shared key injection). */
export function getJson<T>(url: string): Promise<T> {
  return requestJson<T>(url);
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

/** Download an artifact via fetch+Blob so the X-API-Key header is attached
 *  (a plain `window.open` cannot carry custom headers, which would 401
 *  when TASK_API_TOKEN is enabled). */
export async function downloadArtifact(artifactId: string, filename = "artifact.zip"): Promise<void> {
  const res = await fetch(artifactDownloadUrl(artifactId), {
    credentials: "include",
    headers: authHeaders(),
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
  // EventSource cannot send custom headers, so the key travels as a query
  // parameter (backend accepts ?api_key= as an SSE fallback).
  const key = getTaskApiKey();
  const suffix = key ? `?api_key=${encodeURIComponent(key)}` : "";
  return `${getApiBase()}/api/tasks/${taskId}/events/stream${suffix}`;
}
