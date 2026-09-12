import type { Env } from "./env";
import { nowSeconds } from "./http";
import { normalizePaperProfile, paperEvidenceStatus, type HardGate, type MatchStatus, type PaperCatalogStatus, type SpamStatus, type CollectionStatus } from "./discovery-contracts";

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
  profile_object_key?: string | null;
  overview_object_key: string | null;
  created_at: number;
  updated_at: number;
  discovery_lease_owner?: string | null;
  discovery_lease_expires_at?: number | null;
  discovery_lease_token_hash?: string | null;
  discovery_fencing_epoch?: number;
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
  profile_object_key?: string | null;
  error_code: string | null;
  error_message_safe: string | null;
  created_at: number;
  updated_at: number;
  discovery_lease_owner?: string | null;
  discovery_lease_expires_at?: number | null;
  discovery_lease_token_hash?: string | null;
  discovery_fencing_epoch?: number;
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
  evaluation_object_key?: string | null;
  created_task_id: string | null;
  candidate_reason: string | null;
  created_at: number;
  updated_at: number;
  discovery_lease_owner?: string | null;
  discovery_lease_expires_at?: number | null;
  discovery_lease_token_hash?: string | null;
  discovery_fencing_epoch?: number;
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

export interface LiteratureWatchStateRow {
  source: string;
  query: string;
  last_cursor: string | null;
  last_checked_at: number | null;
  created_at: number;
  updated_at: number;
  lease_owner?: string | null;
  lease_expires_at?: number | null;
}

