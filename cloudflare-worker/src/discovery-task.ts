import type { Env } from "./env";
import type { DataCollectionRow, PaperCatalogRow, ResearchMatchRow } from "./discovery-db";
import { getCollectionById, getPaperById, setMatchTask } from "./discovery-db";
import { discoveryObjectKey, putDiscoveryObject } from "./discovery-object-store";
import { coarseMatch, normalizeDatasetProfile, normalizePaperProfile, paperEvidenceStatus, type DatasetProfile, type PaperProfile } from "./discovery-contracts";
import { hashText } from "./sha256";
import { createTrustedInternalTask } from "./tasks";

const MAX_METHOD_BYTES = 256 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/;

// Discovery paper metadata is untrusted research input. Keep the executor's
// mission platform-owned so a paper, model response, or profile cannot turn
// the privileged discovery task into an arbitrary instruction runner.
export const DISCOVERY_TASK_GOAL = "Reproduce the validated scientific method against the frozen dataset input and produce auditable deliverables.";

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

function discoveryTaskDiagnostic(match: ResearchMatchRow, stage: string, outcome: "rejected" | "failed"): void {
  // Keep production diagnostics bounded and free of paper text, dataset values,
  // credentials, or provider responses. The short match digest lets an
  // operator correlate one request without putting user identifiers in logs.
  console.warn("discovery_task_materialization", {
    outcome,
    stage,
    match_digest: hashText(match.match_id).slice(0, 12),
  });
}

