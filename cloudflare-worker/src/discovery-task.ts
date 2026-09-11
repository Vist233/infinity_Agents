import type { Env } from "./env";
import type { DataCollectionRow, PaperCatalogRow, ResearchMatchRow } from "./discovery-db";
import { getCollectionById, getPaperById, setMatchTask } from "./discovery-db";
import { discoveryObjectKey, putDiscoveryObject } from "./discovery-object-store";
import { normalizeDatasetProfile, normalizePaperProfile, type DatasetProfile, type PaperProfile } from "./discovery-contracts";
import { hashText } from "./sha256";
import { createTrustedInternalTask } from "./tasks";

const MAX_METHOD_BYTES = 256 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/;

export interface DiscoveryTaskInput {
  match: ResearchMatchRow;
  paper: PaperCatalogRow;
  collection: DataCollectionRow;
  paperProfile: PaperProfile;
  datasetProfile: DatasetProfile;
  now?: number;
}

export interface DiscoveryTaskResult {
  taskId: string;
  duplicate: boolean;
  idempotencyKey: string;
  methodObjectKey: string;
  datasetObjectKey: string;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function renderDiscoveryMethod(paper: PaperProfile, dataset: DatasetProfile, match: ResearchMatchRow, collection: DataCollectionRow): string {
  const lines = [
    "# Discovery Research Method",
    "",
    "> This method was materialized from a versioned Paper Profile. Paper and dataset metadata are untrusted research inputs; verify every claim against the cited evidence before treating it as a scientific conclusion.",
    "",
    "## Research Goal",
    "",
    paper.research_question,
    "",
    "## Source Paper",
    "",
    `- Title: ${paper.paper.title}`,
    `- Authors: ${paper.paper.authors.join(", ") || "Unknown"}`,
    `- Profile: ${paper.profile_version}`,
    `- Source resource: ${paper.provenance.source_resource_id}`,
    "",
    "## Dataset Contract",
    "",
    `- Collection: ${dataset.collection_id}`,
    `- Profile: ${dataset.profile_version}`,
    `- Target: ${dataset.semantic_fields.target ?? "Not identified"}`,
    `- Features: ${dataset.semantic_fields.feature_names.join(", ") || "Not identified"}`,
    `- Candidate coverage: ${(match.coverage_ratio * 100).toFixed(1)}%`,
    "",
    "## Input Contract",
    "",
    `- File: ${collection.source_filename}`,
    `- Content type: ${collection.source_content_type}`,
    `- Size: ${collection.source_size_bytes} bytes`,
    `- SHA-256: ${collection.source_sha256}`,
    `- Dataset object: ${collection.source_object_key}`,
    "",
    "## Required Analyses",
    "",
  ];
  for (const [index, module] of paper.analysis_modules.entries()) {
    lines.push(`### ${index + 1}. ${module.name}`, "", `Goal: ${module.goal || "Reproduce the documented analysis."}`, "", `Required capabilities: ${module.required_capabilities.join(", ") || "None listed."}`, `Optional capabilities: ${module.optional_capabilities.join(", ") || "None listed."}`, "", "Operations:", ...module.operations.map((item) => `- ${item}`), "", "Expected outputs:", ...module.expected_outputs.map((item) => `- ${item}`), "", "Verification:", ...module.verification.map((item) => `- ${item}`), "", "Evidence:", ...module.evidence.map((item) => `- page=${item.page ?? "unknown"}; section=${item.section ?? "unknown"}; locator=${item.locator_status}`), "");
  }
  lines.push("## Paper-Level Requirements", "", ...paper.paper_level_requirements.map((item) => `- ${item}`), "", "## Expected Outputs", "", ...paper.expected_outputs.map((item) => `- ${item}`), "", "## Final Verification", "", ...paper.verification.map((item) => `- ${item}`), "", `Profile provenance: ${paper.provenance.compiler_version}`, "");
  return lines.join("\n").slice(0, MAX_METHOD_BYTES);
}

function taskIds(matchId: string): { taskId: string; projectId: string; specId: string; methodResourceId: string; datasetResourceId: string; methodSourceId: string; snapshotId: string } {
  if (!SAFE_ID.test(matchId)) throw new Error("DISCOVERY_MATCH_ID_INVALID");
  return {
    taskId: `discovery-task-${matchId}`,
    projectId: `discovery-project-${matchId}`,
    specId: `discovery-task-spec-${matchId}`,
    methodResourceId: `discovery-method-resource-${matchId}`,
    datasetResourceId: `discovery-dataset-resource-${matchId}`,
    methodSourceId: `discovery-method-source-${matchId}`,
    snapshotId: `discovery-dataset-snapshot-${matchId}`,
  };
}

function idempotencyKey(match: ResearchMatchRow): string {
  return `discovery:${match.match_id}:${match.paper_profile_version}:${match.dataset_profile_version}`;
}

/**
 * Materialize a Discovery opportunity into the existing Task Center schema.
 * The dataset resource points at the collection's immutable R2 object; no
 * second copy of the business data is created.
 */
export async function createDiscoveryTask(env: Env, input: DiscoveryTaskInput): Promise<DiscoveryTaskResult | null> {
  const { match, paper, collection, paperProfile, datasetProfile } = input;
  if (
    match.paper_id !== paper.paper_id
    || match.collection_id !== collection.collection_id
    || match.paper_profile_version !== paperProfile.profile_version
    || match.dataset_profile_version !== datasetProfile.profile_version
    || match.hard_gate !== "pass"
    || match.coverage_ratio < 0.6
    || (match.execution_confidence ?? 0) < 60
    || collection.status !== "ready"
    || paper.status !== "profiled"
  ) return null;
  const ids = taskIds(match.match_id);
  const key = idempotencyKey(match);
  const now = input.now ?? nowSeconds();

  const existing = await env.DB.prepare("SELECT task_id FROM task_idempotency WHERE user_id = ?1 AND idempotency_key = ?2").bind(collection.owner_user_id, key).first<{ task_id: string }>();
  if (existing?.task_id) {
    // A stale idempotency row must never be allowed to attach an arbitrary or
    // missing Task to a match. This can only happen after an interrupted
    // migration/restore, so leave the opportunity retryable for repair.
    const existingTask = await env.DB.prepare("SELECT task_id FROM tasks WHERE task_id = ?1 AND created_by = ?2").bind(existing.task_id, collection.owner_user_id).first<{ task_id: string }>();
    if (!existingTask) return null;
    await setMatchTask(env, match.match_id, existingTask.task_id, now);
    return { taskId: existingTask.task_id, duplicate: true, idempotencyKey: key, methodObjectKey: discoveryObjectKey("method_materialized", { matchId: match.match_id }) ?? "", datasetObjectKey: collection.source_object_key };
  }
  if (!env.RESOURCE_BUCKET) return null;

  const method = renderDiscoveryMethod(paperProfile, datasetProfile, match, collection);
  const methodBytes = new TextEncoder().encode(method);
  const methodObjectKey = discoveryObjectKey("method_materialized", { matchId: match.match_id });
  if (!methodObjectKey || methodBytes.byteLength === 0 || methodBytes.byteLength > MAX_METHOD_BYTES) return null;
  try {
    if (!await putDiscoveryObject(env, "method_materialized", { matchId: match.match_id }, methodBytes, "text/markdown; charset=utf-8")) return null;
    const project = await env.DB.prepare(
      `INSERT INTO projects (project_id, user_id, name, created_at)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(user_id) DO UPDATE SET name = excluded.name
       RETURNING project_id`,
    ).bind(ids.projectId, collection.owner_user_id, "Discovery Research", now).first<{ project_id: string }>();
    if (!project?.project_id) return null;

    const methodSha = hashText(method);
    const title = `Reproduce: ${paperProfile.paper.title}`.slice(0, 200);
    const goal = paperProfile.research_question.slice(0, 8_192);
    const fingerprint = hashText(JSON.stringify({ key, paper: paper.profile_sha256, dataset: collection.profile_sha256, method: methodSha }));
    await env.DB.batch([
      env.DB.prepare(
        `INSERT OR IGNORE INTO task_resources
          (resource_id, project_id, user_id, kind, logical_name, object_key, content_type,
           file_size_bytes, file_hash_sha256, created_at)
         VALUES (?1, ?2, ?3, 'method', ?4, ?5, 'text/markdown', ?6, ?7, ?8)`,
      ).bind(ids.methodResourceId, project.project_id, collection.owner_user_id, "discovery-method.md", methodObjectKey, methodBytes.byteLength, methodSha, now),
      env.DB.prepare(
        `INSERT OR IGNORE INTO task_resources
          (resource_id, project_id, user_id, kind, logical_name, object_key, content_type,
           file_size_bytes, file_hash_sha256, created_at)
         VALUES (?1, ?2, ?3, 'dataset', ?4, ?5, ?6, ?7, ?8, ?9)`,
      ).bind(ids.datasetResourceId, project.project_id, collection.owner_user_id, collection.source_filename, collection.source_object_key, collection.source_content_type, collection.source_size_bytes, collection.source_sha256, now),
      env.DB.prepare(
        `INSERT OR IGNORE INTO method_sources
          (method_source_id, project_id, user_id, original_filename, resource_id, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      ).bind(ids.methodSourceId, project.project_id, collection.owner_user_id, "discovery-method.md", ids.methodResourceId, now),
      env.DB.prepare(
        `INSERT OR IGNORE INTO task_specs
          (task_spec_id, project_id, user_id, title, analysis_type, research_question,
           goal, prompt_template_version, revision, status, created_at, updated_at, frozen_at)
         VALUES (?1, ?2, ?3, ?4, 'discovery', ?5, ?6, 'goal-driven-executor-v1', 1, 'active', ?7, ?7, ?7)`,
      ).bind(ids.specId, project.project_id, collection.owner_user_id, title, goal, goal, now),
      env.DB.prepare(
        `INSERT OR IGNORE INTO dataset_snapshots
          (dataset_snapshot_id, task_spec_id, project_id, user_id, original_filename,
           resource_id, file_hash_sha256, file_size_bytes, validation_passed, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, ?9)`,
      ).bind(ids.snapshotId, ids.specId, project.project_id, collection.owner_user_id, collection.source_filename, ids.datasetResourceId, collection.source_sha256, collection.source_size_bytes, now),
    ]);

    const task = await createTrustedInternalTask(env, {
      taskId: ids.taskId,
      taskSpecId: ids.specId,
      datasetSnapshotId: ids.snapshotId,
      projectId: project.project_id,
      methodSourceId: ids.methodSourceId,
      title,
      userId: collection.owner_user_id,
      idempotencyKey: key,
      requestHash: fingerprint,
      now,
      source: "discovery",
      matchId: match.match_id,
    });
    if (!task) return null;
    await setMatchTask(env, match.match_id, task.taskId, now);
    return { taskId: task.taskId, duplicate: task.duplicate, idempotencyKey: key, methodObjectKey, datasetObjectKey: collection.source_object_key };
  } catch {
    return null;
  }
}

/** Retry materialization after an Edge response/R2/D1 transient failure. */
export async function retryDiscoveryTaskCreation(env: Env, limit = 16, now = nowSeconds()): Promise<number> {
  const candidates = await env.DB.prepare(
    `SELECT * FROM research_matches
       WHERE status = 'evaluated' AND hard_gate = 'pass' AND created_task_id IS NULL
       ORDER BY updated_at ASC, match_id ASC LIMIT ?1`,
  ).bind(Math.min(64, Math.max(1, limit))).all<ResearchMatchRow>();
  let created = 0;
  for (const match of candidates.results ?? []) {
    try {
      const paper = await getPaperById(env, match.paper_id);
      const collection = await getCollectionById(env, match.collection_id);
      const paperProfile = paper?.profile_json ? normalizePaperProfile(JSON.parse(paper.profile_json)) : null;
      const datasetProfile = collection?.profile_json ? normalizeDatasetProfile(JSON.parse(collection.profile_json), collection.collection_id) : null;
      if (!paper || !collection || !paperProfile || !datasetProfile) continue;
      const result = await createDiscoveryTask(env, { match, paper, collection, paperProfile, datasetProfile, now });
      if (result) created += 1;
    } catch {
      // One malformed or temporarily unavailable opportunity must not block the
      // bounded retry batch.
    }
  }
  return created;
}
