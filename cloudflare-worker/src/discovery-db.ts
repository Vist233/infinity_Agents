import type { Env } from "./env";
import { nowSeconds } from "./http";
import type { HardGate, MatchStatus, PaperCatalogStatus, SpamStatus, CollectionStatus } from "./discovery-contracts";

export interface PaperCatalogRow {
  paper_id: string;
  owner_user_id: string | null;
  source_resource_id: string;
  visibility: "private" | "public";
  title: string;
  authors_json: string;
  year: number | null;
  venue: string | null;
  status: PaperCatalogStatus;
  spam_status: SpamStatus;
  profile_version: string | null;
  profile_json: string | null;
  profile_sha256: string | null;
  overview_object_key: string | null;
  created_at: number;
  updated_at: number;
}

export interface DataCollectionRow {
  collection_id: string;
  owner_user_id: string;
  name: string;
  source_object_key: string;
  source_filename: string;
  source_content_type: string;
  source_sha256: string;
  source_size_bytes: number;
  status: CollectionStatus;
  profile_version: string | null;
  profile_json: string | null;
  profile_sha256: string | null;
  error_code: string | null;
  error_message_safe: string | null;
  created_at: number;
  updated_at: number;
}

export interface ResearchMatchRow {
  match_id: string;
  paper_id: string;
  collection_id: string;
  paper_profile_version: string;
  dataset_profile_version: string;
  status: MatchStatus;
  hard_gate: HardGate;
  coverage_ratio: number;
  execution_confidence: number | null;
  scientific_fit: number | null;
  evaluator_version: string | null;
  evaluation_json: string | null;
  created_task_id: string | null;
  candidate_reason: string | null;
  created_at: number;
  updated_at: number;
}

export interface DiscoveryProcessorSessionRow {
  processor_session_id: string;
  processor_id: string;
  instance_id: string;
  session_token_hash: string;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  revoked_at: number | null;
}

export type DiscoveryWork =
  | { kind: "paper"; paper: PaperCatalogRow; resource_id: string }
  | { kind: "collection"; collection: DataCollectionRow }
  | { kind: "match"; match: ResearchMatchRow };

function changed(result: { meta?: { changes?: number } }): boolean {
  return Number(result.meta?.changes ?? 0) === 1;
}

export async function listPapersForUser(env: Env, userId: string, limit = 100): Promise<PaperCatalogRow[]> {
  const result = await env.DB.prepare(
    `SELECT * FROM paper_catalog
      WHERE status <> 'deleted' AND (owner_user_id = ?1 OR visibility = 'public')
      ORDER BY updated_at DESC, paper_id ASC LIMIT ?2`,
  ).bind(userId, Math.min(100, Math.max(1, limit))).all<PaperCatalogRow>();
  return result.results ?? [];
}

export async function getPaperForUser(env: Env, paperId: string, userId: string): Promise<PaperCatalogRow | null> {
  return env.DB.prepare(
    `SELECT * FROM paper_catalog
      WHERE paper_id = ?1 AND status <> 'deleted'
        AND (owner_user_id = ?2 OR visibility = 'public')`,
  ).bind(paperId, userId).first<PaperCatalogRow>();
}

export async function getPaperById(env: Env, paperId: string): Promise<PaperCatalogRow | null> {
  return env.DB.prepare("SELECT * FROM paper_catalog WHERE paper_id = ?1").bind(paperId).first<PaperCatalogRow>();
}

export async function getPaperResourceForCatalogOwner(env: Env, resourceId: string, userId: string): Promise<{ resource_id: string; session_id: string } | null> {
  return env.DB.prepare(
    "SELECT resource_id, session_id FROM paper_resources WHERE resource_id = ?1 AND user_id = ?2",
  ).bind(resourceId, userId).first<{ resource_id: string; session_id: string }>();
}

export async function markPaperDeletedForUser(env: Env, paperId: string, userId: string, now = nowSeconds()): Promise<boolean> {
  return changed(await env.DB.prepare(
    "UPDATE paper_catalog SET status = 'deleted', updated_at = ?3 WHERE paper_id = ?1 AND owner_user_id = ?2 AND visibility = 'private' AND status <> 'deleted'",
  ).bind(paperId, userId, now).run());
}

export async function findPaperByOwnerSha(env: Env, userId: string, sha256: string): Promise<PaperCatalogRow | null> {
  return env.DB.prepare(
    `SELECT p.* FROM paper_catalog p
      JOIN paper_resources r ON r.resource_id = p.source_resource_id
     WHERE p.owner_user_id = ?1 AND r.source_sha256 = ?2 AND p.status <> 'deleted'
     ORDER BY p.updated_at DESC LIMIT 1`,
  ).bind(userId, sha256).first<PaperCatalogRow>();
}