export interface LiteratureFailureRow {
  failure_id: string;
  source: string;
  query: string;
  source_ref: string;
  record_json: string;
  attempts: number;
  next_retry_at: number;
  status: "pending" | "dead";
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

export type DiscoveryWork =
  | { kind: "paper"; paper: PaperCatalogRow; resource_id: string; fencing_epoch: number; lease_expires_at: number }
  | { kind: "collection"; collection: DataCollectionRow; fencing_epoch: number; lease_expires_at: number }
  | { kind: "match"; match: ResearchMatchRow; fencing_epoch: number; lease_expires_at: number };

export const DISCOVERY_LEASE_SECONDS = 5 * 60;
export const LITERATURE_WATCH_LEASE_SECONDS = 5 * 60;

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

export async function findPublicPaperBySource(env: Env, sourceKind: "arxiv" | "pubmed_pmc", sourceRef: string): Promise<PaperCatalogRow | null> {
  return env.DB.prepare(
    `SELECT p.* FROM paper_catalog p
       JOIN paper_resources r ON r.resource_id = p.source_resource_id
      WHERE p.visibility = 'public' AND p.status <> 'deleted'
        AND r.source_kind = ?1 AND r.source_ref = ?2
      ORDER BY p.updated_at DESC LIMIT 1`,
  ).bind(sourceKind, sourceRef).first<PaperCatalogRow>();
}

export async function getLiteratureWatchState(env: Env, source: string, query: string): Promise<LiteratureWatchStateRow | null> {
  return env.DB.prepare(
    "SELECT source, query, last_cursor, last_checked_at, created_at, updated_at, lease_owner, lease_expires_at FROM literature_watch_state WHERE source = ?1 AND query = ?2",
  ).bind(source, query).first<LiteratureWatchStateRow>();
}

export async function claimLiteratureWatchState(env: Env, input: { source: string; query: string; owner: string; now?: number; leaseSeconds?: number }): Promise<LiteratureWatchStateRow | null> {
  const now = input.now ?? nowSeconds();
  const expiresAt = now + (input.leaseSeconds ?? LITERATURE_WATCH_LEASE_SECONDS);
  return env.DB.prepare(
    `INSERT INTO literature_watch_state
       (source, query, last_cursor, last_checked_at, created_at, updated_at, lease_owner, lease_expires_at)
     VALUES (?1, ?2, NULL, NULL, ?3, ?3, ?4, ?5)
     ON CONFLICT(source, query) DO UPDATE SET lease_owner = excluded.lease_owner,
       lease_expires_at = excluded.lease_expires_at, updated_at = excluded.updated_at
       WHERE literature_watch_state.lease_owner IS NULL
          OR literature_watch_state.lease_expires_at IS NULL
          OR literature_watch_state.lease_expires_at <= excluded.updated_at
     RETURNING source, query, last_cursor, last_checked_at, created_at, updated_at, lease_owner, lease_expires_at`,
  ).bind(input.source, input.query, now, input.owner, expiresAt).first<LiteratureWatchStateRow>();
}

export async function saveLiteratureWatchState(env: Env, input: { source: string; query: string; cursor: string | null; leaseOwner: string; now?: number }): Promise<boolean> {
  const now = input.now ?? nowSeconds();
  return changed(await env.DB.prepare(
    `UPDATE literature_watch_state SET last_cursor = ?3, last_checked_at = ?4,
       updated_at = ?4, lease_owner = NULL, lease_expires_at = NULL
     WHERE source = ?1 AND query = ?2 AND lease_owner = ?5 AND lease_expires_at > ?4`,
  ).bind(input.source, input.query, input.cursor, now, input.leaseOwner).run());
}

export async function releaseLiteratureWatchLease(env: Env, input: { source: string; query: string; owner: string; now?: number }): Promise<boolean> {
  const now = input.now ?? nowSeconds();
  return changed(await env.DB.prepare(
    `UPDATE literature_watch_state SET lease_owner = NULL, lease_expires_at = NULL, updated_at = ?3
     WHERE source = ?1 AND query = ?2 AND lease_owner = ?4
       AND (lease_expires_at IS NULL OR lease_expires_at > ?3)`,
  ).bind(input.source, input.query, now, input.owner).run());
}

/** Count only papers materialized by the system watcher in a UTC day. */
export async function countLiteraturePapersCreatedBetween(env: Env, input: { ownerUserId: string; startAt: number; endAt: number }): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS count
       FROM paper_catalog p
       JOIN paper_resources r ON r.resource_id = p.source_resource_id
      WHERE p.visibility = 'public' AND p.owner_user_id IS NULL
        AND r.user_id = ?1 AND p.status <> 'deleted'
        AND p.created_at >= ?2 AND p.created_at < ?3`,
  ).bind(input.ownerUserId, input.startAt, input.endAt).first<{ count: number }>();
  const count = Number(row?.count ?? 0);
  return Number.isSafeInteger(count) && count > 0 ? count : 0;
}

/** Create the daily quota row once; the counter is reserved atomically below. */
export async function ensureLiteratureDailyQuota(env: Env, input: { ownerUserId: string; dayStart: number; limit: number; initialCount: number; now?: number }): Promise<void> {
  const now = input.now ?? nowSeconds();
  await env.DB.prepare(
    `INSERT INTO literature_watch_daily_quota
       (owner_user_id, day_start, limit_count, reserved_count, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?5)
     ON CONFLICT(owner_user_id, day_start) DO UPDATE SET limit_count = excluded.limit_count, updated_at = excluded.updated_at`,
  ).bind(input.ownerUserId, input.dayStart, input.limit, Math.max(0, input.initialCount), now).run();
}

export async function reserveLiteratureDailyQuota(env: Env, input: { ownerUserId: string; dayStart: number; now?: number }): Promise<boolean> {
  const now = input.now ?? nowSeconds();
  return changed(await env.DB.prepare(
    `UPDATE literature_watch_daily_quota SET reserved_count = reserved_count + 1, updated_at = ?3
      WHERE owner_user_id = ?1 AND day_start = ?2 AND reserved_count < limit_count`,
  ).bind(input.ownerUserId, input.dayStart, now).run());
}

export async function releaseLiteratureDailyQuota(env: Env, input: { ownerUserId: string; dayStart: number; now?: number }): Promise<boolean> {
  const now = input.now ?? nowSeconds();
  return changed(await env.DB.prepare(
    `UPDATE literature_watch_daily_quota SET reserved_count = MAX(0, reserved_count - 1), updated_at = ?3
      WHERE owner_user_id = ?1 AND day_start = ?2 AND reserved_count > 0`,
  ).bind(input.ownerUserId, input.dayStart, now).run());
}

export async function listDueLiteratureFailures(env: Env, input: { source: string; query: string; now: number; limit?: number }): Promise<LiteratureFailureRow[]> {
  const result = await env.DB.prepare(
    `SELECT failure_id, source, query, source_ref, record_json, attempts, next_retry_at, status, last_error, created_at, updated_at
       FROM literature_watch_failures
      WHERE source = ?1 AND query = ?2 AND status = 'pending' AND next_retry_at <= ?3
      ORDER BY next_retry_at ASC, failure_id ASC LIMIT ?4`,
  ).bind(input.source, input.query, input.now, Math.min(32, Math.max(1, input.limit ?? 8))).all<LiteratureFailureRow>();
  return result.results ?? [];
}

export async function recordLiteratureFailure(env: Env, input: { failureId: string; source: string; query: string; sourceRef: string; recordJson: string; nextRetryAt: number; error: string; maxAttempts?: number; now?: number }): Promise<LiteratureFailureRow | null> {
  const now = input.now ?? nowSeconds();
  const maxAttempts = Math.min(20, Math.max(1, input.maxAttempts ?? 5));
  return env.DB.prepare(
    `INSERT INTO literature_watch_failures
       (failure_id, source, query, source_ref, record_json, attempts, next_retry_at, status, last_error, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, CASE WHEN 1 >= ?7 THEN 'dead' ELSE 'pending' END, ?8, ?9, ?9)
     ON CONFLICT(source, query, source_ref) DO UPDATE SET
       record_json = excluded.record_json,
       attempts = literature_watch_failures.attempts + 1,
       next_retry_at = excluded.next_retry_at,
       status = CASE WHEN literature_watch_failures.attempts + 1 >= ?7 THEN 'dead' ELSE 'pending' END,
       last_error = excluded.last_error,
       updated_at = excluded.updated_at
     RETURNING failure_id, source, query, source_ref, record_json, attempts, next_retry_at, status, last_error, created_at, updated_at`,
  ).bind(input.failureId, input.source, input.query, input.sourceRef, input.recordJson, input.nextRetryAt, maxAttempts, input.error.slice(0, 512), now).first<LiteratureFailureRow>();
}

export async function resolveLiteratureFailure(env: Env, input: { source: string; query: string; sourceRef: string }): Promise<boolean> {
  return changed(await env.DB.prepare(
    "DELETE FROM literature_watch_failures WHERE source = ?1 AND query = ?2 AND source_ref = ?3",
  ).bind(input.source, input.query, input.sourceRef).run());
}

export async function getCollectionById(env: Env, collectionId: string): Promise<DataCollectionRow | null> {
  return env.DB.prepare("SELECT * FROM data_collections WHERE collection_id = ?1").bind(collectionId).first<DataCollectionRow>();
}

export async function getMatchById(env: Env, matchId: string): Promise<ResearchMatchRow | null> {
  return env.DB.prepare("SELECT * FROM research_matches WHERE match_id = ?1").bind(matchId).first<ResearchMatchRow>();
}

export async function getPaperResourceForCatalogOwner(env: Env, resourceId: string, userId: string): Promise<{ resource_id: string; session_id: string } | null> {
  return env.DB.prepare(
    "SELECT resource_id, session_id FROM paper_resources WHERE resource_id = ?1 AND user_id = ?2",
  ).bind(resourceId, userId).first<{ resource_id: string; session_id: string }>();
}

export async function markPaperDeletedForUser(env: Env, paperId: string, userId: string, now = nowSeconds()): Promise<boolean> {
  return changed(await env.DB.prepare(
    "UPDATE paper_catalog SET status = 'deleted', updated_at = ?3, discovery_lease_owner = NULL, discovery_lease_expires_at = NULL, discovery_lease_token_hash = NULL WHERE paper_id = ?1 AND owner_user_id = ?2 AND visibility = 'private' AND status <> 'deleted'",
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
  input: { paperId: string; profileVersion: string; profileJson: string; profileSha256: string; profileObjectKey: string; overviewObjectKey: string; spamStatus: SpamStatus; title: string; authorsJson: string; year: number | null; venue: string | null; leaseOwner?: string; leaseTokenHash?: string; fencingEpoch?: number; now?: number },
): Promise<boolean> {
  let profile: ReturnType<typeof normalizePaperProfile> = null;
  try {
    profile = normalizePaperProfile(JSON.parse(input.profileJson));
  } catch {
    profile = null;
  }
  // Keep the deterministic document gate at the persistence boundary too.
  // This prevents a future processor caller from turning a schema-valid
  // non-paper/review profile into a matching-eligible `profiled` row.
  if (input.spamStatus !== "scientific_paper" || !profile || paperEvidenceStatus(profile) !== "scientific_paper") return false;
  const now = input.now ?? nowSeconds();
  const result = await env.DB.prepare(
    `UPDATE paper_catalog SET status = 'profiled', spam_status = ?2, profile_version = ?3,
       profile_json = ?4, profile_sha256 = ?5, profile_object_key = ?6, overview_object_key = ?7, title = ?8,
       authors_json = ?9, year = ?10, venue = ?11, updated_at = ?12,
       discovery_lease_owner = NULL, discovery_lease_expires_at = NULL, discovery_lease_token_hash = NULL
     WHERE paper_id = ?1 AND status = 'processing'
       AND (?13 IS NULL OR (discovery_lease_owner = ?13 AND discovery_fencing_epoch = ?14 AND discovery_lease_token_hash = ?15 AND discovery_lease_expires_at > ?12))`,
  ).bind(input.paperId, input.spamStatus, input.profileVersion, input.profileJson, input.profileSha256, input.profileObjectKey, input.overviewObjectKey, input.title, input.authorsJson, input.year, input.venue, now, input.leaseOwner ?? null, input.fencingEpoch ?? null, input.leaseTokenHash ?? null).run();
  return changed(result);
}

export async function failPaperProfile(env: Env, paperId: string, spamStatus: SpamStatus, now = nowSeconds(), lease?: { owner: string; tokenHash: string; fencingEpoch: number }): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE paper_catalog SET status = 'failed', spam_status = ?2, updated_at = ?3,
       discovery_lease_owner = NULL, discovery_lease_expires_at = NULL, discovery_lease_token_hash = NULL
      WHERE paper_id = ?1 AND status IN ('requested', 'processing')
        AND (?4 IS NULL OR (discovery_lease_owner = ?4 AND discovery_fencing_epoch = ?5 AND discovery_lease_token_hash = ?6 AND discovery_lease_expires_at > ?3))`,
  ).bind(paperId, spamStatus, now, lease?.owner ?? null, lease?.fencingEpoch ?? null, lease?.tokenHash ?? null).run();
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

