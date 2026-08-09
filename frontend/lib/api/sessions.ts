import type { Message, SessionItem } from "@/lib/chat-state";
import { withCsrfHeader } from "@/lib/runtime-config";

export interface ApiError extends Error {
  status?: number;
  detail?: string;
}

export interface UploadedPaperItem {
  paper_id: string;
  original_filename: string;
  stored_pdf_path: string;
  canonical_md_path: string;
  images_dir: string | null;
  page_count: number;
  image_count: number;
  status: string;
  created_at?: string;
}

function createApiError(message: string, status?: number, detail?: string): ApiError {
  const error = new Error(message) as ApiError;
  error.status = status;
  error.detail = detail;
  return error;
}

async function parseErrorResponse(response: Response): Promise<string> {
  try {
    const payload = await response.json();
    if (payload && typeof payload.detail === "string") {
      return payload.detail;
    }
  } catch {
    // ignore malformed json
  }
  const text = await response.text();
  return text || `HTTP ${response.status}`;
}

async function requestJson<T>(input: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(input, { credentials: "include", ...init, headers: withCsrfHeader(init?.headers) });
  } catch (error) {
    throw createApiError(
      `Network request failed: ${error instanceof Error ? error.message : "unknown error"}`,
      undefined,
      "network_error",
    );
  }

  if (response.status === 401) {
    // The public landing page is intentionally usable without a session.  Let
    // the UI offer an explicit sign-in action instead of redirecting on load.
    throw createApiError("Authentication required", 401, "unauthenticated");
  }

  if (!response.ok) {
    const detail = await parseErrorResponse(response);
    throw createApiError(`Request failed (${response.status})`, response.status, detail);
  }
  return response.json() as Promise<T>;
}

export async function listSessions(apiBase: string): Promise<SessionItem[]> {
  const data = await requestJson<unknown>(`${apiBase}/api/sessions`);
  return Array.isArray(data) ? (data as SessionItem[]) : [];
}

export async function createSession(apiBase: string): Promise<{ session_id: string; storage_mode?: string }> {
  return requestJson(`${apiBase}/api/sessions`, { method: "POST" });
}

export async function listSessionMessages(apiBase: string, sessionId: string): Promise<Message[]> {
  const data = await requestJson<unknown>(`${apiBase}/api/sessions/${sessionId}/messages`);
  if (!Array.isArray(data)) {
    return [];
  }
  return data
    .filter((item) => item && typeof item === "object")
    .map((item) => item as Record<string, unknown>)
    .filter((item) => (item.role === "user" || item.role === "assistant") && typeof item.content === "string")
    .map((item) => ({ role: item.role as "user" | "assistant", content: item.content as string }));
}

export async function updateSessionTitle(apiBase: string, sessionId: string, title: string): Promise<void> {
  await requestJson(`${apiBase}/api/sessions/${sessionId}/title`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
}

export async function deleteSession(apiBase: string, sessionId: string): Promise<void> {
  await requestJson(`${apiBase}/api/sessions/${sessionId}`, {
    method: "DELETE",
  });
}

// PDF upload is intentionally not supported in the public v1 (no filesystem /
// PDF pipeline in the edge Worker). These stubs keep the existing call sites
// compiling without hitting a non-existent endpoint.
export async function uploadSessionPaper(
  _apiBase: string,
  _sessionId: string,
  _file: File,
): Promise<UploadedPaperItem> {
  void _apiBase;
  void _sessionId;
  void _file;
  throw createApiError("PDF upload is not available in this version.", 400, "upload_unsupported");
}

export async function listSessionUploadedPapers(
  _apiBase: string,
  _sessionId: string,
): Promise<UploadedPaperItem[]> {
  void _apiBase;
  void _sessionId;
  return [];
}
