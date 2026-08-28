import type { Env } from "./env";
import { errorJson, json, nowSeconds } from "./http";
import {
  cancelPaperProcessorAttempt,
  claimPaperResource,
  createPaperProcessorSession,
  finalizePaperProcessorAttempt,
  failPaperProcessorAttempt,
  getActivePaperProcessorSessionByToken,
  getAuthorizedPaperProcessorAttempt,
  recordPaperProcessorObject,
  recordPaperAuditEvent,
  renewPaperProcessorAttempt,
  stagePaperProcessorAttempt,
  touchPaperProcessorSession,
  type PaperProcessorSessionRow,
  type PaperProcessorAttemptContext,
  type PaperUploadedObjectKind,
} from "./db";
import { getPaperObject, putPaperObject, type PaperObjectKind } from "./paper-object-store";
import { Sha256, hashText } from "./sha256";
import { isApprovedPaperProcessorRequest, isPaperProcessorNamespacePath } from "./paper-processor-access";

const PREFIX = "/api/paper-processor";
const SESSION_TTL_SECONDS = 15 * 60;
const LEASE_SECONDS = 5 * 60;
const MAX_ID_BYTES = 255;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_PDF_BYTES = 64 * 1024 * 1024;
const OBJECT_KINDS = new Set<PaperObjectKind>(["source_pdf", "text_pages", "text_manifest", "image", "image_manifest"]);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/;

type SessionContext = { session: PaperProcessorSessionRow; now: number };

function token(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `${prefix}_${btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")}`;
}

function validId(value: string): boolean {
  return value.length > 0 && value.length <= MAX_ID_BYTES && ID_PATTERN.test(value);
}

async function bodyJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const value = await request.json();
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function stringField(body: Record<string, unknown> | null, name: string): string {
  return typeof body?.[name] === "string" ? body[name]!.trim() : "";
}

