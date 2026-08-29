import { withCsrfHeader } from "@/lib/runtime-config";

export type PaperResourceProgressStatus = "requested" | "downloading" | "extracting" | "uploading" | "ready" | "failed" | "cancelled";
export type PaperContinuationProgressStatus = "waiting" | "ready" | "running" | "completed" | "failed" | "cancelled" | "expired";

export interface PaperResourceProgress {
  resource: {
    resource_id: string;
    status: PaperResourceProgressStatus;
    stage: PaperResourceProgressStatus;
    source_kind: "arxiv" | "pubmed_pmc" | "user_upload" | "approved_url";
    title: string | null;
    page_count: number | null;
    image_count: number | null;
    error: { code: string; message: string } | null;
    created_at: number;
    updated_at: number;
    ready_at: number | null;
  };
  revision: string;
  materialize: {
    invocation_status: "succeeded" | "not_recorded";
    invocation_event_id: string | null;
    invoked_at: number | null;
    resource_ready: boolean;
  };
  correlation: {
    continuations: Array<{
      continuation_id: string;
      original_turn_id: string;
      status: PaperContinuationProgressStatus;
      expires_at: number;
      updated_at: number;
      completed_at: number | null;
    }>;
  };
  events: Array<{
    event_id: string;
    stage: "materialize" | "download" | "extraction" | "upload" | "image_analysis" | "cancel" | "delete" | "cleanup";
    outcome: "started" | "succeeded" | "failed" | "denied" | "cancelled";
    error_code: string | null;
    created_at: number;
  }>;
  resume: {
    available: boolean;
    continuation_id: string | null;
    method: "POST";
    path: string | null;
    body: { session_id: string } | null;
    reason_code: string | null;
  };
}

export interface PaperApiError extends Error {
  status?: number;
  detail?: string;
}

const RESOURCE_STATUSES = new Set<PaperResourceProgressStatus>([
  "requested", "downloading", "extracting", "uploading", "ready", "failed", "cancelled",
]);
const CONTINUATION_STATUSES = new Set<PaperContinuationProgressStatus>([
  "waiting", "ready", "running", "completed", "failed", "cancelled", "expired",
]);
const SOURCE_KINDS = new Set<PaperResourceProgress["resource"]["source_kind"]>([
  "arxiv", "pubmed_pmc", "user_upload", "approved_url",
]);
const EVENT_STAGES = new Set<PaperResourceProgress["events"][number]["stage"]>([
  "materialize", "download", "extraction", "upload", "image_analysis", "cancel", "delete", "cleanup",
]);
const EVENT_OUTCOMES = new Set<PaperResourceProgress["events"][number]["outcome"]>([
  "started", "succeeded", "failed", "denied", "cancelled",
]);
const SAFE_ID = /^[^\s]{1,255}$/;
const SAFE_ERROR_CODE = /^[A-Z0-9_]{1,64}$/;
const SAFE_REASON_CODE = /^[A-Z0-9_]{1,64}$/;

function boundedText(value: unknown, maxChars: number): string | null {
  return typeof value === "string" && value.length <= maxChars ? value : null;
}

function requiredId(value: unknown): string | null {
  return typeof value === "string" && SAFE_ID.test(value) ? value : null;
}

function safeTimestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function safeCount(value: unknown): number | null {
  return value === null || value === undefined
    ? null
    : typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function normalizeError(value: unknown): { code: string; message: string } | null | undefined {
  if (value === null) return null;
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const code = typeof record.code === "string" && SAFE_ERROR_CODE.test(record.code) ? record.code : null;
  const message = boundedText(record.message, 512);
  return code && message ? { code, message } : undefined;
}

function normalizeProgressEvent(value: unknown): PaperResourceProgress["events"][number] | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const eventId = requiredId(record.event_id);
  const stage = typeof record.stage === "string" && EVENT_STAGES.has(record.stage as PaperResourceProgress["events"][number]["stage"])
    ? record.stage as PaperResourceProgress["events"][number]["stage"] : null;
  const outcome = typeof record.outcome === "string" && EVENT_OUTCOMES.has(record.outcome as PaperResourceProgress["events"][number]["outcome"])
    ? record.outcome as PaperResourceProgress["events"][number]["outcome"] : null;
  const createdAt = safeTimestamp(record.created_at);
  const errorCode = record.error_code === null
    ? null
    : typeof record.error_code === "string" && SAFE_ERROR_CODE.test(record.error_code) ? record.error_code : undefined;
  if (!eventId || !stage || !outcome || createdAt === null || errorCode === undefined) return null;
  return { event_id: eventId, stage, outcome, error_code: errorCode, created_at: createdAt };
}