/** Return whether a live Task still depends on this collection's immutable R2 object. */
export async function collectionHasActiveTask(env: Env, collectionId: string, userId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT t.task_id
       FROM data_collections c
       JOIN task_resources tr ON tr.object_key = c.source_object_key
       JOIN dataset_snapshots ds ON ds.resource_id = tr.resource_id
       JOIN tasks t ON t.dataset_snapshot_id = ds.dataset_snapshot_id
      WHERE c.collection_id = ?1 AND c.owner_user_id = ?2
        AND t.status IN ('queued', 'claimed', 'running')
      LIMIT 1`,
  ).bind(collectionId, userId).first<{ task_id: string }>();
  return Boolean(row?.task_id);
}

export async function markCollectionDeletedForUser(env: Env, collectionId: string, userId: string, now = nowSeconds()): Promise<boolean> {
  return changed(await env.DB.prepare(
    `UPDATE data_collections SET status = 'deleted', updated_at = ?3,
        discovery_lease_owner = NULL, discovery_lease_expires_at = NULL, discovery_lease_token_hash = NULL
      WHERE collection_id = ?1 AND owner_user_id = ?2 AND status <> 'deleted'
        AND NOT EXISTS (
          SELECT 1
            FROM task_resources tr
            JOIN dataset_snapshots ds ON ds.resource_id = tr.resource_id
            JOIN tasks t ON t.dataset_snapshot_id = ds.dataset_snapshot_id
           WHERE tr.object_key = data_collections.source_object_key
             AND t.status IN ('queued', 'claimed', 'running')
        )`,
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

export async function claimCollectionForInspection(env: Env, collectionId: string, now = nowSeconds(), leaseOwner = "discovery-processor", leaseTokenHash?: string): Promise<boolean> {
  return changed(await env.DB.prepare(
    `UPDATE data_collections SET status = 'inspecting', updated_at = ?2,
       discovery_lease_owner = ?3, discovery_lease_expires_at = ?4, discovery_lease_token_hash = ?5,
       discovery_fencing_epoch = COALESCE(discovery_fencing_epoch, 0) + 1
      WHERE collection_id = ?1 AND status = 'uploaded'
        AND (discovery_lease_expires_at IS NULL OR discovery_lease_expires_at <= ?2)`,
  ).bind(collectionId, now, leaseOwner, now + DISCOVERY_LEASE_SECONDS, leaseTokenHash ?? null).run());
}

export async function saveDatasetProfile(env: Env, input: { collectionId: string; profileVersion: string; profileJson: string; profileSha256: string; profileObjectKey: string; leaseOwner?: string; leaseTokenHash?: string; fencingEpoch?: number; now?: number }): Promise<boolean> {
  const now = input.now ?? nowSeconds();
  return changed(await env.DB.prepare(
    `UPDATE data_collections SET status = 'ready', profile_version = ?2, profile_json = ?3,
       profile_object_key = ?4, profile_sha256 = ?5, error_code = NULL, error_message_safe = NULL, updated_at = ?6,
       discovery_lease_owner = NULL, discovery_lease_expires_at = NULL, discovery_lease_token_hash = NULL
     WHERE collection_id = ?1 AND status = 'inspecting'
       AND (?7 IS NULL OR (discovery_lease_owner = ?7 AND discovery_fencing_epoch = ?8 AND discovery_lease_token_hash = ?9 AND discovery_lease_expires_at > ?6))`,
  ).bind(input.collectionId, input.profileVersion, input.profileJson, input.profileObjectKey, input.profileSha256, now, input.leaseOwner ?? null, input.fencingEpoch ?? null, input.leaseTokenHash ?? null).run());
}

export async function failCollection(env: Env, collectionId: string, errorCode: string, message: string, now = nowSeconds(), lease?: { owner: string; tokenHash: string; fencingEpoch: number }): Promise<boolean> {
  return changed(await env.DB.prepare(
    `UPDATE data_collections SET status = 'failed', error_code = ?2, error_message_safe = ?3, updated_at = ?4,
       discovery_lease_owner = NULL, discovery_lease_expires_at = NULL, discovery_lease_token_hash = NULL
      WHERE collection_id = ?1 AND status IN ('uploaded', 'inspecting')
        AND (?5 IS NULL OR (discovery_lease_owner = ?5 AND discovery_fencing_epoch = ?6 AND discovery_lease_token_hash = ?7 AND discovery_lease_expires_at > ?4))`,
  ).bind(collectionId, errorCode, message.slice(0, 1024), now, lease?.owner ?? null, lease?.fencingEpoch ?? null, lease?.tokenHash ?? null).run());
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
       AND p.spam_status = 'scientific_paper'
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
       AND p.spam_status = 'scientific_paper'
       AND (p.owner_user_id = ?2 OR p.visibility = 'public')`,
  ).bind(matchId, userId).first<ResearchMatchRow>();
}

