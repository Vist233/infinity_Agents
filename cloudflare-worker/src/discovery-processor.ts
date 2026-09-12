import type { Env } from "./env";
import { errorJson, json, nowSeconds } from "./http";
import {
  addPaperCapabilities,
  claimNextDiscoveryWork,
  createDiscoveryProcessorSession,
  createResearchMatchIfMissing,
  getCollectionById,
  getMatchById,
  getPaperById,
  recoverExpiredDiscoveryLeases,
  renewDiscoveryLease,
  saveDatasetProfile,
  saveMatchEvaluation,
  savePaperProfile,
  failCollection,
  failPaperProfile,
  getDiscoveryProcessorSessionByToken,
  touchDiscoveryProcessorSession,
  type DiscoveryLeaseKind,
  type DataCollectionRow,
  type PaperCatalogRow,
  type ResearchMatchRow,
} from "./discovery-db";
import { getPaperProcessorObject } from "./db";
import {
  FEASIBILITY_EVALUATOR_VERSION,
  coarseMatch,
  normalizeDatasetProfile,
  normalizeFeasibilityEvaluation,
  normalizePaperProfile,
  paperEvidenceStatus,
  type DatasetProfile,
  type PaperProfile,
} from "./discovery-contracts";
import { getPaperObject, getPaperObjectAtKey } from "./paper-object-store";
import { deleteDiscoveryObject, deleteDiscoveryObjectAtKey, discoveryObjectKey, putDiscoveryObject } from "./discovery-object-store";
import { hashReadableStream, hashText, Sha256 } from "./sha256";
import { isApprovedDiscoveryProcessorRequest, isDiscoveryProcessorNamespacePath } from "./discovery-processor-access";
import { createDiscoveryTask } from "./discovery-task";

const PREFIX = "/api/discovery-processor";
const SESSION_TTL_SECONDS = 15 * 60;
const MAX_CONTROL_BYTES = 2 * 1024 * 1024;
const MAX_PROFILE_BYTES = 1_048_576;
const MAX_OVERVIEW_BYTES = 256 * 1024;
const MAX_COLLECTION_SOURCE_BYTES = 25 * 1024 * 1024;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/;
const ERROR_CODE = /^[A-Z0-9_]{1,64}$/;

type ControlOperation =
  | "input"
  | "input_source"
  | "renew"
  | "save_paper_profile"
  | "save_dataset_profile"
  | "create_match"
  | "save_evaluation"
  | "fail";

const CONTROL_FIELDS: Record<ControlOperation, ReadonlySet<string>> = {
  input: new Set(["operation", "kind", "work_id", "resource_id", "fencing_epoch"]),
  input_source: new Set(["operation", "kind", "work_id", "resource_id", "fencing_epoch"]),
  renew: new Set(["operation", "kind", "work_id", "resource_id", "fencing_epoch"]),
  save_paper_profile: new Set(["operation", "kind", "work_id", "resource_id", "fencing_epoch", "profile", "overview"]),
  save_dataset_profile: new Set(["operation", "kind", "work_id", "fencing_epoch", "profile"]),
  create_match: new Set(["operation", "paper_id", "collection_id", "paper_profile_version", "dataset_profile_version", "match_id"]),
  save_evaluation: new Set(["operation", "kind", "work_id", "fencing_epoch", "evaluation"]),
  fail: new Set(["operation", "kind", "work_id", "resource_id", "fencing_epoch", "error_code", "spam_status"]),
};

type SessionContext = { session: Awaited<ReturnType<typeof getDiscoveryProcessorSessionByToken>> extends infer T ? Exclude<T, null> : never; now: number };

function token(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `${prefix}_${btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")}`;
}

function validId(value: string): boolean {
  return ID_PATTERN.test(value);
}

function stringField(body: Record<string, unknown> | null, name: string): string {
  return typeof body?.[name] === "string" ? body[name]!.trim() : "";
}

function integerField(body: Record<string, unknown> | null, name: string): number | null {
  const value = body?.[name];
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

async function bodyJson(request: Request): Promise<Record<string, unknown> | null | Response> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isSafeInteger(declared) && declared > MAX_CONTROL_BYTES) return errorJson("Discovery Processor request is too large", 413, "DISCOVERY_PROCESSOR_BODY_TOO_LARGE");
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_CONTROL_BYTES) {
        await reader.cancel("discovery control body exceeds limit");
        return errorJson("Discovery Processor request is too large", 413, "DISCOVERY_PROCESSOR_BODY_TOO_LARGE");
      }
      chunks.push(next.value);
    }
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      (() => {
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        return bytes;
      })(),
    ));
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

function validateOperation(body: Record<string, unknown> | null): ControlOperation | Response {
  const operation = stringField(body, "operation") as ControlOperation;
  if (!body || !Object.prototype.hasOwnProperty.call(CONTROL_FIELDS, operation)) return errorJson("Discovery Processor operation is not allowed", 400, "DISCOVERY_PROCESSOR_OPERATION_NOT_ALLOWED");
  if (Object.keys(body).some((key) => !CONTROL_FIELDS[operation].has(key))) return errorJson("Discovery Processor operation fields are not allowed", 400, "DISCOVERY_PROCESSOR_FIELDS_FORBIDDEN");
  return operation;
}

function sessionHeaders(request: Request): string | null {
  const value = request.headers.get("x-discovery-processor-session")?.trim() ?? "";
  return value.length >= 16 && value.length <= 512 ? value : null;
}