export async function createPaperCatalog(
  env: Env,
  input: { paperId: string; ownerUserId: string | null; resourceId: string; visibility: "private" | "public"; title: string; authorsJson?: string; year?: number | null; venue?: string | null; status?: PaperCatalogStatus; now?: number },
): Promise<boolean> {
  const now = input.now ?? nowSeconds();
  const result = await env.DB.prepare(
    `INSERT INTO paper_catalog
      (paper_id, owner_user_id, source_resource_id, visibility, title, authors_json,
       year, venue, status, spam_status, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'pending', ?10, ?10)`,
  ).bind(input.paperId, input.ownerUserId, input.resourceId, input.visibility, input.title, input.authorsJson ?? "[]", input.year ?? null, input.venue ?? null, input.status ?? "requested", now).run();
  return changed(result);
}

export async function updatePaperProcessing(env: Env, paperId: string, input: { status: PaperCatalogStatus; spamStatus?: SpamStatus; title?: string; now?: number }): Promise<boolean> {
  const now = input.now ?? nowSeconds();
  const result = await env.DB.prepare(
    `UPDATE paper_catalog SET status = ?2,
       spam_status = COALESCE(?3, spam_status), title = COALESCE(?4, title), updated_at = ?5
     WHERE paper_id = ?1 AND status IN ('requested', 'processing', 'failed')`,
  ).bind(paperId, input.status, input.spamStatus ?? null, input.title ?? null, now).run();
  return changed(result);
}

export async function savePaperProfile(
  env: Env,
  input: { paperId: string; profileVersion: string; profileJson: string; profileSha256: string; overviewObjectKey: string; spamStatus: SpamStatus; title: string; authorsJson: string; year: number | null; venue: string | null; now?: number },
): Promise<boolean> {
  const now = input.now ?? nowSeconds();
  const result = await env.DB.prepare(
    `UPDATE paper_catalog SET status = 'profiled', spam_status = ?2, profile_version = ?3,
       profile_json = ?4, profile_sha256 = ?5, overview_object_key = ?6, title = ?7,
       authors_json = ?8, year = ?9, venue = ?10, updated_at = ?11
     WHERE paper_id = ?1 AND status = 'processing'`,
  ).bind(input.paperId, input.spamStatus, input.profileVersion, input.profileJson, input.profileSha256, input.overviewObjectKey, input.title, input.authorsJson, input.year, input.venue, now).run();
  return changed(result);
}

