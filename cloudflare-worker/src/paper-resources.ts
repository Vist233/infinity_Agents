import type { AuthedUser } from "./auth";
import type { Env } from "./env";
import { errorJson, json, nowSeconds } from "./http";
import {
  createPaperResource,
  cancelPaperResource,
  deletePaperResource,
  getChatSession,
  getOwnedPaperResourceProgress,
  getOwnedPaperResource,
  linkPaperResource,
  recordPaperAuditEvent,
  recordUserPaperUpload,
  revokePaperResourceLink,
  type PaperResourceProgressSnapshot,
  type PaperResourceStatus,
  type PaperResourcePurpose,
  type PaperResourceRow,
  type PaperSourceKind,
} from "./db";
import { getPaperObject, putPaperObject, type PaperObjectKind } from "./paper-object-store";
import { Sha256 } from "./sha256";

const SOURCE_KINDS = new Set<PaperSourceKind>(["arxiv", "pubmed_pmc", "user_upload"]);
const LINK_PURPOSES = new Set<PaperResourcePurpose>(["search_result", "read", "upload"]);
const OBJECT_KINDS = new Set<PaperObjectKind>(["source_pdf", "text_manifest", "image_manifest"]);
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const PAPER_PROGRESS_STATUSES = new Set<Exclude<PaperResourceStatus, "deleted">>([
  "requested", "downloading", "extracting", "uploading", "ready", "failed", "cancelled",
]);
const SAFE_ERROR_CODE = /^[A-Z0-9_]{1,64}$/;
const SENSITIVE_ERROR_TEXT = /(?:https?:\/\/|r2:\/\/|file:\/\/|\/(?:tmp|var|home|Users)\/|object[_-]?key|local[_-]?path|authorization|cookie|token|secret|credential)/i;

export type PaperProgressStatus = Exclude<PaperResourceStatus, "deleted">;