export async function claimMatchForEvaluation(env: Env, matchId: string, now = nowSeconds(), leaseOwner = "discovery-processor", leaseTokenHash?: string): Promise<boolean> {
  return changed(await env.DB.prepare(
    `UPDATE research_matches SET status = 'evaluating', updated_at = ?2,
       discovery_lease_owner = ?3, discovery_lease_expires_at = ?4, discovery_lease_token_hash = ?5,
       discovery_fencing_epoch = COALESCE(discovery_fencing_epoch, 0) + 1
      WHERE match_id = ?1 AND status = 'candidate' AND hard_gate = 'pending'
        AND (discovery_lease_expires_at IS NULL OR discovery_lease_expires_at <= ?2)`,
  ).bind(matchId, now, leaseOwner, now + DISCOVERY_LEASE_SECONDS, leaseTokenHash ?? null).run());
}

export async function saveMatchEvaluation(env: Env, input: { matchId: string; hardGate: Exclude<HardGate, "pending">; coverageRatio: number; executionConfidence: number; scientificFit: number; evaluatorVersion: string; evaluationJson: string; evaluationObjectKey: string; status: MatchStatus; leaseOwner?: string; leaseTokenHash?: string; fencingEpoch?: number; now?: number }): Promise<boolean> {
  const now = input.now ?? nowSeconds();
  return changed(await env.DB.prepare(
    `UPDATE research_matches SET status = ?2, hard_gate = ?3, coverage_ratio = ?4,
       execution_confidence = ?5, scientific_fit = ?6, evaluator_version = ?7,
       evaluation_json = ?8, evaluation_object_key = ?9, updated_at = ?10,
       discovery_lease_owner = NULL, discovery_lease_expires_at = NULL, discovery_lease_token_hash = NULL
     WHERE match_id = ?1 AND status IN ('evaluating', 'candidate')
       AND (?11 IS NULL OR (discovery_lease_owner = ?11 AND discovery_fencing_epoch = ?12 AND discovery_lease_token_hash = ?13 AND discovery_lease_expires_at > ?10))`,
  ).bind(input.matchId, input.status, input.hardGate, input.coverageRatio, input.executionConfidence, input.scientificFit, input.evaluatorVersion, input.evaluationJson, input.evaluationObjectKey, now, input.leaseOwner ?? null, input.fencingEpoch ?? null, input.leaseTokenHash ?? null).run());
}

