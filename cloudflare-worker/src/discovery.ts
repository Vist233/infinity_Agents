import type { AuthedUser } from "./auth";
import type { Env } from "./env";
import { errorJson, json, nowSeconds } from "./http";
import { createChatSession } from "./db";
import {
  createPaperResource,
  deletePaperResource,
  linkPaperResource,
  recordUserPaperUpload,
} from "./db";
import { putPaperObject } from "./paper-object-store";
import {
  createPaperCatalog,
  createCollection,
  findCollectionBySha,
  findPaperByOwnerSha,
  getCollectionById,
  getCollectionForUser,
  collectionHasActiveTask,
  getMatchForUser,
  getPaperById,
  getPaperForUser,
  getPaperResourceForCatalogOwner,
  listCollectionsForUser,
  listMatchesForUser,
  listPapersForUser,
  markCollectionDeletedForUser,
  markPaperDeletedForUser,
} from "./discovery-db";
import { normalizeDatasetProfile, normalizePaperProfile } from "./discovery-contracts";
import {
  deleteDiscoveryObject,
  deleteDiscoveryObjectAtKey,
  getDiscoveryObjectAtKey,
  putDiscoveryObject,
  safeDiscoveryFilename,
} from "./discovery-object-store";
import { Sha256 } from "./sha256";
import { createDiscoveryTask } from "./discovery-task";

export const DISCOVERY_MAX_PAPER_BYTES = 64 * 1024 * 1024;
export const DISCOVERY_MAX_COLLECTION_BYTES = 25 * 1024 * 1024;
const MAX_MULTIPART_OVERHEAD = 1 * 1024 * 1024;
const PAPER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/;

class MultipartLimitError extends Error {
  constructor() {
    super("multipart body exceeds the bounded envelope limit");
    this.name = "MultipartLimitError";
  }
}

interface UploadedFileLike {
  name?: string;
  type?: string;
  size?: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

function isUploadedFile(value: unknown): value is UploadedFileLike {
  return Boolean(value) && typeof value !== "string" && typeof (value as Partial<UploadedFileLike>).arrayBuffer === "function";
}

function safeText(value: unknown, fallback: string, maxLength: number): string {
  const text = typeof value === "string" ? value.trim() : "";
  return (text || fallback).slice(0, maxLength);
}

function defaultPaperTitle(fileName: string): string {
  const base = fileName.replace(/\\/g, "/").split("/").pop() ?? "Uploaded paper";
  return (base.replace(/\.pdf$/i, "").trim() || "Uploaded paper").slice(0, 512);
}

function safeAuthors(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string").slice(0, 128) : [];
  } catch {
    return [];
  }
}

function parsedJson(value: string | null): unknown | null {
  if (!value || value.length > 1_048_576) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

async function readUpload(file: UploadedFileLike, maximumBytes: number): Promise<{ bytes: Uint8Array; sha256: string } | Response> {
  if (typeof file.size === "number" && Number.isFinite(file.size) && file.size > maximumBytes) {
    return errorJson("Uploaded file is too large", 413, "DISCOVERY_UPLOAD_TOO_LARGE");
  }
  let raw: ArrayBuffer;
  try {
    raw = await file.arrayBuffer();
  } catch {
    return errorJson("Uploaded file could not be read", 400, "DISCOVERY_UPLOAD_INVALID");
  }
  if (raw.byteLength === 0 || raw.byteLength > maximumBytes) return errorJson("Uploaded file is too large or empty", 413, "DISCOVERY_UPLOAD_TOO_LARGE");
  const bytes = new Uint8Array(raw);
  return { bytes, sha256: new Sha256().update(bytes).digestHex() };
}

function multipartTooLarge(request: Request, maximumFileBytes: number): boolean {
  const length = Number(request.headers.get("content-length") ?? "");
  return Number.isSafeInteger(length) && length > maximumFileBytes + MAX_MULTIPART_OVERHEAD;
}

function isPdf(bytes: Uint8Array): boolean {
  return new TextDecoder().decode(bytes.subarray(0, 5)) === "%PDF-";
}

function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07) && (bytes[3] === 0x04 || bytes[3] === 0x06 || bytes[3] === 0x08);
}