async function authenticate(request: Request, env: Env): Promise<SessionContext | Response> {
  const sessionToken = sessionHeaders(request);
  if (!sessionToken) return errorJson("Discovery Processor session required", 401, "DISCOVERY_PROCESSOR_UNAUTHENTICATED");
  const now = nowSeconds();
  const session = await getDiscoveryProcessorSessionByToken(env, hashText(sessionToken), now);
  if (!session) return errorJson("Discovery Processor session is invalid or expired", 401, "DISCOVERY_PROCESSOR_SESSION_INVALID");
  if (!(await touchDiscoveryProcessorSession(env, session.processor_session_id, now, now + SESSION_TTL_SECONDS))) return errorJson("Discovery Processor session is no longer active", 401, "DISCOVERY_PROCESSOR_SESSION_INVALID");
  return { session, now };
}

async function connect(request: Request, env: Env): Promise<Response> {
  const processorId = request.headers.get("x-discovery-processor-id")?.trim() ?? "";
  const bootstrap = request.headers.get("x-discovery-processor-token")?.trim() ?? "";
  if (!env.DISCOVERY_PROCESSOR_ID || !env.DISCOVERY_PROCESSOR_SHARED_SECRET || processorId !== env.DISCOVERY_PROCESSOR_ID || bootstrap.length < 16 || hashText(bootstrap) !== hashText(env.DISCOVERY_PROCESSOR_SHARED_SECRET)) {
    return errorJson("Discovery Processor bootstrap authentication failed", 401, "DISCOVERY_PROCESSOR_UNAUTHENTICATED");
  }
  const body = await bodyJson(request);
  if (body instanceof Response) return body;
  if (!body) return errorJson("Discovery Processor connect body is invalid", 400, "INVALID_DISCOVERY_PROCESSOR_CONNECT");
  const instanceId = stringField(body, "instance_id");
  if (!validId(instanceId) || Object.keys(body).some((key) => key !== "instance_id")) return errorJson("Processor instance_id is invalid", 400, "INVALID_DISCOVERY_PROCESSOR_INSTANCE");
  const now = nowSeconds();
  const sessionId = token("dps");
  const sessionToken = token("session");
  await createDiscoveryProcessorSession(env, {
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

function workIdentity(body: Record<string, unknown> | null): { kind: DiscoveryLeaseKind; workId: string; resourceId: string | null; fencingEpoch: number } | Response {
  const kind = stringField(body, "kind") as DiscoveryLeaseKind;
  const workId = stringField(body, "work_id");
  const resourceId = body && Object.prototype.hasOwnProperty.call(body, "resource_id") ? stringField(body, "resource_id") : null;
  const fencingEpoch = integerField(body, "fencing_epoch");
  if (!(kind === "paper" || kind === "collection" || kind === "match") || !validId(workId) || (resourceId !== null && !validId(resourceId)) || fencingEpoch === null || fencingEpoch <= 0) return errorJson("Discovery Processor lease is invalid", 409, "DISCOVERY_PROCESSOR_LEASE_CONFLICT");
  return { kind, workId, resourceId, fencingEpoch };
}

type LeaseIdentity = { kind: DiscoveryLeaseKind; workId: string; resourceId: string | null; fencingEpoch: number };
type AuthorizedWork = { identity: LeaseIdentity; leaseTokenHash: string; paper?: PaperCatalogRow; collection?: DataCollectionRow; match?: ResearchMatchRow };

async function authorizeWork(request: Request, env: Env, context: SessionContext, body: Record<string, unknown>): Promise<AuthorizedWork | Response> {
  const identity = workIdentity(body);
  if (identity instanceof Response) return identity;
  const leaseToken = request.headers.get("x-discovery-processor-lease-token")?.trim() ?? "";
  if (leaseToken.length < 16 || leaseToken.length > 512) return errorJson("Discovery Processor lease token is invalid", 409, "DISCOVERY_PROCESSOR_LEASE_CONFLICT");
  const leaseTokenHash = hashText(leaseToken);
  const owner = context.session.processor_session_id;
  if (identity.kind === "paper") {
    const paper = await getPaperById(env, identity.workId);
    if (!paper || paper.status !== "processing" || paper.discovery_lease_owner !== owner || paper.discovery_lease_token_hash !== leaseTokenHash || paper.discovery_fencing_epoch !== identity.fencingEpoch || (paper.discovery_lease_expires_at ?? 0) <= context.now || paper.source_resource_id !== identity.resourceId) return errorJson("Discovery Processor lease is stale or mismatched", 409, "DISCOVERY_PROCESSOR_LEASE_CONFLICT");
    return { identity, leaseTokenHash, paper };
  }
  if (identity.kind === "collection") {
    const collection = await getCollectionById(env, identity.workId);
    if (!collection || collection.status !== "inspecting" || collection.discovery_lease_owner !== owner || collection.discovery_lease_token_hash !== leaseTokenHash || collection.discovery_fencing_epoch !== identity.fencingEpoch || (collection.discovery_lease_expires_at ?? 0) <= context.now) return errorJson("Discovery Processor lease is stale or mismatched", 409, "DISCOVERY_PROCESSOR_LEASE_CONFLICT");
    return { identity, leaseTokenHash, collection };
  }
  const match = await getMatchById(env, identity.workId);
  if (!match || match.status !== "evaluating" || match.discovery_lease_owner !== owner || match.discovery_lease_token_hash !== leaseTokenHash || match.discovery_fencing_epoch !== identity.fencingEpoch || (match.discovery_lease_expires_at ?? 0) <= context.now) return errorJson("Discovery Processor lease is stale or mismatched", 409, "DISCOVERY_PROCESSOR_LEASE_CONFLICT");
  return { identity, leaseTokenHash, match };
}

async function poll(request: Request, env: Env, context: SessionContext): Promise<Response> {
  const body = await bodyJson(request);
  if (body instanceof Response) return body;
  if (body && Object.keys(body).length > 0) return errorJson("Discovery work selection is server-controlled", 400, "DISCOVERY_PROCESSOR_SCOPE_FORBIDDEN");
  await recoverExpiredDiscoveryLeases(env, context.now);
  const leaseToken = token("lease");
  const work = await claimNextDiscoveryWork(env, context.session.processor_session_id, context.now, hashText(leaseToken));
  if (!work) return json({ resource: null });
  const common = { lease_token: leaseToken, fencing_epoch: work.fencing_epoch, lease_expires_at: work.lease_expires_at };
  // The token is generated after the D1 claim and must be persisted with the
  // claim. The protocol client passes it back as an opaque capability.
  // Reclaiming with a fresh token is not safe, so use a deterministic token
  // bound to this poll response only through the short-lived session owner.
  if (work.kind === "paper") return json({ ...common, kind: "paper", work_id: work.paper.paper_id, resource_id: work.resource_id, paper_id: work.paper.paper_id });
  if (work.kind === "collection") return json({ ...common, kind: "collection", work_id: work.collection.collection_id, collection_id: work.collection.collection_id });
  return json({ ...common, kind: "match", work_id: work.match.match_id, match_id: work.match.match_id });
}

async function input(request: Request, env: Env, context: SessionContext, body: Record<string, unknown>): Promise<Response> {
  const authorized = await authorizeWork(request, env, context, body);
  if (authorized instanceof Response) return authorized;
  if (authorized.paper) return json({ kind: "paper", paper_id: authorized.paper.paper_id, resource_id: authorized.paper.source_resource_id, title: authorized.paper.title, source_kind: "paper_resource", profile_version: authorized.paper.profile_version });
  if (authorized.collection) return json({ kind: "collection", collection_id: authorized.collection.collection_id, source_filename: authorized.collection.source_filename, source_content_type: authorized.collection.source_content_type, source_sha256: authorized.collection.source_sha256, source_size_bytes: authorized.collection.source_size_bytes });
  const match = authorized.match!;
  return json({ kind: "match", match_id: match.match_id, paper_id: match.paper_id, collection_id: match.collection_id, paper_profile_version: match.paper_profile_version, dataset_profile_version: match.dataset_profile_version, coverage_ratio: match.coverage_ratio });
}

async function inputSource(request: Request, env: Env, context: SessionContext, body: Record<string, unknown>): Promise<Response> {
  const authorized = await authorizeWork(request, env, context, body);
  if (authorized instanceof Response) return authorized;
  if (authorized.paper) {
    const recorded = await getPaperProcessorObject(env, { resourceId: authorized.paper.source_resource_id, kind: "text_pages", objectId: "pages" });
    const object = recorded?.object_key
      ? await getPaperObjectAtKey(env, recorded.object_key)
      : await getPaperObject(env, authorized.paper.source_resource_id, "text_pages");
    if (!object) return errorJson("Paper text pages are not available", 409, "DISCOVERY_PAPER_TEXT_MISSING");
    return new Response(object.body, { headers: { "cache-control": "no-store", "content-type": "application/json" } });
  }
  if (authorized.collection) {
    if (!env.RESOURCE_BUCKET) return errorJson("Dataset object storage is unavailable", 503, "DISCOVERY_STORAGE_UNAVAILABLE");
    const object = await env.RESOURCE_BUCKET.get(authorized.collection.source_object_key);
    if (!object) return errorJson("Dataset source is not available", 404, "DISCOVERY_DATASET_SOURCE_MISSING");
    return new Response(object.body, { headers: { "cache-control": "no-store", "content-type": authorized.collection.source_content_type } });
  }
  const match = authorized.match!;
  const paper = await getPaperById(env, match.paper_id);
  const collection = await getCollectionById(env, match.collection_id);
  if (!paper || !collection) return errorJson("Match inputs are not available", 409, "DISCOVERY_MATCH_INPUT_MISSING");
  return json({ paper_profile: JSON.parse(paper.profile_json ?? "null"), dataset_profile: JSON.parse(collection.profile_json ?? "null"), coverage_ratio: match.coverage_ratio });
}

async function renew(request: Request, env: Env, context: SessionContext, body: Record<string, unknown>): Promise<Response> {
  const authorized = await authorizeWork(request, env, context, body);
  if (authorized instanceof Response) return authorized;
  const identity = authorized.identity;
  const expiresAt = context.now + 5 * 60;
  const renewed = await renewDiscoveryLease(env, { kind: identity.kind, id: identity.workId, owner: context.session.processor_session_id, tokenHash: authorized.leaseTokenHash, fencingEpoch: identity.fencingEpoch, now: context.now, leaseExpiresAt: expiresAt });
  return renewed ? json({ work_id: identity.workId, lease_expires_at: expiresAt }) : errorJson("Discovery Processor lease is stale", 409, "DISCOVERY_PROCESSOR_LEASE_CONFLICT");
}

function profileJson(value: unknown, maximum: number): string | null {
  try {
    const serialized = JSON.stringify(value);
    return serialized && serialized.length <= maximum ? serialized : null;
  } catch {
    return null;
  }
}

async function deleteDiscoveryKeys(env: Env, keys: Array<string | null | undefined>): Promise<void> {
  const unique = [...new Set(keys.filter((key): key is string => Boolean(key)))];
  await Promise.allSettled(unique.map((key) => deleteDiscoveryObjectAtKey(env, key)));
}

async function savePaper(request: Request, env: Env, context: SessionContext, body: Record<string, unknown>): Promise<Response> {
  const profile = normalizePaperProfile(body.profile);
  if (!profile) return errorJson("Paper Profile does not match paper-profile-v1", 422, "DISCOVERY_PAPER_PROFILE_INVALID");
  const overview = typeof body.overview === "string" && body.overview.length <= MAX_OVERVIEW_BYTES ? body.overview : null;
  if (overview === null) return errorJson("Paper overview is invalid or too large", 422, "DISCOVERY_PAPER_OVERVIEW_INVALID");
  const serialized = profileJson(profile, MAX_PROFILE_BYTES);
  if (!serialized) return errorJson("Paper Profile is too large", 413, "DISCOVERY_PAPER_PROFILE_TOO_LARGE");
  const sha256 = new Sha256().update(new TextEncoder().encode(serialized)).digestHex();
  const authorized = await authorizeWork(request, env, context, body);
  if (authorized instanceof Response) {
    const identity = workIdentity(body);
    const paper = identity instanceof Response ? null : await getPaperById(env, identity.workId);
    if (paper?.status === "profiled" && paper.profile_version === profile.profile_version && paper.profile_sha256 === sha256) return json({ work_id: paper.paper_id, status: "profiled", idempotent: true });
    return authorized;
  }
  const paper = authorized.paper!;
  if (profile.provenance.source_resource_id !== paper.source_resource_id) return errorJson("Paper Profile provenance does not match the resource", 409, "DISCOVERY_PROFILE_PROVENANCE_MISMATCH");
  const evidenceStatus = paperEvidenceStatus(profile);
  if (evidenceStatus !== "scientific_paper") {
    const failed = await failPaperProfile(env, paper.paper_id, "review", context.now, { owner: context.session.processor_session_id, tokenHash: authorized.leaseTokenHash, fencingEpoch: authorized.identity.fencingEpoch });
    return failed
      ? errorJson("Paper Profile evidence requires human review", 422, "DISCOVERY_PAPER_EVIDENCE_REVIEW")
      : errorJson("Paper Profile lease is stale", 409, "DISCOVERY_PROCESSOR_LEASE_CONFLICT");
  }
  const objectInput = { resourceId: paper.source_resource_id, leaseOwner: context.session.processor_session_id, fencingEpoch: authorized.identity.fencingEpoch };
  const profileObjectKey = discoveryObjectKey("paper_profile", objectInput);
  const overviewObjectKey = discoveryObjectKey("paper_overview", objectInput);
  if (!profileObjectKey || !overviewObjectKey) return errorJson("Paper Profile storage key is invalid", 500, "DISCOVERY_STORAGE_UNAVAILABLE");
  try {
    if (!await putDiscoveryObject(env, "paper_profile", objectInput, new TextEncoder().encode(serialized), "application/json")) return errorJson("Paper Profile storage is unavailable", 503, "DISCOVERY_STORAGE_UNAVAILABLE");
    if (!await putDiscoveryObject(env, "paper_overview", objectInput, new TextEncoder().encode(overview), "text/markdown; charset=utf-8")) {
      await deleteDiscoveryKeys(env, [profileObjectKey]);
      return errorJson("Paper overview storage is unavailable", 503, "DISCOVERY_STORAGE_UNAVAILABLE");
    }
  } catch {
    await deleteDiscoveryKeys(env, [profileObjectKey, overviewObjectKey]);
    return errorJson("Paper Profile storage is unavailable", 503, "DISCOVERY_STORAGE_UNAVAILABLE");
  }
  let saved = false;
  try {
    saved = await savePaperProfile(env, { paperId: paper.paper_id, profileVersion: profile.profile_version, profileJson: serialized, profileSha256: sha256, profileObjectKey, overviewObjectKey, spamStatus: "scientific_paper", title: profile.paper.title, authorsJson: JSON.stringify(profile.paper.authors), year: profile.paper.year, venue: profile.paper.venue, leaseOwner: context.session.processor_session_id, leaseTokenHash: authorized.leaseTokenHash, fencingEpoch: authorized.identity.fencingEpoch, now: context.now });
  } catch {
    await deleteDiscoveryKeys(env, [profileObjectKey, overviewObjectKey]);
    return errorJson("Paper Profile could not be persisted", 503, "DISCOVERY_PROFILE_PERSIST_RETRYABLE");
  }
  if (!saved) {
    await deleteDiscoveryKeys(env, [profileObjectKey, overviewObjectKey]);
    return errorJson("Paper Profile lease is stale", 409, "DISCOVERY_PROCESSOR_LEASE_CONFLICT");
  }
  await deleteDiscoveryKeys(env, [
    paper.profile_object_key && paper.profile_object_key !== profileObjectKey ? paper.profile_object_key : null,
    paper.overview_object_key && paper.overview_object_key !== overviewObjectKey ? paper.overview_object_key : null,
  ]);
  await addPaperCapabilities(env, paper.paper_id, profile.analysis_modules.flatMap((module) => [
    ...module.required_capabilities.map((key) => ({ analysisId: module.analysis_id, key, requirement: "required" as const })),
    ...module.optional_capabilities.map((key) => ({ analysisId: module.analysis_id, key, requirement: "optional" as const })),
  ]), context.now);
  try {
    await createCandidatesForPaper(env, { ...paper, status: "profiled", profile_version: profile.profile_version, profile_json: serialized });
  } catch {
    // The profile commit is durable. The scheduled reconciliation pass retries
    // any candidate rows that could not be fanned out in this response.
  }
  return json({ work_id: paper.paper_id, status: "profiled", profile_version: profile.profile_version });
}

async function createCandidatesForPaper(env: Env, paperRow: PaperCatalogRow): Promise<void> {
  const paper = paperRow.profile_json ? normalizePaperProfile(JSON.parse(paperRow.profile_json)) : null;
  if (!paper || paperRow.status !== "profiled" || paperRow.spam_status !== "scientific_paper" || paperEvidenceStatus(paper) !== "scientific_paper") return;
  const collections = await env.DB.prepare("SELECT * FROM data_collections WHERE status = 'ready' ORDER BY created_at ASC LIMIT 512").all<DataCollectionRow>();
  for (const collection of collections.results ?? []) {
    if (paperRow.visibility !== "public" && collection.owner_user_id !== paperRow.owner_user_id) continue;
    let dataset: DatasetProfile | null = null;
    try { dataset = collection.profile_json ? normalizeDatasetProfile(JSON.parse(collection.profile_json), collection.collection_id) : null; } catch { dataset = null; }
    if (!dataset) continue;
    const coverage = coarseMatch(paper, dataset);
    await createResearchMatchIfMissing(env, {
      matchId: crypto.randomUUID(),
      paperId: paperRow.paper_id,
      collectionId: collection.collection_id,
      paperProfileVersion: paper.profile_version,
      datasetProfileVersion: dataset.profile_version,
      coverageRatio: coverage.coverage_ratio,
      candidateReason: coverage.candidate_reason,
      now: paperRow.updated_at,
    });
  }
}

/**
 * Revalidate the immutable dataset object at the point its profile is
 * committed. The processor receives the same metadata through `input`, but a
 * profile must not become authoritative unless Edge independently confirms
 * that the R2 bytes still match the D1 snapshot.
 */
async function validateCollectionSource(env: Env, collection: DataCollectionRow): Promise<Response | null> {
  if (!Number.isSafeInteger(collection.source_size_bytes) || collection.source_size_bytes <= 0
    || collection.source_size_bytes > MAX_COLLECTION_SOURCE_BYTES
    || !/^[0-9a-fA-F]{64}$/.test(collection.source_sha256)) {
    return errorJson("Dataset source integrity metadata is invalid", 409, "DISCOVERY_DATASET_SOURCE_INTEGRITY");
  }
  if (!env.RESOURCE_BUCKET) return errorJson("Dataset object storage is unavailable", 503, "DISCOVERY_STORAGE_UNAVAILABLE");
  let object: R2ObjectBody | null;
  try {
    object = await env.RESOURCE_BUCKET.get(collection.source_object_key);
  } catch {
    return errorJson("Dataset source could not be read", 503, "DISCOVERY_DATASET_SOURCE_UNAVAILABLE");
  }
  if (!object?.body) return errorJson("Dataset source is not available", 503, "DISCOVERY_DATASET_SOURCE_UNAVAILABLE");
  if (object.size !== collection.source_size_bytes) {
    return errorJson("Dataset source size does not match its frozen metadata", 409, "DISCOVERY_DATASET_SOURCE_INTEGRITY");
  }
  let measured: { size: number; sha256: string };
  try {
    measured = await hashReadableStream(object.body, MAX_COLLECTION_SOURCE_BYTES);
  } catch {
    return errorJson("Dataset source could not be validated", 503, "DISCOVERY_DATASET_SOURCE_UNAVAILABLE");
  }
  if (measured.size !== collection.source_size_bytes || measured.sha256.toLowerCase() !== collection.source_sha256.toLowerCase()) {
    return errorJson("Dataset source checksum does not match its frozen metadata", 409, "DISCOVERY_DATASET_SOURCE_INTEGRITY");
  }
  return null;
}

async function saveDataset(request: Request, env: Env, context: SessionContext, body: Record<string, unknown>): Promise<Response> {
  const identity = workIdentity(body);
  if (identity instanceof Response) return identity;
  const profile = normalizeDatasetProfile(body.profile, identity.workId);
  if (!profile) return errorJson("Dataset Profile does not match dataset-profile-v1", 422, "DISCOVERY_DATASET_PROFILE_INVALID");
  const serialized = profileJson(profile, MAX_PROFILE_BYTES);
  if (!serialized) return errorJson("Dataset Profile is too large", 413, "DISCOVERY_DATASET_PROFILE_TOO_LARGE");
  const sha256 = new Sha256().update(new TextEncoder().encode(serialized)).digestHex();
  const authorized = await authorizeWork(request, env, context, body);
  if (authorized instanceof Response) {
    const collection = await getCollectionById(env, identity.workId);
    if (collection?.status === "ready" && collection.profile_version === profile.profile_version && collection.profile_sha256 === sha256) return json({ work_id: collection.collection_id, status: "ready", idempotent: true });
    return authorized;
  }
  const sourceIntegrity = await validateCollectionSource(env, authorized.collection!);
  if (sourceIntegrity) return sourceIntegrity;
  const objectInput = { collectionId: identity.workId, leaseOwner: context.session.processor_session_id, fencingEpoch: identity.fencingEpoch };
  const profileObjectKey = discoveryObjectKey("dataset_profile", objectInput);
  if (!profileObjectKey) return errorJson("Dataset Profile storage key is invalid", 500, "DISCOVERY_STORAGE_UNAVAILABLE");
  try {
    if (!await putDiscoveryObject(env, "dataset_profile", objectInput, new TextEncoder().encode(serialized), "application/json")) return errorJson("Dataset Profile storage is unavailable", 503, "DISCOVERY_STORAGE_UNAVAILABLE");
  } catch {
    await deleteDiscoveryKeys(env, [profileObjectKey]);
    return errorJson("Dataset Profile storage is unavailable", 503, "DISCOVERY_STORAGE_UNAVAILABLE");
  }
  let saved = false;
  try {
    saved = await saveDatasetProfile(env, { collectionId: identity.workId, profileVersion: profile.profile_version, profileJson: serialized, profileSha256: sha256, profileObjectKey, leaseOwner: context.session.processor_session_id, leaseTokenHash: authorized.leaseTokenHash, fencingEpoch: identity.fencingEpoch, now: context.now });
  } catch {
    await deleteDiscoveryKeys(env, [profileObjectKey]);
    return errorJson("Dataset Profile could not be persisted", 503, "DISCOVERY_PROFILE_PERSIST_RETRYABLE");
  }
  if (!saved) {
    await deleteDiscoveryKeys(env, [profileObjectKey]);
    return errorJson("Dataset Profile lease is stale", 409, "DISCOVERY_PROCESSOR_LEASE_CONFLICT");
  }
  await deleteDiscoveryKeys(env, [
    authorized.collection?.profile_object_key && authorized.collection.profile_object_key !== profileObjectKey
      ? authorized.collection.profile_object_key
      : null,
  ]);
  try {
    await createCandidatesForCollection(env, { ...authorized.collection!, status: "ready", profile_version: profile.profile_version, profile_json: serialized });
  } catch {
    // Candidate fan-out is intentionally best effort; reconciliation below is
    // the durable retry path for a transient D1 failure.
  }
  return json({ work_id: identity.workId, status: "ready", profile_version: profile.profile_version });
}

async function createCandidatesForCollection(env: Env, collectionRow: DataCollectionRow): Promise<void> {
  const dataset = collectionRow.profile_json ? normalizeDatasetProfile(JSON.parse(collectionRow.profile_json), collectionRow.collection_id) : null;
  if (!dataset || collectionRow.status !== "ready") return;
  const papers = await env.DB.prepare("SELECT * FROM paper_catalog WHERE status = 'profiled' ORDER BY created_at ASC LIMIT 512").all<PaperCatalogRow>();
  for (const paperRow of papers.results ?? []) {
    if (paperRow.spam_status !== "scientific_paper") continue;
    if (paperRow.visibility !== "public" && paperRow.owner_user_id !== collectionRow.owner_user_id) continue;
    let paper: PaperProfile | null = null;
    try { paper = paperRow.profile_json ? normalizePaperProfile(JSON.parse(paperRow.profile_json)) : null; } catch { paper = null; }
    if (!paper) continue;
    const coverage = coarseMatch(paper, dataset);
    await createResearchMatchIfMissing(env, {
      matchId: crypto.randomUUID(),
      paperId: paperRow.paper_id,
      collectionId: collectionRow.collection_id,
      paperProfileVersion: paper.profile_version,
      datasetProfileVersion: dataset.profile_version,
      coverageRatio: coverage.coverage_ratio,
      candidateReason: coverage.candidate_reason,
      now: collectionRow.updated_at,
    });
  }
}

/** Reconcile candidate fan-out after a processor response or D1 write failed. */
export async function reconcileDiscoveryCandidates(env: Env, limit = 16): Promise<void> {
  const page = Math.min(32, Math.max(1, limit));
  const papers = await env.DB.prepare(
    `SELECT p.* FROM paper_catalog p
      WHERE p.status = 'profiled' AND p.spam_status = 'scientific_paper' AND EXISTS (
        SELECT 1 FROM data_collections c
         WHERE c.status = 'ready'
           AND (p.visibility = 'public' OR c.owner_user_id = p.owner_user_id)
           AND NOT EXISTS (
             SELECT 1 FROM research_matches m
              WHERE m.paper_id = p.paper_id AND m.collection_id = c.collection_id
                AND m.paper_profile_version = p.profile_version
                AND m.dataset_profile_version = c.profile_version
           )
      ) ORDER BY p.updated_at ASC, p.paper_id ASC LIMIT ?1`,
  ).bind(page).all<PaperCatalogRow>();
  for (const paper of papers.results ?? []) {
    try { await createCandidatesForPaper(env, paper); } catch { /* retry next schedule */ }
  }
  const collections = await env.DB.prepare(
    `SELECT c.* FROM data_collections c
      WHERE c.status = 'ready' AND EXISTS (
        SELECT 1 FROM paper_catalog p
         WHERE p.status = 'profiled' AND p.spam_status = 'scientific_paper'
           AND (p.visibility = 'public' OR p.owner_user_id = c.owner_user_id)
           AND NOT EXISTS (
             SELECT 1 FROM research_matches m
              WHERE m.paper_id = p.paper_id AND m.collection_id = c.collection_id
                AND m.paper_profile_version = p.profile_version
                AND m.dataset_profile_version = c.profile_version
           )
      ) ORDER BY c.updated_at ASC, c.collection_id ASC LIMIT ?1`,
  ).bind(page).all<DataCollectionRow>();
  for (const collection of collections.results ?? []) {
    try { await createCandidatesForCollection(env, collection); } catch { /* retry next schedule */ }
  }
}

async function createMatch(request: Request, env: Env, _context: SessionContext, body: Record<string, unknown>): Promise<Response> {
  const paperId = stringField(body, "paper_id");
  const collectionId = stringField(body, "collection_id");
  const paperVersion = stringField(body, "paper_profile_version");
  const datasetVersion = stringField(body, "dataset_profile_version");
  const matchId = stringField(body, "match_id") || crypto.randomUUID();
  if (!validId(paperId) || !validId(collectionId) || !paperVersion || !datasetVersion || !validId(matchId)) return errorJson("Match input is invalid", 400, "DISCOVERY_MATCH_INPUT_INVALID");
  const paperRow = await getPaperById(env, paperId);
  const collectionRow = await getCollectionById(env, collectionId);
  const paper = paperRow?.profile_json ? normalizePaperProfile(JSON.parse(paperRow.profile_json)) : null;
  const dataset = collectionRow?.profile_json ? normalizeDatasetProfile(JSON.parse(collectionRow.profile_json), collectionId) : null;
  if (!paperRow || !collectionRow || !paper || !dataset || paperRow.status !== "profiled" || paperRow.spam_status !== "scientific_paper" || paperEvidenceStatus(paper) !== "scientific_paper" || collectionRow.status !== "ready" || paper.profile_version !== paperVersion || dataset.profile_version !== datasetVersion) return errorJson("Match inputs are not ready", 409, "DISCOVERY_MATCH_INPUT_NOT_READY");
  const coverage = coarseMatch(paper, dataset);
  const match = await createResearchMatchIfMissing(env, { matchId, paperId, collectionId, paperProfileVersion: paperVersion, datasetProfileVersion: datasetVersion, coverageRatio: coverage.coverage_ratio, candidateReason: coverage.candidate_reason });
  return match ? json({ match, coverage }) : errorJson("Match could not be persisted", 503, "DISCOVERY_MATCH_PERSIST_FAILED");
}

async function saveEvaluation(request: Request, env: Env, context: SessionContext, body: Record<string, unknown>): Promise<Response> {
  const identity = workIdentity(body);
  if (identity instanceof Response || identity.kind !== "match") return identity instanceof Response ? identity : errorJson("Evaluation work kind is invalid", 409, "DISCOVERY_PROCESSOR_LEASE_CONFLICT");
  const normalized = normalizeFeasibilityEvaluation(body.evaluation);
  if (!normalized) return errorJson("Evaluation does not match feasibility-v1", 422, "DISCOVERY_EVALUATION_INVALID");
  const serialized = profileJson(normalized, 524_288);
  if (!serialized) return errorJson("Evaluation is too large", 413, "DISCOVERY_EVALUATION_TOO_LARGE");
  const thresholdPassed = normalized.hard_gate === "pass"
    && normalized.coverage.ratio >= 0.6
    && normalized.execution_confidence >= 60;
  const expectedStatus = thresholdPassed ? "evaluated" : normalized.hard_gate === "fail" ? "rejected" : "review";
  const authorized = await authorizeWork(request, env, context, body);
  if (authorized instanceof Response) {
    // A processor can finish the D1 update and lose the HTTP response before
    // it retries. The successful write clears the lease, so recognize only an
    // exact, already-committed evaluation as an idempotent retry.
    const existing = await getMatchById(env, identity.workId);
    if (existing && existing.evaluation_json === serialized && existing.evaluator_version === FEASIBILITY_EVALUATOR_VERSION
      && existing.hard_gate === normalized.hard_gate && existing.status === expectedStatus) {
      return json({ match_id: existing.match_id, status: existing.status, would_create_task: existing.status === "evaluated", task_created: existing.created_task_id != null, ...(existing.created_task_id ? { task_id: existing.created_task_id } : {}), idempotent: true });
    }
    return authorized;
  }
  const match = authorized.match!;
  const paperRow = await getPaperById(env, match.paper_id);
  const collectionRow = await getCollectionById(env, match.collection_id);
  let serverPaperProfile: PaperProfile | null = null;
  let serverDatasetProfile: DatasetProfile | null = null;
  try {
    serverPaperProfile = paperRow?.status === "profiled" && paperRow.profile_json ? normalizePaperProfile(JSON.parse(paperRow.profile_json)) : null;
    serverDatasetProfile = collectionRow?.status === "ready" && collectionRow.profile_json ? normalizeDatasetProfile(JSON.parse(collectionRow.profile_json), collectionRow.collection_id) : null;
  } catch {
    serverPaperProfile = null;
    serverDatasetProfile = null;
  }
  if (!paperRow || !collectionRow || !serverPaperProfile || !serverDatasetProfile
    || serverPaperProfile.profile_version !== match.paper_profile_version
    || serverDatasetProfile.profile_version !== match.dataset_profile_version) {
    return errorJson("Match inputs are not ready", 409, "DISCOVERY_MATCH_INPUT_NOT_READY");
  }
  const coarse = coarseMatch(serverPaperProfile, serverDatasetProfile);
  const coverageMatches = normalized.coverage.supported_modules === coarse.supported_modules
    && normalized.coverage.total_modules === coarse.total_modules
    && Math.abs(normalized.coverage.ratio - coarse.coverage_ratio) <= 0.000001
    && Math.abs(match.coverage_ratio - coarse.coverage_ratio) <= 0.000001;
  if (!coverageMatches || (normalized.hard_gate === "pass" && coarse.missing_required.length > 0) || normalized.coverage.ratio < 0.6 && normalized.hard_gate === "pass") {
    return errorJson("Evaluation coverage does not match the server candidate", 409, "DISCOVERY_EVALUATION_COVERAGE_MISMATCH");
  }
  const status = expectedStatus;
  const objectInput = { matchId: match.match_id, leaseOwner: context.session.processor_session_id, fencingEpoch: authorized.identity.fencingEpoch };
  const evaluationObjectKey = discoveryObjectKey("evaluation", objectInput);
  if (!evaluationObjectKey) return errorJson("Evaluation storage key is invalid", 500, "DISCOVERY_STORAGE_UNAVAILABLE");
  try {
    if (!await putDiscoveryObject(env, "evaluation", objectInput, new TextEncoder().encode(serialized), "application/json")) return errorJson("Evaluation storage is unavailable", 503, "DISCOVERY_STORAGE_UNAVAILABLE");
  } catch {
    await deleteDiscoveryKeys(env, [evaluationObjectKey]);
    return errorJson("Evaluation storage is unavailable", 503, "DISCOVERY_STORAGE_UNAVAILABLE");
  }
  let saved = false;
  try {
    saved = await saveMatchEvaluation(env, { matchId: match.match_id, hardGate: normalized.hard_gate, coverageRatio: normalized.coverage.ratio, executionConfidence: normalized.execution_confidence, scientificFit: normalized.scientific_fit, evaluatorVersion: FEASIBILITY_EVALUATOR_VERSION, evaluationJson: serialized, evaluationObjectKey, status, leaseOwner: context.session.processor_session_id, leaseTokenHash: authorized.leaseTokenHash, fencingEpoch: authorized.identity.fencingEpoch, now: context.now });
  } catch {
    await deleteDiscoveryKeys(env, [evaluationObjectKey]);
    return errorJson("Evaluation could not be persisted", 503, "DISCOVERY_EVALUATION_PERSIST_RETRYABLE");
  }
  if (!saved) {
    await deleteDiscoveryKeys(env, [evaluationObjectKey]);
    return errorJson("Evaluation lease is stale", 409, "DISCOVERY_PROCESSOR_LEASE_CONFLICT");
  }
  await deleteDiscoveryKeys(env, [
    match.evaluation_object_key && match.evaluation_object_key !== evaluationObjectKey
      ? match.evaluation_object_key
      : null,
  ]);
  const autoExecute = String(env.DISCOVERY_AUTO_EXECUTE ?? "").trim().toLowerCase() === "true";
  let taskCreated: { taskId: string; duplicate: boolean } | null = null;
  if (autoExecute && thresholdPassed) {
    try {
      const paper = await getPaperById(env, match.paper_id);
      const collection = await getCollectionById(env, match.collection_id);
      const paperProfile = paper?.profile_json ? normalizePaperProfile(JSON.parse(paper.profile_json)) : null;
      const datasetProfile = collection?.profile_json ? normalizeDatasetProfile(JSON.parse(collection.profile_json), collection.collection_id) : null;
      if (paper && collection && paperProfile && datasetProfile) {
        const created = await createDiscoveryTask(env, {
          match: { ...match, status: "evaluated", hard_gate: normalized.hard_gate, coverage_ratio: normalized.coverage.ratio, execution_confidence: normalized.execution_confidence, scientific_fit: normalized.scientific_fit, evaluator_version: FEASIBILITY_EVALUATOR_VERSION, evaluation_json: serialized, updated_at: context.now },
          paper,
          collection,
          paperProfile,
          datasetProfile,
          now: context.now,
        });
        if (created) taskCreated = { taskId: created.taskId, duplicate: created.duplicate };
      }
    } catch {
      // Evaluation remains durable and the scheduled retry path can materialize
      // the task without re-running the evaluator.
    }
  }
  return json({ match_id: match.match_id, status, would_create_task: thresholdPassed, auto_execute_enabled: autoExecute, task_created: Boolean(taskCreated), ...(taskCreated ? { task_id: taskCreated.taskId, duplicate: taskCreated.duplicate } : { task_creation_retryable: thresholdPassed && autoExecute }) });
}

async function fail(request: Request, env: Env, context: SessionContext, body: Record<string, unknown>): Promise<Response> {
  const code = stringField(body, "error_code");
  if (!ERROR_CODE.test(code)) return errorJson("Discovery Processor error code is invalid", 400, "INVALID_DISCOVERY_PROCESSOR_ERROR");
  const authorized = await authorizeWork(request, env, context, body);
  if (authorized instanceof Response) return authorized;
  if (authorized.paper) {
    const spam = stringField(body, "spam_status") as "invalid" | "non_paper" | "spam" | "review";
    const allowed = spam === "invalid" || spam === "non_paper" || spam === "spam" || spam === "review" ? spam : "review";
    return await failPaperProfile(env, authorized.paper.paper_id, allowed, context.now, { owner: context.session.processor_session_id, tokenHash: authorized.leaseTokenHash, fencingEpoch: authorized.identity.fencingEpoch }) ? json({ work_id: authorized.paper.paper_id, status: "failed", spam_status: allowed }) : errorJson("Discovery Processor failure lease is stale", 409, "DISCOVERY_PROCESSOR_LEASE_CONFLICT");
  }
  if (authorized.collection) return await failCollection(env, authorized.collection.collection_id, code, "Dataset inspection failed", context.now, { owner: context.session.processor_session_id, tokenHash: authorized.leaseTokenHash, fencingEpoch: authorized.identity.fencingEpoch }) ? json({ work_id: authorized.collection.collection_id, status: "failed" }) : errorJson("Discovery Processor failure lease is stale", 409, "DISCOVERY_PROCESSOR_LEASE_CONFLICT");
  return errorJson("Match evaluation failed; retry is available", 422, code);
}

async function control(request: Request, env: Env, context: SessionContext): Promise<Response> {
  const body = await bodyJson(request);
  if (body instanceof Response) return body;
  const operation = validateOperation(body);
  if (operation instanceof Response) return operation;
  if (!body) return errorJson("Discovery Processor JSON body is invalid", 400, "BAD_JSON");
  switch (operation) {
    case "input": return input(request, env, context, body);
    case "input_source": return inputSource(request, env, context, body);
    case "renew": return renew(request, env, context, body);
    case "save_paper_profile": return savePaper(request, env, context, body);
    case "save_dataset_profile": return saveDataset(request, env, context, body);
    case "create_match": return createMatch(request, env, context, body);
    case "save_evaluation": return saveEvaluation(request, env, context, body);
    case "fail": return fail(request, env, context, body);
  }
}

export async function handleDiscoveryProcessorApi(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (!isDiscoveryProcessorNamespacePath(url.pathname)) return null;
  if (!isApprovedDiscoveryProcessorRequest(request)) return errorJson("Discovery Processor route is not approved", 403, "DISCOVERY_PROCESSOR_ROUTE_FORBIDDEN");
  if (url.pathname === `${PREFIX}/connect`) {
    if (request.method !== "POST") return errorJson("Method not allowed", 405, "METHOD_NOT_ALLOWED");
    return connect(request, env);
  }
  const context = await authenticate(request, env);
  if (context instanceof Response) return context;
  if (url.pathname === `${PREFIX}/poll` && request.method === "POST") return poll(request, env, context);
  if (url.pathname === `${PREFIX}/control` && request.method === "POST") return control(request, env, context);
  return errorJson("Not found", 404, "NOT_FOUND");
}