function normalizeContinuation(value: unknown): PaperResourceProgress["correlation"]["continuations"][number] | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const continuationId = requiredId(record.continuation_id);
  const originalTurnId = requiredId(record.original_turn_id);
  const status = typeof record.status === "string" && CONTINUATION_STATUSES.has(record.status as PaperContinuationProgressStatus)
    ? record.status as PaperContinuationProgressStatus : null;
  const expiresAt = safeTimestamp(record.expires_at);
  const updatedAt = safeTimestamp(record.updated_at);
  const completedAt = record.completed_at === null ? null : safeTimestamp(record.completed_at);
  if (!continuationId || !originalTurnId || !status || expiresAt === null || updatedAt === null || completedAt === undefined) return null;
  return { continuation_id: continuationId, original_turn_id: originalTurnId, status, expires_at: expiresAt, updated_at: updatedAt, completed_at: completedAt };
}

function normalizeResume(value: unknown, expectedSessionId?: string): PaperResourceProgress["resume"] | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.method !== "POST" || typeof record.available !== "boolean") return null;
  const reasonCode = record.reason_code === null
    ? null
    : typeof record.reason_code === "string" && SAFE_REASON_CODE.test(record.reason_code) ? record.reason_code : undefined;
  if (reasonCode === undefined) return null;
  if (!record.available) {
    if (record.continuation_id !== null || record.path !== null || record.body !== null) return null;
    return { available: false, continuation_id: null, method: "POST", path: null, body: null, reason_code: reasonCode };
  }
  const continuationId = requiredId(record.continuation_id);
  const path = typeof record.path === "string" && /^\/api\/paper\/continuations\/[^/]+$/.test(record.path) ? record.path : null;
  const body = record.body && typeof record.body === "object" ? record.body as Record<string, unknown> : null;
  const sessionId = body ? boundedText(body.session_id, 255) : null;
  if (!continuationId || !path || !body || !sessionId || (expectedSessionId !== undefined && sessionId !== expectedSessionId)
    || reasonCode !== null || record.continuation_id !== continuationId) return null;
  return { available: true, continuation_id: continuationId, method: "POST", path, body: { session_id: sessionId }, reason_code: null };
}