export async function failPaperProfile(env: Env, paperId: string, spamStatus: SpamStatus, now = nowSeconds()): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE paper_catalog SET status = 'failed', spam_status = ?2, updated_at = ?3
      WHERE paper_id = ?1 AND status IN ('requested', 'processing')`,
  ).bind(paperId, spamStatus, now).run();
  return changed(result);
}

export async function addPaperCapabilities(env: Env, paperId: string, capabilities: Array<{ analysisId: string; key: string; requirement: "required" | "optional" }>, now = nowSeconds()): Promise<void> {
  if (capabilities.length === 0) return;
  await env.DB.batch(capabilities.slice(0, 512).map((capability) => env.DB.prepare(
    `INSERT OR IGNORE INTO paper_capabilities (paper_id, analysis_id, capability_key, requirement, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5)`,
  ).bind(paperId, capability.analysisId, capability.key, capability.requirement, now)));
}

export async function listCollectionsForUser(env: Env, userId: string, limit = 100): Promise<DataCollectionRow[]> {
  const result = await env.DB.prepare(
    `SELECT * FROM data_collections WHERE owner_user_id = ?1 AND status <> 'deleted'
      ORDER BY updated_at DESC, collection_id ASC LIMIT ?2`,
  ).bind(userId, Math.min(100, Math.max(1, limit))).all<DataCollectionRow>();
  return result.results ?? [];
}

export async function getCollectionForUser(env: Env, collectionId: string, userId: string): Promise<DataCollectionRow | null> {
  return env.DB.prepare("SELECT * FROM data_collections WHERE collection_id = ?1 AND owner_user_id = ?2 AND status <> 'deleted'").bind(collectionId, userId).first<DataCollectionRow>();
}

export async function markCollectionDeletedForUser(env: Env, collectionId: string, userId: string, now = nowSeconds()): Promise<boolean> {
  return changed(await env.DB.prepare(
    "UPDATE data_collections SET status = 'deleted', updated_at = ?3 WHERE collection_id = ?1 AND owner_user_id = ?2 AND status <> 'deleted'",
  ).bind(collectionId, userId, now).run());
}

export async function findCollectionBySha(env: Env, userId: string, sha256: string): Promise<DataCollectionRow | null> {
  return env.DB.prepare("SELECT * FROM data_collections WHERE owner_user_id = ?1 AND source_sha256 = ?2 AND status <> 'deleted' ORDER BY updated_at DESC LIMIT 1").bind(userId, sha256).first<DataCollectionRow>();
}

export async function createCollection(env: Env, input: Omit<DataCollectionRow, "status" | "profile_version" | "profile_json" | "profile_sha256" | "error_code" | "error_message_safe" | "created_at" | "updated_at"> & { now?: number }): Promise<boolean> {
  const now = input.now ?? nowSeconds();
  const result = await env.DB.prepare(
    `INSERT INTO data_collections
       (collection_id, owner_user_id, name, source_object_key, source_filename,
        source_content_type, source_sha256, source_size_bytes, status, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'uploaded', ?9, ?9)`,
  ).bind(input.collection_id, input.owner_user_id, input.name, input.source_object_key, input.source_filename, input.source_content_type, input.source_sha256, input.source_size_bytes, now).run();
  return changed(result);
}

export async function claimCollectionForInspection(env: Env, collectionId: string, now = nowSeconds()): Promise<boolean> {
  return changed(await env.DB.prepare("UPDATE data_collections SET status = 'inspecting', updated_at = ?2 WHERE collection_id = ?1 AND status = 'uploaded'").bind(collectionId, now).run());
}

export async function saveDatasetProfile(env: Env, input: { collectionId: string; profileVersion: string; profileJson: string; profileSha256: string; now?: number }): Promise<boolean> {
  const now = input.now ?? nowSeconds();
  return changed(await env.DB.prepare(
    `UPDATE data_collections SET status = 'ready', profile_version = ?2, profile_json = ?3,
       profile_sha256 = ?4, error_code = NULL, error_message_safe = NULL, updated_at = ?5
     WHERE collection_id = ?1 AND status = 'inspecting'`,
  ).bind(input.collectionId, input.profileVersion, input.profileJson, input.profileSha256, now).run());
}

export async function failCollection(env: Env, collectionId: string, errorCode: string, message: string, now = nowSeconds()): Promise<boolean> {
  return changed(await env.DB.prepare(
    `UPDATE data_collections SET status = 'failed', error_code = ?2, error_message_safe = ?3, updated_at = ?4
      WHERE collection_id = ?1 AND status IN ('uploaded', 'inspecting')`,
  ).bind(collectionId, errorCode, message.slice(0, 1024), now).run());
}

export async function createResearchMatchIfMissing(env: Env, input: { matchId: string; paperId: string; collectionId: string; paperProfileVersion: string; datasetProfileVersion: string; coverageRatio: number; candidateReason: string; now?: number }): Promise<ResearchMatchRow | null> {
  const now = input.now ?? nowSeconds();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO research_matches
      (match_id, paper_id, collection_id, paper_profile_version, dataset_profile_version,
       status, hard_gate, coverage_ratio, candidate_reason, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 'candidate', 'pending', ?6, ?7, ?8, ?8)`,
  ).bind(input.matchId, input.paperId, input.collectionId, input.paperProfileVersion, input.datasetProfileVersion, input.coverageRatio, input.candidateReason, now).run();
  return env.DB.prepare("SELECT * FROM research_matches WHERE paper_id = ?1 AND collection_id = ?2 AND paper_profile_version = ?3 AND dataset_profile_version = ?4").bind(input.paperId, input.collectionId, input.paperProfileVersion, input.datasetProfileVersion).first<ResearchMatchRow>();
}

export async function listMatchesForUser(env: Env, userId: string, limit = 100): Promise<ResearchMatchRow[]> {
  const result = await env.DB.prepare(
    `SELECT m.* FROM research_matches m
      JOIN paper_catalog p ON p.paper_id = m.paper_id
      JOIN data_collections c ON c.collection_id = m.collection_id
     WHERE c.owner_user_id = ?1 AND p.status <> 'deleted' AND c.status <> 'deleted'
       AND (p.owner_user_id = ?1 OR p.visibility = 'public')
     ORDER BY m.updated_at DESC, m.match_id ASC LIMIT ?2`,
  ).bind(userId, Math.min(100, Math.max(1, limit))).all<ResearchMatchRow>();
  return result.results ?? [];
}

export async function getMatchForUser(env: Env, matchId: string, userId: string): Promise<ResearchMatchRow | null> {
  return env.DB.prepare(
    `SELECT m.* FROM research_matches m
      JOIN paper_catalog p ON p.paper_id = m.paper_id
      JOIN data_collections c ON c.collection_id = m.collection_id
     WHERE m.match_id = ?1 AND c.owner_user_id = ?2
       AND p.status <> 'deleted' AND c.status <> 'deleted'
       AND (p.owner_user_id = ?2 OR p.visibility = 'public')`,
  ).bind(matchId, userId).first<ResearchMatchRow>();
}