export async function setMatchTask(env: Env, matchId: string, taskId: string, now = nowSeconds()): Promise<boolean> {
  return changed(await env.DB.prepare("UPDATE research_matches SET created_task_id = ?2, status = 'task_created', updated_at = ?3 WHERE match_id = ?1 AND created_task_id IS NULL AND hard_gate = 'pass'").bind(matchId, taskId, now).run());
}

export type DiscoveryLeaseKind = "paper" | "collection" | "match";

export async function renewDiscoveryLease(
  env: Env,
  input: { kind: DiscoveryLeaseKind; id: string; owner: string; tokenHash: string; fencingEpoch: number; now?: number; leaseExpiresAt?: number },
): Promise<boolean> {
  const now = input.now ?? nowSeconds();
  const expiresAt = input.leaseExpiresAt ?? now + DISCOVERY_LEASE_SECONDS;
  const table = input.kind === "paper" ? "paper_catalog" : input.kind === "collection" ? "data_collections" : "research_matches";
  const key = input.kind === "paper" ? "paper_id" : input.kind === "collection" ? "collection_id" : "match_id";
  const activeStatuses = input.kind === "paper" ? "('processing')" : input.kind === "collection" ? "('inspecting')" : "('evaluating')";
  return changed(await env.DB.prepare(
    `UPDATE ${table} SET discovery_lease_expires_at = ?, updated_at = ?
      WHERE ${key} = ? AND discovery_lease_owner = ? AND discovery_lease_token_hash = ? AND discovery_fencing_epoch = ?
        AND status IN ${activeStatuses} AND discovery_lease_expires_at > ?`,
  ).bind(expiresAt, now, input.id, input.owner, input.tokenHash, input.fencingEpoch, now).run());
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

/** Return abandoned Discovery items to their retryable pre-claim state. */
export async function recoverExpiredDiscoveryLeases(env: Env, now = nowSeconds()): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE paper_catalog SET status = 'requested', updated_at = ?1,
          discovery_lease_owner = NULL, discovery_lease_expires_at = NULL, discovery_lease_token_hash = NULL
        WHERE status = 'processing' AND discovery_lease_expires_at IS NOT NULL AND discovery_lease_expires_at <= ?1`,
    ).bind(now),
    env.DB.prepare(
      `UPDATE data_collections SET status = 'uploaded', updated_at = ?1,
          discovery_lease_owner = NULL, discovery_lease_expires_at = NULL, discovery_lease_token_hash = NULL
        WHERE status = 'inspecting' AND discovery_lease_expires_at IS NOT NULL AND discovery_lease_expires_at <= ?1`,
    ).bind(now),
    env.DB.prepare(
      `UPDATE research_matches SET status = 'candidate', updated_at = ?1,
          discovery_lease_owner = NULL, discovery_lease_expires_at = NULL, discovery_lease_token_hash = NULL
        WHERE status = 'evaluating' AND hard_gate = 'pending'
          AND discovery_lease_expires_at IS NOT NULL AND discovery_lease_expires_at <= ?1`,
    ).bind(now),
  ]);
}

/** Claim the oldest available paper, dataset, or match with a fenced lease. */
export async function claimNextDiscoveryWork(env: Env, processorIdOrNow: string | number = "discovery-processor", maybeNow?: number, leaseTokenHash?: string): Promise<DiscoveryWork | null> {
  const processorId = typeof processorIdOrNow === "string" ? processorIdOrNow : "discovery-processor";
  const now = typeof processorIdOrNow === "number" ? processorIdOrNow : (maybeNow ?? nowSeconds());
  await recoverExpiredDiscoveryLeases(env, now);
  const paper = await env.DB.prepare(
    `SELECT p.*, r.resource_id FROM paper_catalog p
      JOIN paper_resources r ON r.resource_id = p.source_resource_id
     WHERE p.status = 'requested' AND p.spam_status = 'pending' AND r.status = 'ready'
       AND (p.discovery_lease_expires_at IS NULL OR p.discovery_lease_expires_at <= ?1)
     ORDER BY p.created_at ASC LIMIT 1`,
  ).bind(now).first<PaperCatalogRow & { resource_id: string }>();
  if (paper && changed(await env.DB.prepare(
    `UPDATE paper_catalog SET status = 'processing', updated_at = ?2,
       discovery_lease_owner = ?3, discovery_lease_expires_at = ?4, discovery_lease_token_hash = ?5,
       discovery_fencing_epoch = COALESCE(discovery_fencing_epoch, 0) + 1
      WHERE paper_id = ?1 AND status = 'requested'
        AND (discovery_lease_expires_at IS NULL OR discovery_lease_expires_at <= ?2)`,
  ).bind(paper.paper_id, now, processorId, now + DISCOVERY_LEASE_SECONDS, leaseTokenHash ?? null).run())) {
    const claimed = await env.DB.prepare("SELECT * FROM paper_catalog WHERE paper_id = ?1").bind(paper.paper_id).first<PaperCatalogRow>();
    const epoch = Number(claimed?.discovery_fencing_epoch ?? 0);
    return claimed && epoch > 0 ? { kind: "paper", paper: claimed, resource_id: paper.resource_id, fencing_epoch: epoch, lease_expires_at: now + DISCOVERY_LEASE_SECONDS } : null;
  }
  const collection = await env.DB.prepare("SELECT * FROM data_collections WHERE status = 'uploaded' ORDER BY created_at ASC LIMIT 1").first<DataCollectionRow>();
  if (collection && await claimCollectionForInspection(env, collection.collection_id, now, processorId, leaseTokenHash)) {
    const claimed = await env.DB.prepare("SELECT * FROM data_collections WHERE collection_id = ?1").bind(collection.collection_id).first<DataCollectionRow>();
    const epoch = Number(claimed?.discovery_fencing_epoch ?? 0);
    if (claimed && epoch > 0) return { kind: "collection", collection: claimed, fencing_epoch: epoch, lease_expires_at: now + DISCOVERY_LEASE_SECONDS };
  }
  const match = await env.DB.prepare("SELECT * FROM research_matches WHERE status = 'candidate' AND hard_gate = 'pending' ORDER BY created_at ASC LIMIT 1").first<ResearchMatchRow>();
  if (match && await claimMatchForEvaluation(env, match.match_id, now, processorId, leaseTokenHash)) {
    const claimed = await env.DB.prepare("SELECT * FROM research_matches WHERE match_id = ?1").bind(match.match_id).first<ResearchMatchRow>();
    const epoch = Number(claimed?.discovery_fencing_epoch ?? 0);
    if (claimed && epoch > 0) return { kind: "match", match: claimed, fencing_epoch: epoch, lease_expires_at: now + DISCOVERY_LEASE_SECONDS };
  }
  return null;
}