export function normalizePaperResourceProgress(value: unknown, expectedResourceId: string, expectedSessionId?: string): PaperResourceProgress | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const resourceRecord = record.resource && typeof record.resource === "object" ? record.resource as Record<string, unknown> : null;
  if (!resourceRecord) return null;
  const resourceId = requiredId(resourceRecord.resource_id);
  const status = typeof resourceRecord.status === "string" && RESOURCE_STATUSES.has(resourceRecord.status as PaperResourceProgressStatus)
    ? resourceRecord.status as PaperResourceProgressStatus : null;
  const stage = typeof resourceRecord.stage === "string" && RESOURCE_STATUSES.has(resourceRecord.stage as PaperResourceProgressStatus)
    ? resourceRecord.stage as PaperResourceProgressStatus : null;
  const sourceKind = typeof resourceRecord.source_kind === "string" && SOURCE_KINDS.has(resourceRecord.source_kind as PaperResourceProgress["resource"]["source_kind"])
    ? resourceRecord.source_kind as PaperResourceProgress["resource"]["source_kind"] : null;
  const title = resourceRecord.title === null ? null : boundedText(resourceRecord.title, 512);
  const pageCount = safeCount(resourceRecord.page_count);
  const imageCount = safeCount(resourceRecord.image_count);
  const error = normalizeError(resourceRecord.error);
  const createdAt = safeTimestamp(resourceRecord.created_at);
  const updatedAt = safeTimestamp(resourceRecord.updated_at);
  const readyAt = resourceRecord.ready_at === null ? null : safeTimestamp(resourceRecord.ready_at);
  const revision = boundedText(record.revision, 255);
  const materializeRecord = record.materialize && typeof record.materialize === "object" ? record.materialize as Record<string, unknown> : null;
  const invocationStatus = materializeRecord?.invocation_status === "succeeded" || materializeRecord?.invocation_status === "not_recorded"
    ? materializeRecord.invocation_status : null;
  const invocationEventId = materializeRecord?.invocation_event_id === null ? null : requiredId(materializeRecord?.invocation_event_id);
  const invokedAt = materializeRecord?.invoked_at === null ? null : safeTimestamp(materializeRecord?.invoked_at);
  const resourceReady = materializeRecord?.resource_ready;
  const correlationRecord = record.correlation && typeof record.correlation === "object" ? record.correlation as Record<string, unknown> : null;
  const rawContinuations = correlationRecord?.continuations;
  const continuations = Array.isArray(rawContinuations) ? rawContinuations.slice(0, 20).map(normalizeContinuation) : null;
  const events = Array.isArray(record.events) ? record.events.slice(0, 50).map(normalizeProgressEvent) : null;
  const resume = normalizeResume(record.resume, expectedSessionId);
  if (!resourceId || resourceId !== expectedResourceId || !status || !stage || status !== stage || !sourceKind
    || title === undefined || pageCount === null && resourceRecord.page_count !== null && resourceRecord.page_count !== undefined
    || imageCount === null && resourceRecord.image_count !== null && resourceRecord.image_count !== undefined
    || error === undefined || createdAt === null || updatedAt === null || readyAt === undefined || !revision
    || !materializeRecord || !invocationStatus || invocationEventId === undefined || invokedAt === undefined || typeof resourceReady !== "boolean"
    || !continuations || continuations.some((item) => item === null) || !events || events.some((item) => item === null) || !resume) return null;
  return {
    resource: {
      resource_id: resourceId,
      status,
      stage,
      source_kind: sourceKind,
      title,
      page_count: pageCount,
      image_count: imageCount,
      error,
      created_at: createdAt,
      updated_at: updatedAt,
      ready_at: readyAt,
    },
    revision,
    materialize: {
      invocation_status: invocationStatus,
      invocation_event_id: invocationEventId,
      invoked_at: invokedAt,
      resource_ready: resourceReady,
    },
    correlation: { continuations: continuations as PaperResourceProgress["correlation"]["continuations"] },
    events: events as PaperResourceProgress["events"],
    resume,
  };
}

function createApiError(message: string, status?: number, detail?: string): PaperApiError {
  const error = new Error(message) as PaperApiError;
  error.status = status;
  error.detail = detail;
  return error;
}

async function parseErrorResponse(response: Response): Promise<string> {
  const body = await response.text();
  try {
    const payload = JSON.parse(body) as { error?: { message?: unknown }; detail?: unknown };
    const message = payload?.error?.message ?? payload?.detail;
    if (typeof message === "string") return message;
  } catch {
    // Keep a stable status error when the endpoint does not return JSON.
  }
  return body || `HTTP ${response.status}`;
}

export async function getPaperResourceProgress(apiBase: string, sessionId: string, resourceId: string): Promise<PaperResourceProgress> {
  const url = `${apiBase}/api/paper/resources/${encodeURIComponent(resourceId)}/progress?session_id=${encodeURIComponent(sessionId)}`;
  let response: Response;
  try {
    response = await fetch(url, { method: "GET", credentials: "include", headers: withCsrfHeader({ Accept: "application/json" }) });
  } catch (error) {
    throw createApiError(`Network request failed: ${error instanceof Error ? error.message : "unknown error"}`, undefined, "network_error");
  }
  if (response.status === 401) throw createApiError("Authentication required", 401, "unauthenticated");
  if (!response.ok) throw createApiError(`Request failed (${response.status})`, response.status, await parseErrorResponse(response));
  const normalized = normalizePaperResourceProgress(await response.json(), resourceId, sessionId);
  if (!normalized) throw createApiError("Paper progress response was invalid", response.status, "invalid_progress_response");
  return normalized;
}

export async function resumePaperContinuation(apiBase: string, sessionId: string, continuationId: string): Promise<Response> {
  const url = `${apiBase}/api/paper/continuations/${encodeURIComponent(continuationId)}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      credentials: "include",
      headers: withCsrfHeader({ "Content-Type": "application/json", Accept: "text/event-stream" }),
      body: JSON.stringify({ session_id: sessionId }),
    });
  } catch (error) {
    throw createApiError(`Network request failed: ${error instanceof Error ? error.message : "unknown error"}`, undefined, "network_error");
  }
  if (response.status === 401) throw createApiError("Authentication required", 401, "unauthenticated");
  if (!response.ok) throw createApiError(`Request failed (${response.status})`, response.status, await parseErrorResponse(response));
  return response;
}