export async function claimMatchForEvaluation(env: Env, matchId: string, now = nowSeconds()): Promise<boolean> {
  return changed(await env.DB.prepare("UPDATE research_matches SET status = 'evaluating', updated_at = ?2 WHERE match_id = ?1 AND status = 'candidate' AND hard_gate = 'pending'").bind(matchId, now).run());
}

export async function saveMatchEvaluation(env: Env, input: { matchId: string; hardGate: Exclude<HardGate, "pending">; coverageRatio: number; executionConfidence: number; scientificFit: number; evaluatorVersion: string; evaluationJson: string; status: MatchStatus; now?: number }): Promise<boolean> {
  const now = input.now ?? nowSeconds();
  return changed(await env.DB.prepare(
    `UPDATE research_matches SET status = ?2, hard_gate = ?3, coverage_ratio = ?4,
       execution_confidence = ?5, scientific_fit = ?6, evaluator_version = ?7,
       evaluation_json = ?8, updated_at = ?9
     WHERE match_id = ?1 AND status IN ('evaluating', 'candidate')`,
  ).bind(input.matchId, input.status, input.hardGate, input.coverageRatio, input.executionConfidence, input.scientificFit, input.evaluatorVersion, input.evaluationJson, now).run());
}

export async function setMatchTask(env: Env, matchId: string, taskId: string, now = nowSeconds()): Promise<boolean> {
  return changed(await env.DB.prepare("UPDATE research_matches SET created_task_id = ?2, status = 'task_created', updated_at = ?3 WHERE match_id = ?1 AND created_task_id IS NULL AND hard_gate = 'pass'").bind(matchId, taskId, now).run());
}

export async function createDiscoveryProcessorSession(env: Env, input: DiscoveryProcessorSessionRow): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO discovery_processor_sessions
      (processor_session_id, processor_id, instance_id, session_token_hash, created_at, last_seen_at, expires_at, revoked_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6, NULL)`,
  ).bind(input.processor_session_id, input.processor_id, input.instance_id, input.session_token_hash, input.created_at, input.expires_at).run();
}

export async function getDiscoveryProcessorSessionByToken(env: Env, tokenHash: string, now = nowSeconds()): Promise<DiscoveryProcessorSessionRow | null> {
  return env.DB.prepare("SELECT * FROM discovery_processor_sessions WHERE session_token_hash = ?1 AND revoked_at IS NULL AND expires_at > ?2").bind(tokenHash, now).first<DiscoveryProcessorSessionRow>();
}

export async function touchDiscoveryProcessorSession(env: Env, sessionId: string, now = nowSeconds(), expiresAt = now + 15 * 60): Promise<boolean> {
  return changed(await env.DB.prepare("UPDATE discovery_processor_sessions SET last_seen_at = ?2, expires_at = ?3 WHERE processor_session_id = ?1 AND revoked_at IS NULL AND expires_at > ?2").bind(sessionId, now, expiresAt).run());
}

export async function claimNextDiscoveryWork(env: Env, now = nowSeconds()): Promise<DiscoveryWork | null> {
  const paper = await env.DB.prepare(
    `SELECT p.*, r.resource_id FROM paper_catalog p
      JOIN paper_resources r ON r.resource_id = p.source_resource_id
     WHERE p.status = 'requested' AND p.spam_status = 'pending' AND r.status = 'ready'
     ORDER BY p.created_at ASC LIMIT 1`,
  ).first<PaperCatalogRow & { resource_id: string }>();
  if (paper && changed(await env.DB.prepare("UPDATE paper_catalog SET status = 'processing', updated_at = ?2 WHERE paper_id = ?1 AND status = 'requested'").bind(paper.paper_id, now).run())) {
    return { kind: "paper", paper: { ...paper, status: "processing" }, resource_id: paper.resource_id };
  }
  const collection = await env.DB.prepare("SELECT * FROM data_collections WHERE status = 'uploaded' ORDER BY created_at ASC LIMIT 1").first<DataCollectionRow>();
  if (collection && await claimCollectionForInspection(env, collection.collection_id, now)) return { kind: "collection", collection: { ...collection, status: "inspecting" } };
  const match = await env.DB.prepare("SELECT * FROM research_matches WHERE status = 'candidate' AND hard_gate = 'pending' ORDER BY created_at ASC LIMIT 1").first<ResearchMatchRow>();
  if (match && await claimMatchForEvaluation(env, match.match_id, now)) return { kind: "match", match: { ...match, status: "evaluating" } };
  return null;
}