export interface PaperResourceProgressResponse {
  resource: {
    resource_id: string;
    status: PaperProgressStatus;
    stage: PaperProgressStatus;
    source_kind: PaperResourceRow["source_kind"];
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
      status: "waiting" | "ready" | "running" | "completed" | "failed" | "cancelled" | "expired";
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

function boundedText(value: unknown, maxChars: number): string {
  return typeof value === "string" ? value.slice(0, maxChars) : "";
}

function safeResource(row: PaperResourceRow): Record<string, unknown> {
  return {
    resource_id: row.resource_id,
    session_id: row.session_id,
    status: row.status,
    source_kind: row.source_kind,
    title: row.title,
    page_count: row.page_count,
    image_count: row.image_count,
    error_code: row.error_code,
    error_message_safe: row.error_message_safe,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ready_at: row.ready_at,
  };
}

function safeProgressError(row: PaperResourceRow): { code: string; message: string } | null {
  if (row.status !== "failed" && !row.error_code && !row.error_message_safe) return null;
  const code = row.error_code && SAFE_ERROR_CODE.test(row.error_code) ? row.error_code : "PAPER_RESOURCE_FAILED";
  const rawMessage = typeof row.error_message_safe === "string" ? row.error_message_safe.trim() : "";
  if (!rawMessage || SENSITIVE_ERROR_TEXT.test(rawMessage)) return { code, message: "Paper processing failed." };
  return { code, message: rawMessage.replace(/\s+/g, " ").slice(0, 512) || "Paper processing failed." };
}

function resumeReason(snapshot: PaperResourceProgressSnapshot, now: number): string {
  const resourceStatus = snapshot.resource.status;
  if (resourceStatus === "failed") return "PAPER_RESOURCE_FAILED";
  if (resourceStatus === "cancelled") return "PAPER_RESOURCE_CANCELLED";
  if (snapshot.continuations.length === 0) return "PAPER_CONTINUATION_NOT_FOUND";
  if (snapshot.continuations.some((continuation) => continuation.status === "expired" || continuation.expires_at <= now)) {
    return "PAPER_CONTINUATION_EXPIRED";
  }
  if (snapshot.continuations.some((continuation) => continuation.status === "running")) {
    return "PAPER_CONTINUATION_IN_PROGRESS";
  }
  if (snapshot.continuations.some((continuation) => continuation.status === "completed")) {
    return "PAPER_CONTINUATION_COMPLETED";
  }
  if (resourceStatus !== "ready") return "PAPER_RESOURCE_NOT_READY";
  return "PAPER_CONTINUATION_NOT_READY";
}

function progressResponse(snapshot: PaperResourceProgressSnapshot, sessionId: string, now = nowSeconds()): PaperResourceProgressResponse {
  const resource = snapshot.resource;
  if (!PAPER_PROGRESS_STATUSES.has(resource.status as PaperProgressStatus)) {
    throw new Error("Deleted paper resources do not have a progress snapshot");
  }
  const materializeEvents = snapshot.auditEvents
    .filter((event) => event.stage === "materialize" && event.outcome === "succeeded")
    .sort((left, right) => right.created_at - left.created_at || right.event_id.localeCompare(left.event_id));
  const materializeEvent = materializeEvents[0] ?? null;
  const resumable = resource.status === "ready"
    ? snapshot.continuations.find((continuation) => continuation.status === "ready" && continuation.expires_at > now)
    : undefined;
  const latestContinuationUpdated = Math.max(0, ...snapshot.continuations.map((continuation) => continuation.updated_at));
  const latestEventCreated = Math.max(0, ...snapshot.auditEvents.map((event) => event.created_at));

  return {
    resource: {
      resource_id: resource.resource_id,
      status: resource.status as PaperProgressStatus,
      stage: resource.status as PaperProgressStatus,
      source_kind: resource.source_kind,
      title: resource.title,
      page_count: resource.page_count,
      image_count: resource.image_count,
      error: safeProgressError(resource),
      created_at: resource.created_at,
      updated_at: resource.updated_at,
      ready_at: resource.ready_at,
    },
    revision: `${resource.updated_at}:${latestContinuationUpdated}:${latestEventCreated}`,
    materialize: {
      invocation_status: materializeEvent ? "succeeded" : "not_recorded",
      invocation_event_id: materializeEvent?.event_id ?? null,
      invoked_at: materializeEvent?.created_at ?? null,
      resource_ready: resource.status === "ready",
    },
    correlation: {
      continuations: snapshot.continuations.map((continuation) => ({
        continuation_id: continuation.continuation_id,
        original_turn_id: continuation.turn_id,
        status: continuation.status,
        expires_at: continuation.expires_at,
        updated_at: continuation.updated_at,
        completed_at: continuation.completed_at,
      })),
    },
    events: snapshot.auditEvents.map((event) => ({
      event_id: event.event_id,
      stage: event.stage,
      outcome: event.outcome,
      error_code: event.error_code && SAFE_ERROR_CODE.test(event.error_code) ? event.error_code : null,
      created_at: event.created_at,
    })),
    resume: resumable
      ? {
        available: true,
        continuation_id: resumable.continuation_id,
        method: "POST",
        path: `/api/paper/continuations/${encodeURIComponent(resumable.continuation_id)}`,
        body: { session_id: sessionId },
        reason_code: null,
      }
      : {
        available: false,
        continuation_id: null,
        method: "POST",
        path: null,
        body: null,
        reason_code: resumeReason(snapshot, now),
      },
  };
}

function sanitizeManifest(value: unknown): unknown {
  if (Array.isArray(value)) return value.slice(0, 10_000).map(sanitizeManifest);
  if (value && typeof value === "object") {
    const safeEntries = Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !/(?:object[_-]?key|local[_-]?path|authorization|cookie|token|secret|credential)/i.test(key))
      .slice(0, 1_000)
      .map(([key, child]) => [key, sanitizeManifest(child)] as const);
    return Object.fromEntries(safeEntries);
  }
  return typeof value === "string" ? boundedText(value, 4_096) : value;
}

function sessionIdFrom(request: Request): string {
  return new URL(request.url).searchParams.get("session_id")?.trim() ?? "";
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const value = await request.json();
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

async function createResource(request: Request, env: Env, user: AuthedUser): Promise<Response> {
  const body = await readJson(request);
  if (!body) return errorJson("Body must be JSON", 400, "BAD_JSON");
  const sessionId = String(body.session_id ?? "").trim();
  const sourceKind = String(body.source_kind ?? "") as PaperSourceKind;
  const sourceRef = String(body.source_ref ?? "").trim();
  const purpose = String(body.purpose ?? "read") as PaperResourcePurpose;
  if (sourceKind === "approved_url") {
    return errorJson("approved_url is not enabled in this release", 400, "PAPER_APPROVED_URL_DISABLED");
  }
  if (!sessionId || !SOURCE_KINDS.has(sourceKind) || !sourceRef || !LINK_PURPOSES.has(purpose)) {
    return errorJson("Invalid paper resource metadata", 400, "INVALID_PAPER_RESOURCE");
  }
  const session = await getChatSession(env, sessionId, user.userId);
  if (!session) return errorJson("Session not found", 404, "NOT_FOUND");
  try {
    const resource = await createPaperResource(env, {
      resource_id: crypto.randomUUID(),
      session_id: sessionId,
      user_id: user.userId,
      source_kind: sourceKind,
      source_ref: sourceRef,
      canonical_ref: typeof body.canonical_ref === "string" ? body.canonical_ref.trim() : null,
      title: typeof body.title === "string" ? body.title.trim() || null : null,
    });
    await linkPaperResource(env, sessionId, resource.resource_id, user.userId, purpose);
    return json(safeResource(resource), 201);
  } catch (error) {
    return errorJson(error instanceof Error ? error.message : "Paper resource creation failed", 400, "INVALID_PAPER_RESOURCE");
  }
}

async function ownedResource(request: Request, env: Env, user: AuthedUser, resourceId: string): Promise<{ resource: PaperResourceRow; sessionId: string } | Response> {
  const sessionId = sessionIdFrom(request);
  if (!sessionId || resourceId.includes("/") || resourceId.length > 255) return errorJson("Invalid paper resource reference", 400, "INVALID_PAPER_RESOURCE");
  const resource = await getOwnedPaperResource(env, resourceId, sessionId, user.userId);
  if (!resource) return errorJson("Paper resource not found", 404, "PAPER_RESOURCE_NOT_FOUND");
  return { resource, sessionId };
}

async function getResource(request: Request, env: Env, user: AuthedUser, resourceId: string): Promise<Response> {
  const result = await ownedResource(request, env, user, resourceId);
  if (result instanceof Response) return result;
  if (result.resource.status === "deleted") return errorJson("Paper resource was deleted", 410, "PAPER_RESOURCE_DELETED");
  return json(safeResource(result.resource));
}

async function getProgress(request: Request, env: Env, user: AuthedUser, resourceId: string): Promise<Response> {
  const sessionId = sessionIdFrom(request);
  if (!sessionId || resourceId.includes("/") || resourceId.length > 255) {
    return errorJson("Invalid paper resource reference", 400, "INVALID_PAPER_RESOURCE");
  }
  const snapshot = await getOwnedPaperResourceProgress(env, resourceId, sessionId, user.userId);
  if (!snapshot) return errorJson("Paper resource not found", 404, "PAPER_RESOURCE_NOT_FOUND");
  if (snapshot.resource.status === "deleted") return errorJson("Paper resource was deleted", 410, "PAPER_RESOURCE_DELETED");
  return json(progressResponse(snapshot, sessionId));
}

async function getManifest(request: Request, env: Env, user: AuthedUser, resourceId: string): Promise<Response> {
  const result = await ownedResource(request, env, user, resourceId);
  if (result instanceof Response) return result;
  const { resource } = result;
  if (resource.status === "deleted") return errorJson("Paper resource was deleted", 410, "PAPER_RESOURCE_DELETED");
  if (resource.status !== "ready" || !resource.text_manifest_key) return errorJson("Paper resource is not ready", 409, "PAPER_RESOURCE_NOT_READY");
  const object = await getPaperObject(env, resource.resource_id, "text_manifest");
  if (!object) return errorJson("Paper manifest not found", 404, "PAPER_MANIFEST_NOT_FOUND");
  const bytes = await object.arrayBuffer();
  if (bytes.byteLength > MAX_MANIFEST_BYTES) return errorJson("Paper manifest is too large", 422, "PAPER_MANIFEST_TOO_LARGE");
  try {
    const manifest = sanitizeManifest(JSON.parse(new TextDecoder().decode(bytes))) as Record<string, unknown>;
    return json({ ...manifest, resource_id: resource.resource_id });
  } catch {
    return errorJson("Paper manifest is invalid", 422, "PAPER_MANIFEST_INVALID");
  }
}

async function getObject(request: Request, env: Env, user: AuthedUser, resourceId: string): Promise<Response> {
  const result = await ownedResource(request, env, user, resourceId);
  if (result instanceof Response) return result;
  const { resource } = result;
  const kind = new URL(request.url).searchParams.get("kind") as PaperObjectKind | null;
  if (!kind || !OBJECT_KINDS.has(kind)) return errorJson("Unknown paper object", 400, "INVALID_PAPER_OBJECT");
  if (resource.status === "deleted") return errorJson("Paper resource was deleted", 410, "PAPER_RESOURCE_DELETED");
  if (resource.status !== "ready") return errorJson("Paper resource is not ready", 409, "PAPER_RESOURCE_NOT_READY");
  const recordedKey = kind === "source_pdf" ? resource.pdf_object_key : kind === "text_manifest" ? resource.text_manifest_key : resource.image_manifest_key;
  if (!recordedKey) return errorJson("Paper object is not available", 404, "PAPER_OBJECT_NOT_FOUND");
  const object = await getPaperObject(env, resource.resource_id, kind);
  if (!object) return errorJson("Paper object is not available", 404, "PAPER_OBJECT_NOT_FOUND");
  return new Response(object.body, {
    status: 200,
    headers: {
      "cache-control": "no-store",
      "content-type": object.httpMetadata?.contentType ?? (kind === "source_pdf" ? "application/pdf" : "application/json"),
    },
  });
}

async function imageManifestEntry(env: Env, resourceId: string, imageId: string): Promise<Record<string, unknown> | null> {
  const object = await getPaperObject(env, resourceId, "image_manifest");
  if (!object || object.size > MAX_MANIFEST_BYTES) return null;
  try {
    const manifest = JSON.parse(new TextDecoder().decode(await object.arrayBuffer())) as Record<string, unknown>;
    if (manifest.resource_id !== resourceId || !Array.isArray(manifest.images)) return null;
    const entry = manifest.images.find((value) => value && typeof value === "object" && (value as Record<string, unknown>).image_id === imageId);
    if (!entry || typeof entry !== "object") return null;
    const image = entry as Record<string, unknown>;
    if (!/^page-\d{4}-image-\d{4}$/.test(String(image.image_id)) || !Number.isSafeInteger(image.page) || Number(image.page) <= 0) return null;
    return image;
  } catch {
    return null;
  }
}

async function getImage(request: Request, env: Env, user: AuthedUser, resourceId: string): Promise<Response> {
  const result = await ownedResource(request, env, user, resourceId);
  if (result instanceof Response) return result;
  const { resource } = result;
  if (resource.status === "deleted") return errorJson("Paper resource was deleted", 410, "PAPER_RESOURCE_DELETED");
  if (resource.status !== "ready") return errorJson("Paper resource is not ready", 409, "PAPER_RESOURCE_NOT_READY");
  const imageId = new URL(request.url).searchParams.get("image_id")?.trim() ?? "";
  if (!/^page-\d{4}-image-\d{4}$/.test(imageId)) return errorJson("Invalid paper image", 400, "INVALID_PAPER_IMAGE");
  if (!(await imageManifestEntry(env, resource.resource_id, imageId))) return errorJson("Paper image is not in the manifest", 404, "PAPER_IMAGE_NOT_FOUND");
  const object = await getPaperObject(env, resource.resource_id, "image", imageId);
  if (!object) return errorJson("Paper image is not available", 404, "PAPER_IMAGE_NOT_FOUND");
  if (object.size > MAX_IMAGE_BYTES) return errorJson("Paper image is too large", 413, "PAPER_IMAGE_TOO_LARGE");
  return new Response(object.body, {
    status: 200,
    headers: {
      "cache-control": "private, no-store",
      "content-type": object.httpMetadata?.contentType ?? "image/png",
      "content-length": String(object.size),
      "content-disposition": "inline",
    },
  });
}

async function uploadUserSource(request: Request, env: Env, user: AuthedUser, resourceId: string): Promise<Response> {
  const result = await ownedResource(request, env, user, resourceId);
  if (result instanceof Response) return result;
  const { resource } = result;
  if (resource.source_kind !== "user_upload" || resource.status !== "requested" || resource.pdf_object_key) {
    return errorJson("Only a requested private upload can accept source bytes", 409, "PAPER_UPLOAD_STATE_CONFLICT");
  }
  if (new URL(request.url).searchParams.get("kind") !== "source_pdf") return errorJson("Only source_pdf uploads are supported", 400, "INVALID_PAPER_OBJECT");
  if (!request.body) return errorJson("Source PDF body is required", 400, "PAPER_OBJECT_BODY_REQUIRED");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_SOURCE_BYTES) {
        await reader.cancel("source PDF exceeds limit");
        return errorJson("Source PDF is too large", 413, "PAPER_SOURCE_TOO_LARGE");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  if (bytes.byteLength === 0 || new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-") return errorJson("Source is not a PDF", 422, "PAPER_SOURCE_NOT_PDF");
  const sha256 = new Sha256().update(bytes).digestHex();
  const expectedSha256 = request.headers.get("x-paper-object-sha256")?.trim().toLowerCase() ?? "";
  if (!/^[0-9a-f]{64}$/.test(expectedSha256)) return errorJson("Source PDF checksum is required", 400, "PAPER_SOURCE_CHECKSUM_REQUIRED");
  if (expectedSha256 !== sha256) return errorJson("Source PDF checksum mismatch", 422, "PAPER_SOURCE_CHECKSUM_MISMATCH");
  const stored = await putPaperObject(env, resourceId, "source_pdf", bytes, "application/pdf");
  if (!stored) return errorJson("Paper object storage is unavailable", 503, "PAPER_OBJECT_STORAGE_UNAVAILABLE");
  const recorded = await recordUserPaperUpload(env, { resourceId, sessionId: result.sessionId, userId: user.userId, sizeBytes: size, sha256 });
  if (!recorded) return errorJson("Paper upload was already accepted or is no longer pending", 409, "PAPER_UPLOAD_STATE_CONFLICT");
  await recordPaperAuditEvent(env, { resource_id: resourceId, attempt_id: null, stage: "upload", outcome: "succeeded", error_code: null, metadata_json: JSON.stringify({ size_bytes: size }), created_at: nowSeconds() });
  return json({ resource_id: resourceId, status: "requested", size_bytes: size, sha256 });
}

async function deleteResource(request: Request, env: Env, user: AuthedUser, resourceId: string): Promise<Response> {
  const result = await ownedResource(request, env, user, resourceId);
  if (result instanceof Response) return result;
  const now = nowSeconds();
  const deleted = await deletePaperResource(env, { resourceId, sessionId: result.sessionId, userId: user.userId, now });
  if (!deleted) return errorJson("Only a ready paper resource can be deleted", 409, "PAPER_RESOURCE_STATE_CONFLICT");
  await recordPaperAuditEvent(env, { resource_id: resourceId, attempt_id: null, stage: "delete", outcome: "succeeded", error_code: null, metadata_json: "{}", created_at: now });
  return json({ resource_id: resourceId, status: "deleted" });
}

async function cancelResource(request: Request, env: Env, user: AuthedUser, resourceId: string): Promise<Response> {
  const result = await ownedResource(request, env, user, resourceId);
  if (result instanceof Response) return result;
  const now = nowSeconds();
  const cancelled = await cancelPaperResource(env, { resourceId, sessionId: result.sessionId, userId: user.userId, now });
  if (!cancelled) return errorJson("Paper resource is not cancellable", 409, "PAPER_RESOURCE_STATE_CONFLICT");
  await recordPaperAuditEvent(env, { resource_id: resourceId, attempt_id: null, stage: "cancel", outcome: "cancelled", error_code: null, metadata_json: "{}", created_at: now });
  return json({ resource_id: resourceId, status: "cancelled" });
}

async function unlinkResource(request: Request, env: Env, user: AuthedUser, resourceId: string): Promise<Response> {
  const sessionId = sessionIdFrom(request);
  if (!sessionId) return errorJson("session_id is required", 400, "MISSING_SESSION");
  const revoked = await revokePaperResourceLink(env, sessionId, resourceId, user.userId);
  if (!revoked) return errorJson("Paper resource link not found", 404, "PAPER_LINK_NOT_FOUND");
  return json({ resource_id: resourceId, status: "revoked" });
}

export async function handlePaperResourceApi(request: Request, env: Env, user: AuthedUser): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === "/api/paper/resources" && request.method === "POST") return createResource(request, env, user);
  const match = url.pathname.match(/^\/api\/paper\/resources\/([^/]+)(?:\/(manifest|object|link|image|cancel|progress))?$/);
  if (!match) return null;
  const resourceId = decodeURIComponent(match[1]);
  const suffix = match[2];
  if (!suffix && request.method === "GET") return getResource(request, env, user, resourceId);
  if (suffix === "progress" && request.method === "GET") return getProgress(request, env, user, resourceId);
  if (suffix === "manifest" && request.method === "GET") return getManifest(request, env, user, resourceId);
  if (suffix === "object" && request.method === "GET") return getObject(request, env, user, resourceId);
  if (suffix === "object" && request.method === "PUT") return uploadUserSource(request, env, user, resourceId);
  if (suffix === "image" && request.method === "GET") return getImage(request, env, user, resourceId);
  if (suffix === "cancel" && request.method === "POST") return cancelResource(request, env, user, resourceId);
  if (suffix === "link" && request.method === "DELETE") return unlinkResource(request, env, user, resourceId);
  if (!suffix && request.method === "DELETE") return deleteResource(request, env, user, resourceId);
  return errorJson("Method not allowed", 405, "METHOD_NOT_ALLOWED");
}
