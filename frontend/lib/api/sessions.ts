import type { Message, SessionItem } from "@/lib/chat-state";

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
    response = await fetch(input, init);
  } catch (error) {
    throw createApiError(
      `Network request failed: ${error instanceof Error ? error.message : "unknown error"}`,
      undefined,
      "network_error",
    );
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

export async function uploadSessionPaper(
  apiBase: string,
  sessionId: string,
  file: File,
): Promise<UploadedPaperItem> {
  const form = new FormData();
  form.append("file", file);

  let response: Response;
  try {
    response = await fetch(`${apiBase}/api/sessions/${sessionId}/uploads/papers`, {
      method: "POST",
      body: form,
    });
  } catch (error) {
    throw createApiError(
      `Network request failed: ${error instanceof Error ? error.message : "unknown error"}`,
      undefined,
      "network_error",
    );
  }

  if (!response.ok) {
    const detail = await parseErrorResponse(response);
    throw createApiError(`Request failed (${response.status})`, response.status, detail);
  }
  return response.json() as Promise<UploadedPaperItem>;
}

export async function listSessionUploadedPapers(apiBase: string, sessionId: string): Promise<UploadedPaperItem[]> {
  const data = await requestJson<unknown>(`${apiBase}/api/sessions/${sessionId}/uploads/papers`);
  return Array.isArray(data) ? (data as UploadedPaperItem[]) : [];
}