function numberField(body: Record<string, unknown> | null, name: string): number | null {
  const value = body?.[name];
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function processorHeaders(request: Request): { token: string } | null {
  const sessionToken = request.headers.get("x-paper-processor-session")?.trim() ?? "";
  if (sessionToken.length < 16 || sessionToken.length > 512) return null;
  return { token: sessionToken };
}

async function authenticateSession(request: Request, env: Env): Promise<SessionContext | Response> {
  const headers = processorHeaders(request);
  if (!headers) return errorJson("Paper Processor session required", 401, "PAPER_PROCESSOR_UNAUTHENTICATED");
  const now = nowSeconds();
  const session = await getActivePaperProcessorSessionByToken(env, hashText(headers.token), now);
  if (!session) return errorJson("Paper Processor session is invalid or expired", 401, "PAPER_PROCESSOR_SESSION_INVALID");
  const touched = await touchPaperProcessorSession(env, session.processor_session_id, now, now + SESSION_TTL_SECONDS);
  if (!touched) return errorJson("Paper Processor session is no longer active", 401, "PAPER_PROCESSOR_SESSION_INVALID");
  return { session, now };
}

function leaseInput(request: Request, body: Record<string, unknown> | null): {
  attemptId: string;
  resourceId: string;
  fencingEpoch: number;
  leaseTokenHash: string;
} | Response {
  const match = new URL(request.url).pathname.match(/^\/api\/paper-processor\/attempts\/([^/]+)\//);
  const attemptId = match ? decodeURIComponent(match[1]) : "";
  const resourceId = stringField(body, "resource_id") || new URL(request.url).searchParams.get("resource_id")?.trim() || "";
  const fencingEpoch = numberField(body, "fencing_epoch") ?? Number(new URL(request.url).searchParams.get("fencing_epoch"));
  const leaseToken = request.headers.get("x-paper-processor-lease-token")?.trim() ?? "";
  if (!validId(attemptId) || !validId(resourceId) || !Number.isSafeInteger(fencingEpoch) || fencingEpoch <= 0 || leaseToken.length < 16 || leaseToken.length > 512) {
    return errorJson("Paper Processor attempt lease is invalid", 409, "PAPER_PROCESSOR_LEASE_CONFLICT");
  }
  return { attemptId, resourceId, fencingEpoch, leaseTokenHash: hashText(leaseToken) };
}

async function authorizeAttempt(
  request: Request,
  env: Env,
  context: SessionContext,
  body: Record<string, unknown> | null,
): Promise<PaperProcessorAttemptContext | Response> {
  const lease = leaseInput(request, body);
  if (lease instanceof Response) return lease;
  const authorized = await getAuthorizedPaperProcessorAttempt(env, {
    ...lease,
    processorId: context.session.processor_id,
    now: context.now,
  });
  return authorized ?? errorJson("Paper Processor lease is stale or mismatched", 409, "PAPER_PROCESSOR_LEASE_CONFLICT");
}

async function connect(request: Request, env: Env): Promise<Response> {
  const processorId = request.headers.get("x-paper-processor-id")?.trim() ?? "";
  const bootstrap = request.headers.get("x-paper-processor-token")?.trim() ?? "";
  if (!env.PAPER_PROCESSOR_ID || !env.PAPER_PROCESSOR_SHARED_SECRET
    || processorId !== env.PAPER_PROCESSOR_ID
    || bootstrap.length < 16 || hashText(bootstrap) !== hashText(env.PAPER_PROCESSOR_SHARED_SECRET)) {
    return errorJson("Paper Processor bootstrap authentication failed", 401, "PAPER_PROCESSOR_UNAUTHENTICATED");
  }
  const body = await bodyJson(request);
  const instanceId = stringField(body, "instance_id");
  if (!validId(instanceId)) return errorJson("Processor instance_id is invalid", 400, "INVALID_PAPER_PROCESSOR_INSTANCE");
  const now = nowSeconds();
  const sessionId = token("pps");
  const sessionToken = token("session");
  await createPaperProcessorSession(env, {
    processor_session_id: sessionId,
    processor_id: processorId,
    instance_id: instanceId,
    session_token_hash: hashText(sessionToken),
    created_at: now,
    last_seen_at: now,
    expires_at: now + SESSION_TTL_SECONDS,
    revoked_at: null,
  });
  return json({ processor_session_id: sessionId, processor_session_token: sessionToken, expires_at: now + SESSION_TTL_SECONDS });
}

async function poll(request: Request, env: Env, context: SessionContext): Promise<Response> {
  const body = await bodyJson(request);
  if (body && (Object.prototype.hasOwnProperty.call(body, "resource_ids") || Object.prototype.hasOwnProperty.call(body, "all"))) {
    return errorJson("Processor resource selection is server-controlled", 400, "PAPER_PROCESSOR_SCOPE_FORBIDDEN");
  }
  const leaseToken = token("lease");
  const now = context.now;
  const grant = await claimPaperResource(env, {
    processorId: context.session.processor_id,
    attemptId: crypto.randomUUID(),
    leaseTokenHash: hashText(leaseToken),
    leaseExpiresAt: now + LEASE_SECONDS,
    now,
  }, leaseToken);
  return grant ? json(grant) : json({ resource: null });
}

async function input(request: Request, env: Env, context: SessionContext): Promise<Response> {
  const authorized = await authorizeAttempt(request, env, context, null);
  if (authorized instanceof Response) return authorized;
  return json({
    resource_id: authorized.resource.resource_id,
    source_kind: authorized.resource.source_kind,
    source_ref: authorized.resource.source_ref,
    canonical_ref: authorized.resource.canonical_ref,
    title: authorized.resource.title,
  });
}

async function inputObject(request: Request, env: Env, context: SessionContext): Promise<Response> {
  const authorized = await authorizeAttempt(request, env, context, null);
  if (authorized instanceof Response) return authorized;
  if (authorized.resource.source_kind !== "user_upload" || !authorized.resource.pdf_object_key) {
    return errorJson("Private source object is not available", 409, "PAPER_SOURCE_OBJECT_MISSING");
  }
  const object = await getPaperObject(env, authorized.resource.resource_id, "source_pdf");
  if (!object) return errorJson("Private source object is not available", 404, "PAPER_SOURCE_OBJECT_MISSING");
  return new Response(object.body, { status: 200, headers: { "cache-control": "no-store", "content-type": "application/pdf" } });
}

async function renew(request: Request, env: Env, context: SessionContext): Promise<Response> {
  const body = await bodyJson(request);
  const authorized = await authorizeAttempt(request, env, context, body);
  if (authorized instanceof Response) return authorized;
  const lease = leaseInput(request, body);
  if (lease instanceof Response) return lease;
  const leaseExpiresAt = context.now + LEASE_SECONDS;
  const renewed = await renewPaperProcessorAttempt(env, { ...lease, processorId: context.session.processor_id, now: context.now, leaseExpiresAt });
  return renewed ? json({ attempt_id: lease.attemptId, lease_expires_at: leaseExpiresAt }) : errorJson("Paper Processor lease is stale", 409, "PAPER_PROCESSOR_LEASE_CONFLICT");
}

async function stage(request: Request, env: Env, context: SessionContext): Promise<Response> {
  const body = await bodyJson(request);
  const stageValue = stringField(body, "stage");
  if (stageValue !== "extracting" && stageValue !== "uploading") return errorJson("Invalid Paper Processor stage", 400, "INVALID_PAPER_PROCESSOR_STAGE");
  const lease = leaseInput(request, body);
  if (lease instanceof Response) return lease;
  const staged = await stagePaperProcessorAttempt(env, { ...lease, processorId: context.session.processor_id, now: context.now, stage: stageValue });
  if (staged) {
    await recordPaperAuditEvent(env, {
      resource_id: lease.resourceId,
      attempt_id: lease.attemptId,
      stage: stageValue === "extracting" ? "extraction" : "upload",
      outcome: "started",
      error_code: null,
      metadata_json: JSON.stringify({ fencing_epoch: lease.fencingEpoch }),
      created_at: context.now,
    });
  }
  return staged ? json({ attempt_id: lease.attemptId, status: stageValue }) : errorJson("Paper Processor stage is stale or out of order", 409, "PAPER_PROCESSOR_STATE_CONFLICT");
}

async function readBoundedBody(request: Request, maximumBytes: number): Promise<Uint8Array | Response> {
  if (!request.body) return errorJson("Paper object body is required", 400, "PAPER_OBJECT_BODY_REQUIRED");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel("paper object exceeds limit");
        return errorJson("Paper object is too large", 413, "PAPER_OBJECT_TOO_LARGE");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

async function upload(request: Request, env: Env, context: SessionContext, kind: PaperObjectKind): Promise<Response> {
  const url = new URL(request.url);
  const resourceId = url.searchParams.get("resource_id")?.trim() ?? "";
  const fencingEpoch = Number(url.searchParams.get("fencing_epoch"));
  const objectId = kind === "text_pages" ? "pages" : kind === "image" ? url.searchParams.get("image_id")?.trim() ?? "" : undefined;
  if (kind === "text_pages" && objectId !== "pages") return errorJson("Text page object id is fixed", 400, "INVALID_PAPER_OBJECT");
  if (kind === "image" && !/^page-\d{4}-image-\d{4}$/.test(objectId ?? "")) return errorJson("Image object id is invalid", 400, "INVALID_PAPER_OBJECT");
  const body = { resource_id: resourceId, fencing_epoch: fencingEpoch };
  const authorized = await authorizeAttempt(request, env, context, body);
  if (authorized instanceof Response) return authorized;
  const bytes = await readBoundedBody(request, kind === "source_pdf" ? MAX_PDF_BYTES : MAX_MANIFEST_BYTES);
  if (bytes instanceof Response) return bytes;
  const expectedHash = request.headers.get("x-paper-object-sha256")?.trim().toLowerCase() ?? "";
  if (!/^[0-9a-f]{64}$/.test(expectedHash)) return errorJson("Paper object checksum is required", 400, "PAPER_OBJECT_CHECKSUM_REQUIRED");
  const measuredHash = new Sha256().update(bytes).digestHex();
  if (measuredHash !== expectedHash) return errorJson("Paper object checksum mismatch", 422, "PAPER_OBJECT_CHECKSUM_MISMATCH");
  const contentType = kind === "source_pdf" ? "application/pdf" : kind === "image" ? (request.headers.get("content-type")?.split(";", 1)[0] || "image/png") : "application/json";
  if (kind === "image" && !["image/png", "image/jpeg", "image/jp2"].includes(contentType)) return errorJson("Paper image content type is not supported", 400, "INVALID_PAPER_IMAGE");
  const stored = await putPaperObject(env, resourceId, kind, bytes, contentType, objectId);
  if (!stored) return errorJson("Paper object storage is unavailable", 503, "PAPER_OBJECT_STORAGE_UNAVAILABLE");
  const recorded = await recordPaperProcessorObject(env, {
    attemptId: authorized.attempt.attempt_id,
    resourceId,
    processorId: context.session.processor_id,
    leaseTokenHash: hashText(request.headers.get("x-paper-processor-lease-token")!.trim()),
    fencingEpoch,
    now: context.now,
    kind: kind as PaperUploadedObjectKind,
    objectId,
    sizeBytes: bytes.byteLength,
    sha256: measuredHash,
    contentType,
  });
  if (!recorded) return errorJson("Paper Processor object lease is stale", 409, "PAPER_PROCESSOR_LEASE_CONFLICT");
  return json({ attempt_id: authorized.attempt.attempt_id, resource_id: resourceId, kind, object_id: objectId ?? null, status: "uploaded" });
}

function safeManifestMetadata(value: unknown, resourceId: string): { pageCount: number | null; imageCount: number | null } | Response {
  if (!value || typeof value !== "object" || Array.isArray(value)) return errorJson("Paper manifest must be an object", 400, "INVALID_PAPER_MANIFEST");
  const object = value as Record<string, unknown>;
  if (object.resource_id !== resourceId) return errorJson("Paper manifest resource mismatch", 409, "PAPER_PROCESSOR_RESOURCE_CONFLICT");
  const serialized = JSON.stringify(object);
  if (serialized.length > MAX_MANIFEST_BYTES) return errorJson("Paper manifest is too large", 413, "PAPER_MANIFEST_TOO_LARGE");
  const forbidden = JSON.stringify(object).match(/object[_-]?key|local[_-]?path|authorization|cookie|token|secret|credential/i);
  if (forbidden) return errorJson("Paper manifest contains a forbidden field", 400, "PAPER_MANIFEST_FORBIDDEN");
  const pageCount = object.page_count == null ? null : Number(object.page_count);
  const imageCount = object.image_count == null ? (Array.isArray(object.images) ? object.images.length : 0) : Number(object.image_count);
  if ((pageCount != null && (!Number.isSafeInteger(pageCount) || pageCount < 0 || pageCount > 10000))
    || (imageCount != null && (!Number.isSafeInteger(imageCount) || imageCount < 0 || imageCount > 100000))) {
    return errorJson("Paper manifest counts are invalid", 400, "INVALID_PAPER_MANIFEST");
  }
  return { pageCount, imageCount };
}

async function finalize(request: Request, env: Env, context: SessionContext): Promise<Response> {
  const body = await bodyJson(request);
  const lease = leaseInput(request, body);
  if (lease instanceof Response) return lease;
  const authorized = await authorizeAttempt(request, env, context, body);
  if (authorized instanceof Response) return authorized;
  const metadata = safeManifestMetadata(body?.manifest, lease.resourceId);
  if (metadata instanceof Response) return metadata;
  if (!authorized.resource.text_manifest_key || !env.RESOURCE_BUCKET) return errorJson("Paper text manifest is not uploaded", 409, "PAPER_PROCESSOR_OBJECT_MISSING");
  const object = await getPaperObject(env, lease.resourceId, "text_manifest");
  if (!object) return errorJson("Paper text manifest is not available", 409, "PAPER_PROCESSOR_OBJECT_MISSING");
  const done = await finalizePaperProcessorAttempt(env, {
    ...lease,
    processorId: context.session.processor_id,
    now: context.now,
    pageCount: metadata.pageCount,
    imageCount: metadata.imageCount,
  });
  if (done) {
    await recordPaperAuditEvent(env, {
      resource_id: lease.resourceId,
      attempt_id: lease.attemptId,
      stage: "upload",
      outcome: "succeeded",
      error_code: null,
      metadata_json: JSON.stringify({ page_count: metadata.pageCount, image_count: metadata.imageCount }),
      created_at: context.now,
    });
  }
  return done ? json({ resource_id: lease.resourceId, status: "ready", page_count: metadata.pageCount, image_count: metadata.imageCount })
    : errorJson("Paper Processor finalize is stale or out of order", 409, "PAPER_PROCESSOR_STATE_CONFLICT");
}

async function cancel(request: Request, env: Env, context: SessionContext): Promise<Response> {
  const body = await bodyJson(request);
  const lease = leaseInput(request, body);
  if (lease instanceof Response) return lease;
  const cancelled = await cancelPaperProcessorAttempt(env, { ...lease, processorId: context.session.processor_id, now: context.now });
  if (cancelled) {
    await recordPaperAuditEvent(env, {
      resource_id: lease.resourceId,
      attempt_id: lease.attemptId,
      stage: "cancel",
      outcome: "cancelled",
      error_code: null,
      metadata_json: "{}",
      created_at: context.now,
    });
  }
  return cancelled ? json({ resource_id: lease.resourceId, status: "cancelled" }) : errorJson("Paper Processor cancellation is stale", 409, "PAPER_PROCESSOR_STATE_CONFLICT");
}

async function fail(request: Request, env: Env, context: SessionContext): Promise<Response> {
  const body = await bodyJson(request);
  const authorized = await authorizeAttempt(request, env, context, body);
  if (authorized instanceof Response) return authorized;
  const lease = leaseInput(request, body);
  if (lease instanceof Response) return lease;
  const errorCode = stringField(body, "error_code");
  const errorMessage = stringField(body, "error_message").slice(0, 1_024) || "Paper Processor rejected the resource";
  if (!/^[A-Z0-9_]{1,64}$/.test(errorCode)) return errorJson("Processor error code is invalid", 400, "INVALID_PAPER_PROCESSOR_ERROR");
  const failed = await failPaperProcessorAttempt(env, { ...lease, processorId: context.session.processor_id, now: context.now, errorCode, errorMessageSafe: errorMessage });
  if (failed) {
    const auditStage = authorized.resource.status === "downloading" ? "download" : authorized.resource.status === "extracting" ? "extraction" : "upload";
    await recordPaperAuditEvent(env, {
      resource_id: lease.resourceId,
      attempt_id: lease.attemptId,
      stage: auditStage,
      outcome: "failed",
      error_code: errorCode,
      metadata_json: "{}",
      created_at: context.now,
    });
  }
  return failed ? json({ resource_id: lease.resourceId, status: "failed", error_code: errorCode }) : errorJson("Paper Processor failure is stale", 409, "PAPER_PROCESSOR_STATE_CONFLICT");
}

export async function handlePaperProcessorApi(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (!isPaperProcessorNamespacePath(url.pathname)) return null;
  if (!isApprovedPaperProcessorRequest(request, env)) {
    return errorJson("Paper Processor source or route is not approved", 403, "PAPER_PROCESSOR_SOURCE_FORBIDDEN");
  }
  if (url.pathname === "/api/paper-processor/connect") {
    if (request.method !== "POST") return errorJson("Method not allowed", 405, "METHOD_NOT_ALLOWED");
    return connect(request, env);
  }
  if (!url.pathname.startsWith(`${PREFIX}/`)) return null;
  const context = await authenticateSession(request, env);
  if (context instanceof Response) return context;
  if (url.pathname === `${PREFIX}/poll` && request.method === "POST") return poll(request, env, context);
  const inputObjectMatch = url.pathname.match(/^\/api\/paper-processor\/attempts\/([^/]+)\/input\/object$/);
  if (inputObjectMatch && request.method === "GET") return inputObject(request, env, context);
  const inputMatch = url.pathname.match(/^\/api\/paper-processor\/attempts\/([^/]+)\/input$/);
  if (inputMatch && request.method === "GET") return input(request, env, context);
  const renewMatch = url.pathname.match(/^\/api\/paper-processor\/attempts\/([^/]+)\/renew$/);
  if (renewMatch && request.method === "POST") return renew(request, env, context);
  const stageMatch = url.pathname.match(/^\/api\/paper-processor\/attempts\/([^/]+)\/stage$/);
  if (stageMatch && request.method === "POST") return stage(request, env, context);
  const uploadMatch = url.pathname.match(/^\/api\/paper-processor\/attempts\/([^/]+)\/objects\/([^/]+)$/);
  if (uploadMatch && request.method === "PUT" && OBJECT_KINDS.has(uploadMatch[2] as PaperObjectKind)) {
    return upload(request, env, context, uploadMatch[2] as PaperObjectKind);
  }
  const finalizeMatch = url.pathname.match(/^\/api\/paper-processor\/attempts\/([^/]+)\/finalize$/);
  if (finalizeMatch && request.method === "POST") return finalize(request, env, context);
  const cancelMatch = url.pathname.match(/^\/api\/paper-processor\/attempts\/([^/]+)\/cancel$/);
  if (cancelMatch && request.method === "POST") return cancel(request, env, context);
  const failMatch = url.pathname.match(/^\/api\/paper-processor\/attempts\/([^/]+)\/fail$/);
  if (failMatch && request.method === "POST") return fail(request, env, context);
  return errorJson("Not found", 404, "NOT_FOUND");
}