function supportedDataExtension(fileName: string): boolean {
  return /\.(?:csv|tsv|json|jsonl|txt|md|readme)$/i.test(fileName);
}

function contentTypeForData(file: UploadedFileLike, fileName: string, bytes: Uint8Array): string {
  const supplied = typeof file.type === "string" ? file.type.split(";", 1)[0].trim().toLowerCase() : "";
  if (supplied && supplied !== "application/octet-stream") return supplied.slice(0, 128);
  if (isZip(bytes) || /\.zip$/i.test(fileName)) return "application/zip";
  if (/\.jsonl?$/i.test(fileName)) return "application/json";
  if (/\.tsv$/i.test(fileName)) return "text/tab-separated-values";
  if (/\.(?:txt|md|readme)$/i.test(fileName)) return "text/plain";
  return "text/csv";
}

function publicPaper(row: Awaited<ReturnType<typeof getPaperForUser>>, profile?: unknown, overview?: string | null): Record<string, unknown> | null {
  if (!row) return null;
  return {
    paper_id: row.paper_id,
    visibility: row.visibility,
    title: row.title,
    authors: safeAuthors(row.authors_json),
    year: row.year,
    venue: row.venue,
    status: row.status,
    spam_status: row.spam_status,
    profile_version: row.profile_version,
    profile: profile ?? null,
    overview: overview ?? null,
    source_status: row.status === "profiled" ? "ready" : row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function publicCollection(row: Awaited<ReturnType<typeof getCollectionForUser>>, profile?: unknown): Record<string, unknown> | null {
  if (!row) return null;
  return {
    collection_id: row.collection_id,
    name: row.name,
    source_filename: row.source_filename,
    source_content_type: row.source_content_type,
    source_size_bytes: row.source_size_bytes,
    status: row.status,
    profile_version: row.profile_version,
    profile: profile ?? null,
    error: row.error_code ? { code: row.error_code, message: row.error_message_safe ?? "Inspection failed." } : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function boundedFormData(request: Request, maximumFileBytes: number): Promise<FormData | Response> {
  const maximumBodyBytes = maximumFileBytes + MAX_MULTIPART_OVERHEAD;
  if (multipartTooLarge(request, maximumFileBytes)) return errorJson("Uploaded file is too large", 413, "DISCOVERY_UPLOAD_TOO_LARGE");
  if (!request.body) return errorJson("Invalid multipart upload", 400, "DISCOVERY_UPLOAD_INVALID");
  const source = request.body;
  let total = 0;
  let exceeded = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  const boundedBody = new ReadableStream<Uint8Array>({
    async start(controller) {
      reader = source.getReader();
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) {
            controller.close();
            return;
          }
          const chunk = next.value instanceof Uint8Array ? next.value : new Uint8Array(next.value);
          total += chunk.byteLength;
          if (total > maximumBodyBytes) {
            exceeded = true;
            await reader.cancel("multipart envelope exceeds limit");
            controller.error(new MultipartLimitError());
            return;
          }
          controller.enqueue(chunk);
        }
      } catch (error) {
        controller.error(error);
      } finally {
        reader.releaseLock();
        reader = null;
      }
    },
    async cancel(reason) {
      if (reader) await reader.cancel(reason);
    },
  });
  try {
    // The bounded stream is the body seen by the multipart parser. This keeps
    // chunked requests subject to the same cap as requests with a length
    // header, before formData() can accumulate an unbounded body.
    return await new Request(request, { body: boundedBody, duplex: "half" } as unknown as RequestInit).formData();
  } catch (error) {
    if (exceeded || error instanceof MultipartLimitError) return errorJson("Uploaded file is too large", 413, "DISCOVERY_UPLOAD_TOO_LARGE");
    return errorJson("Invalid multipart upload", 400, "DISCOVERY_UPLOAD_INVALID");
  }
}

async function createPaper(request: Request, env: Env, user: AuthedUser): Promise<Response> {
  if (!env.RESOURCE_BUCKET) return errorJson("Paper object storage is unavailable", 503, "DISCOVERY_STORAGE_UNAVAILABLE");
  const body = await boundedFormData(request, DISCOVERY_MAX_PAPER_BYTES);
  if (body instanceof Response) return body;
  const file = body.get("file");
  if (!isUploadedFile(file)) return errorJson("A PDF file is required", 400, "DISCOVERY_PAPER_FILE_REQUIRED");
  const loaded = await readUpload(file, DISCOVERY_MAX_PAPER_BYTES);
  if (loaded instanceof Response) return loaded;
  if (!isPdf(loaded.bytes)) return errorJson("The uploaded file is not a PDF", 422, "DISCOVERY_PAPER_NOT_PDF");

  const duplicate = await findPaperByOwnerSha(env, user.userId, loaded.sha256);
  if (duplicate) return json({ ...publicPaper(duplicate), duplicate: true });

  const fileName = safeDiscoveryFilename(file.name ?? "paper.pdf", "paper.pdf");
  const title = safeText(body.get("title"), defaultPaperTitle(file.name ?? "paper.pdf"), 512);
  const sessionId = crypto.randomUUID();
  const resourceId = crypto.randomUUID();
  const paperId = crypto.randomUUID();
  try {
    await createChatSession(env, sessionId, user.userId, `Paper: ${title}`);
    await createPaperResource(env, {
      resource_id: resourceId,
      session_id: sessionId,
      user_id: user.userId,
      source_kind: "user_upload",
      source_ref: `discovery-upload:${loaded.sha256}`,
      canonical_ref: null,
      title,
    });
    if (!(await linkPaperResource(env, sessionId, resourceId, user.userId, "upload"))) throw new Error("resource link failed");
    const stored = await putPaperObject(env, resourceId, "source_pdf", loaded.bytes, "application/pdf");
    if (!stored || !(await recordUserPaperUpload(env, { resourceId, sessionId, userId: user.userId, sizeBytes: loaded.bytes.byteLength, sha256: loaded.sha256 }))) {
      throw new Error("source finalization failed");
    }
    if (!(await createPaperCatalog(env, { paperId, ownerUserId: user.userId, resourceId, visibility: "private", title, authorsJson: "[]" }))) {
      throw new Error("catalog insert failed");
    }
  } catch {
    // A failed catalog finalization is not exposed as a successful upload. The
    // resource cleanup job remains the recoverable source-of-truth cleanup.
    try { await deletePaperResource(env, { resourceId, sessionId, userId: user.userId }); } catch { /* best effort */ }
    return errorJson("Paper upload could not be persisted", 503, "DISCOVERY_PAPER_PERSIST_FAILED");
  }
  const paper = await getPaperForUser(env, paperId, user.userId);
  return json({ ...publicPaper(paper), source_resource_id: resourceId, source_filename: fileName, duplicate: false }, 201);
}

async function getPaper(request: Request, env: Env, user: AuthedUser, paperId: string): Promise<Response> {
  if (!PAPER_ID.test(paperId)) return errorJson("Paper not found", 404, "DISCOVERY_PAPER_NOT_FOUND");
  const paper = await getPaperForUser(env, paperId, user.userId);
  if (!paper) return errorJson("Paper not found", 404, "DISCOVERY_PAPER_NOT_FOUND");
  const rawProfile = parsedJson(paper.profile_json);
  const profile = rawProfile ? normalizePaperProfile(rawProfile) : null;
  let overview: string | null = null;
  if (paper.overview_object_key && paper.status === "profiled") {
    const object = await getDiscoveryObjectAtKey(env, paper.overview_object_key);
    if (object && object.size <= 256 * 1024) overview = (await object.text()).slice(0, 256 * 1024);
  }
  return json(publicPaper(paper, profile, overview));
}

async function listPapers(env: Env, user: AuthedUser): Promise<Response> {
  const rows = await listPapersForUser(env, user.userId);
  return json({ papers: rows.map((row) => publicPaper(row)).filter((row): row is Record<string, unknown> => Boolean(row)) });
}

async function deletePaper(env: Env, user: AuthedUser, paperId: string): Promise<Response> {
  const paper = await getPaperForUser(env, paperId, user.userId);
  if (!paper || paper.owner_user_id !== user.userId || paper.visibility !== "private") return errorJson("Paper not found", 404, "DISCOVERY_PAPER_NOT_FOUND");
  const now = nowSeconds();
  if (!(await markPaperDeletedForUser(env, paperId, user.userId, now))) return errorJson("Paper is already deleted", 409, "DISCOVERY_STATE_CONFLICT");
  const resource = await getPaperResourceForCatalogOwner(env, paper.source_resource_id, user.userId);
  if (resource) await deletePaperResource(env, { resourceId: resource.resource_id, sessionId: resource.session_id, userId: user.userId, now });
  await Promise.allSettled([
    deleteDiscoveryObjectAtKey(env, paper.profile_object_key),
    deleteDiscoveryObjectAtKey(env, paper.overview_object_key),
    deleteDiscoveryObject(env, "paper_profile", { resourceId: paper.source_resource_id }),
    deleteDiscoveryObject(env, "paper_overview", { resourceId: paper.source_resource_id }),
  ]);
  return json({ paper_id: paperId, status: "deleted" });
}

async function createDataCollection(request: Request, env: Env, user: AuthedUser): Promise<Response> {
  if (!env.RESOURCE_BUCKET) return errorJson("Data object storage is unavailable", 503, "DISCOVERY_STORAGE_UNAVAILABLE");
  const body = await boundedFormData(request, DISCOVERY_MAX_COLLECTION_BYTES);
  if (body instanceof Response) return body;
  const file = body.get("file");
  if (!isUploadedFile(file)) return errorJson("A data file or ZIP archive is required", 400, "DISCOVERY_COLLECTION_FILE_REQUIRED");
  const loaded = await readUpload(file, DISCOVERY_MAX_COLLECTION_BYTES);
  if (loaded instanceof Response) return loaded;
  const originalName = (file.name ?? "data.csv").replace(/\\/g, "/").split("/").pop() ?? "data.csv";
  if (!isZip(loaded.bytes) && !supportedDataExtension(originalName)) return errorJson("Only CSV, TSV, JSON, TXT, or ZIP uploads are supported", 422, "DISCOVERY_COLLECTION_FORMAT_UNSUPPORTED");
  const duplicate = await findCollectionBySha(env, user.userId, loaded.sha256);
  if (duplicate) return json({ ...publicCollection(duplicate), duplicate: true });
  const collectionId = crypto.randomUUID();
  const safeFilename = safeDiscoveryFilename(originalName, isZip(loaded.bytes) ? "data.zip" : "data.csv");
  const name = safeText(body.get("name"), originalName.slice(0, 255), 255);
  const contentType = contentTypeForData(file, originalName, loaded.bytes);
  try {
    if (!(await putDiscoveryObject(env, "dataset_source", { collectionId, filename: safeFilename }, loaded.bytes, contentType))) throw new Error("source object failed");
    if (!(await createCollection(env, {
      collection_id: collectionId,
      owner_user_id: user.userId,
      name,
      source_object_key: `datasets/${collectionId}/source/${safeFilename}`,
      source_filename: safeFilename,
      source_content_type: contentType,
      source_sha256: loaded.sha256,
      source_size_bytes: loaded.bytes.byteLength,
    }))) throw new Error("collection insert failed");
  } catch {
    await deleteDiscoveryObject(env, "dataset_source", { collectionId, filename: safeFilename });
    return errorJson("Data Collection could not be persisted", 503, "DISCOVERY_COLLECTION_PERSIST_FAILED");
  }
  const collection = await getCollectionForUser(env, collectionId, user.userId);
  return json({ ...publicCollection(collection), duplicate: false }, 201);
}

async function listCollections(env: Env, user: AuthedUser): Promise<Response> {
  const rows = await listCollectionsForUser(env, user.userId);
  return json({ collections: rows.map((row) => publicCollection(row)).filter((row): row is Record<string, unknown> => Boolean(row)) });
}

async function getCollection(request: Request, env: Env, user: AuthedUser, collectionId: string): Promise<Response> {
  if (!PAPER_ID.test(collectionId)) return errorJson("Data Collection not found", 404, "DISCOVERY_COLLECTION_NOT_FOUND");
  const collection = await getCollectionForUser(env, collectionId, user.userId);
  if (!collection) return errorJson("Data Collection not found", 404, "DISCOVERY_COLLECTION_NOT_FOUND");
  const rawProfile = parsedJson(collection.profile_json);
  const profile = rawProfile ? normalizeDatasetProfile(rawProfile, collection.collection_id) : null;
  return json(publicCollection(collection, profile));
}

async function deleteCollection(env: Env, user: AuthedUser, collectionId: string): Promise<Response> {
  const collection = await getCollectionForUser(env, collectionId, user.userId);
  if (!collection) return errorJson("Data Collection not found", 404, "DISCOVERY_COLLECTION_NOT_FOUND");
  const now = nowSeconds();
  if (await collectionHasActiveTask(env, collectionId, user.userId)) return errorJson("Data Collection is still referenced by an active task", 409, "DISCOVERY_COLLECTION_IN_USE");
  if (!(await markCollectionDeletedForUser(env, collectionId, user.userId, now))) {
    // The atomic UPDATE also checks for active references, covering a task
    // created after the read above but before deletion.
    if (await collectionHasActiveTask(env, collectionId, user.userId)) return errorJson("Data Collection is still referenced by an active task", 409, "DISCOVERY_COLLECTION_IN_USE");
    return errorJson("Data Collection is already deleted", 409, "DISCOVERY_STATE_CONFLICT");
  }
  await Promise.allSettled([
    deleteDiscoveryObject(env, "dataset_source", { collectionId, filename: collection.source_filename }),
    deleteDiscoveryObjectAtKey(env, collection.profile_object_key),
    deleteDiscoveryObject(env, "dataset_profile", { collectionId }),
  ]);
  return json({ collection_id: collectionId, status: "deleted" });
}

async function listMatches(env: Env, user: AuthedUser): Promise<Response> {
  return json({ matches: await listMatchesForUser(env, user.userId) });
}

async function getMatch(env: Env, user: AuthedUser, matchId: string): Promise<Response> {
  if (!PAPER_ID.test(matchId)) return errorJson("Research match not found", 404, "DISCOVERY_MATCH_NOT_FOUND");
  const match = await getMatchForUser(env, matchId, user.userId);
  return match ? json({ match }) : errorJson("Research match not found", 404, "DISCOVERY_MATCH_NOT_FOUND");
}

async function evaluateMatch(env: Env, user: AuthedUser, matchId: string): Promise<Response> {
  if (!PAPER_ID.test(matchId)) return errorJson("Research match not found", 404, "DISCOVERY_MATCH_NOT_FOUND");
  const match = await getMatchForUser(env, matchId, user.userId);
  if (!match) return errorJson("Research match not found", 404, "DISCOVERY_MATCH_NOT_FOUND");
  // Evaluation is performed by the dedicated Discovery Processor. This
  // browser endpoint is an idempotent request/ack surface; candidates are
  // already visible to the processor's server-controlled poll queue.
  const queued = match.status === "candidate" || match.status === "evaluating";
  const evaluation = parsedJson(match.evaluation_json);
  return json({ match_id: match.match_id, status: match.status, queued, evaluation });
}

async function createMatchTask(env: Env, user: AuthedUser, matchId: string): Promise<Response> {
  if (!PAPER_ID.test(matchId)) return errorJson("Research match not found", 404, "DISCOVERY_MATCH_NOT_FOUND");
  const match = await getMatchForUser(env, matchId, user.userId);
  if (!match) return errorJson("Research match not found", 404, "DISCOVERY_MATCH_NOT_FOUND");
  if (match.created_task_id) {
    const task = await env.DB.prepare(
      "SELECT task_id, status FROM tasks WHERE task_id = ?1 AND created_by = ?2",
    ).bind(match.created_task_id, user.userId).first<{ task_id: string; status: string }>();
    if (!task) return errorJson("Discovery task is not available", 409, "DISCOVERY_TASK_STATE_CONFLICT");
    return json({ match_id: match.match_id, task_id: task.task_id, status: "task_created", task_status: task.status, duplicate: true });
  }
  if (match.status !== "evaluated" || match.hard_gate !== "pass" || match.coverage_ratio < 0.6 || (match.execution_confidence ?? 0) < 60) {
    return errorJson("This match has not passed the execution threshold", 409, "DISCOVERY_TASK_THRESHOLD_NOT_MET");
  }
  const paper = await getPaperById(env, match.paper_id);
  const collection = await getCollectionById(env, match.collection_id);
  const paperProfile = paper?.profile_json ? normalizePaperProfile(parsedJson(paper.profile_json)) : null;
  const datasetProfile = collection?.profile_json ? normalizeDatasetProfile(parsedJson(collection.profile_json), collection.collection_id) : null;
  if (!paper || !collection || !paperProfile || !datasetProfile) return errorJson("Match inputs are no longer ready", 409, "DISCOVERY_MATCH_INPUT_NOT_READY");
  const created = await createDiscoveryTask(env, { match, paper, collection, paperProfile, datasetProfile });
  if (!created) return errorJson("Discovery task could not be queued; retry is available", 503, "DISCOVERY_TASK_CREATION_RETRYABLE");
  return json({ match_id: match.match_id, task_id: created.taskId, status: "task_created", duplicate: created.duplicate }, created.duplicate ? 200 : 201);
}

/** Authenticated browser API for Papers, Data Collections, and read-only matches. */
export async function handleDiscoveryApi(request: Request, env: Env, user: AuthedUser): Promise<Response | null> {
  const url = new URL(request.url);
  const paper = url.pathname.match(/^\/api\/discovery\/papers(?:\/([^/]+))?$/);
  if (paper) {
    const paperId = paper[1] ? decodeURIComponent(paper[1]) : null;
    if (!paperId && request.method === "POST") return createPaper(request, env, user);
    if (!paperId && request.method === "GET") return listPapers(env, user);
    if (paperId && request.method === "GET") return getPaper(request, env, user, paperId);
    if (paperId && request.method === "DELETE") return deletePaper(env, user, paperId);
    return errorJson("Method not allowed", 405, "METHOD_NOT_ALLOWED");
  }
  const collection = url.pathname.match(/^\/api\/discovery\/data-collections(?:\/([^/]+))?$/);
  if (collection) {
    const collectionId = collection[1] ? decodeURIComponent(collection[1]) : null;
    if (!collectionId && request.method === "POST") return createDataCollection(request, env, user);
    if (!collectionId && request.method === "GET") return listCollections(env, user);
    if (collectionId && request.method === "GET") return getCollection(request, env, user, collectionId);
    if (collectionId && request.method === "DELETE") return deleteCollection(env, user, collectionId);
    return errorJson("Method not allowed", 405, "METHOD_NOT_ALLOWED");
  }
  if (url.pathname === "/api/discovery/matches" && request.method === "GET") return listMatches(env, user);
  const match = url.pathname.match(/^\/api\/discovery\/matches\/([^/]+)$/);
  if (match && request.method === "GET") return getMatch(env, user, decodeURIComponent(match[1]));
  const matchAction = url.pathname.match(/^\/api\/discovery\/matches\/([^/]+)\/(evaluate|create-task)$/);
  if (matchAction && request.method === "POST") {
    const matchId = decodeURIComponent(matchAction[1]);
    return matchAction[2] === "evaluate" ? evaluateMatch(env, user, matchId) : createMatchTask(env, user, matchId);
  }
  if (url.pathname.startsWith("/api/discovery/")) return errorJson("Not found", 404, "NOT_FOUND");
  return null;
}