function discoveryTaskErrorCategory(error: unknown): string {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  const tables = ["projects", "task_resources", "method_sources", "task_specs", "dataset_snapshots"];
  const table = tables.find((candidate) => message.includes(candidate));
  if (message.includes("unique") || message.includes("constraint")) return `constraint${table ? `:${table}` : ""}`;
  if (message.includes("foreign key")) return "foreign_key";
  if (message.includes("not null")) return "not_null";
  if (message.includes("syntax")) return "syntax";
  if (message.includes("d1") || message.includes("sqlite")) return "database";
  return error instanceof Error ? error.name : "unknown";
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
  const coarse = coarseMatch(paperProfile, datasetProfile);
  const gateReasons: string[] = [];
  if (match.paper_id !== paper.paper_id) gateReasons.push("paper_mismatch");
  if (match.collection_id !== collection.collection_id) gateReasons.push("collection_mismatch");
  if (match.paper_profile_version !== paperProfile.profile_version) gateReasons.push("paper_profile_version");
  if (match.dataset_profile_version !== datasetProfile.profile_version) gateReasons.push("dataset_profile_version");
  if (match.status !== "evaluated") gateReasons.push("match_status");
  if (match.hard_gate !== "pass") gateReasons.push("hard_gate");
  if (coarse.missing_required.length > 0) gateReasons.push("missing_required");
  if (coarse.supported_modules !== coarse.total_modules) gateReasons.push("unsupported_module");
  if (Math.abs(match.coverage_ratio - coarse.coverage_ratio) > 0.000001) gateReasons.push("coverage_mismatch");
  if (match.coverage_ratio < 0.6) gateReasons.push("coverage_threshold");
  if ((match.execution_confidence ?? 0) < 60) gateReasons.push("confidence_threshold");
  if (collection.status !== "ready") gateReasons.push("collection_status");
  if (paper.status !== "profiled") gateReasons.push("paper_status");
  if (paper.spam_status !== "scientific_paper") gateReasons.push("paper_spam_status");
  if (paperEvidenceStatus(paperProfile) !== "scientific_paper") gateReasons.push("paper_evidence");
  if (gateReasons.length > 0) {
    discoveryTaskDiagnostic(match, `validation:${gateReasons.slice(0, 4).join(",")}`, "rejected");
    return null;
  }
  const ids = taskIds(match.match_id);
  const key = idempotencyKey(match);
  const now = input.now ?? nowSeconds();
  const method = renderDiscoveryMethod(paperProfile, datasetProfile, match, collection);
  const methodBytes = new TextEncoder().encode(method);
  const methodSha = hashText(method);
  const methodObjectKey = discoveryObjectKey("method_materialized", { matchId: match.match_id, contentSha256: methodSha });
  if (!methodObjectKey || methodBytes.byteLength === 0 || methodBytes.byteLength > MAX_METHOD_BYTES) {
    discoveryTaskDiagnostic(match, "method_materialization", "rejected");
    return null;
  }

  const existing = await env.DB.prepare("SELECT task_id FROM task_idempotency WHERE user_id = ?1 AND idempotency_key = ?2").bind(collection.owner_user_id, key).first<{ task_id: string }>();
  if (existing?.task_id) {
    // A stale idempotency row must never be allowed to attach an arbitrary or
    // missing Task to a match. This can only happen after an interrupted
    // migration/restore, so leave the opportunity retryable for repair.
    const existingTask = await env.DB.prepare("SELECT task_id FROM tasks WHERE task_id = ?1 AND created_by = ?2").bind(existing.task_id, collection.owner_user_id).first<{ task_id: string }>();
    if (!existingTask) {
      discoveryTaskDiagnostic(match, "stale_idempotency", "rejected");
      return null;
    }
    if (!await setMatchTask(env, match.match_id, existingTask.task_id, now)) {
      discoveryTaskDiagnostic(match, "attach_existing_task", "failed");
      return null;
    }
    return { taskId: existingTask.task_id, duplicate: true, idempotencyKey: key, methodObjectKey, datasetObjectKey: collection.source_object_key };
  }
  if (!env.RESOURCE_BUCKET) {
    discoveryTaskDiagnostic(match, "resource_bucket", "failed");
    return null;
  }

  let stage = "method_object";
  try {
    if (!await putDiscoveryObject(env, "method_materialized", { matchId: match.match_id, contentSha256: methodSha }, methodBytes, "text/markdown; charset=utf-8")) {
      discoveryTaskDiagnostic(match, "r2_put", "failed");
      return null;
    }
    stage = "project";
    const insertedProject = await env.DB.prepare(
      `INSERT INTO projects (project_id, user_id, name, created_at)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(user_id) DO NOTHING
       RETURNING project_id`,
    ).bind(ids.projectId, collection.owner_user_id, "Discovery Research", now).first<{ project_id: string }>();
    const project = insertedProject ?? await env.DB.prepare(
      "SELECT project_id FROM projects WHERE user_id = ?1",
    ).bind(collection.owner_user_id).first<{ project_id: string }>();
    if (!project?.project_id) {
      discoveryTaskDiagnostic(match, "project", "failed");
      return null;
    }
    stage = "dataset_resource";
    const existingDatasetResource = await env.DB.prepare(
      "SELECT resource_id, project_id, user_id, kind FROM task_resources WHERE object_key = ?1",
    ).bind(collection.source_object_key).first<{ resource_id: string; project_id: string; user_id: string; kind: string }>();
    if (existingDatasetResource && (
      existingDatasetResource.project_id !== project.project_id
      || existingDatasetResource.user_id !== collection.owner_user_id
      || existingDatasetResource.kind !== "dataset"
    )) {
      discoveryTaskDiagnostic(match, "dataset_resource_owner", "rejected");
      return null;
    }
    // task_resources.object_key is globally unique. Reuse the immutable
    // collection resource when another Discovery Task has already referenced
    // this collection; otherwise the INSERT OR IGNORE below would skip the
    // row while the new dataset snapshot still pointed at a nonexistent ID.
    const datasetResourceId = existingDatasetResource?.resource_id ?? ids.datasetResourceId;

    const title = `Reproduce: ${paperProfile.paper.title}`.slice(0, 200);
    const researchQuestion = paperProfile.research_question.slice(0, 4_096);
    const fingerprint = hashText(JSON.stringify({ key, paper: paper.profile_sha256, dataset: collection.profile_sha256, method: methodSha }));
    stage = "transport_batch";
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
      ).bind(datasetResourceId, project.project_id, collection.owner_user_id, collection.source_filename, collection.source_object_key, collection.source_content_type, collection.source_size_bytes, collection.source_sha256, now),
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
      ).bind(ids.specId, project.project_id, collection.owner_user_id, title, researchQuestion, DISCOVERY_TASK_GOAL, now),
      env.DB.prepare(
        `INSERT OR IGNORE INTO dataset_snapshots
          (dataset_snapshot_id, task_spec_id, project_id, user_id, original_filename,
           resource_id, file_hash_sha256, file_size_bytes, validation_passed, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, ?9)`,
      ).bind(ids.snapshotId, ids.specId, project.project_id, collection.owner_user_id, collection.source_filename, datasetResourceId, collection.source_sha256, collection.source_size_bytes, now),
    ]);

    stage = "task_batch";
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
    if (!task) {
      discoveryTaskDiagnostic(match, "task_batch_result", "failed");
      return null;
    }
    stage = "match_attach";
    if (!await setMatchTask(env, match.match_id, task.taskId, now)) {
      discoveryTaskDiagnostic(match, stage, "failed");
      return null;
    }
    return { taskId: task.taskId, duplicate: task.duplicate, idempotencyKey: key, methodObjectKey, datasetObjectKey: collection.source_object_key };
  } catch (error) {
    discoveryTaskDiagnostic(match, `${stage}:${discoveryTaskErrorCategory(error)}`, "failed");
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
