import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { handleDiscoveryProcessorApi } from "../src/discovery-processor";
import { hashText } from "../src/sha256";
import { makeEnv } from "./fake-d1";

class MemoryBucket {
  objects = new Map<string, Uint8Array>();

  async put(key: string, value: ArrayBuffer | ArrayBufferView | string): Promise<void> {
    if (typeof value === "string") this.objects.set(key, new TextEncoder().encode(value));
    else if (value instanceof ArrayBuffer) this.objects.set(key, new Uint8Array(value));
    else this.objects.set(key, new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice());
  }
}

function processorRequest(path: string, init: RequestInit = {}): Request {
  return new Request(`https://app.test${path}`, init);
}

const PAPER_PROFILE = {
  profile_version: "paper-profile-v1",
  model_version: "test-model",
  provenance: { source_resource_id: "resource-1", compiler_version: "test-compiler", generated_at: "2026-09-11T00:00:00Z" },
  paper: { title: "Example paper", authors: ["A"], year: 2023, venue: "Test venue", abstract: "Abstract", research_question: "Q", main_claims: ["C"] },
  research_question: "Q",
  main_claims: ["C"],
  analysis_modules: [{ analysis_id: "analysis-01", name: "Correlation", goal: "G", required_capabilities: ["tabular.numeric_features"], optional_capabilities: [], operations: ["correlate"], expected_outputs: ["matrix"], verification: ["check"], evidence: [{ page: 2, section: "Methods", locator_status: "verified" }] }],
  paper_level_requirements: [], required_capabilities: ["tabular.numeric_features"], expected_outputs: ["report"], verification: ["reproduce"], evidence: [], display_tags: ["Tabular"],
};

const DATASET_PROFILE = {
  profile_version: "dataset-profile-v1",
  model_version: "test-inspector",
  provenance: { collection_id: "collection-1", inspector_version: "test-inspector-v1", generated_at: "2026-09-11T00:00:00Z" },
  collection_id: "collection-1", domain_hint: "test", files: [], capabilities: { "tabular.numeric_features": true },
  semantic_fields: { target: null, feature_names: ["x"] }, display_tags: ["Tabular"],
};

describe("Discovery Processor control protocol", () => {
  it("keeps a below-threshold evaluation in review and acknowledges an identical retry after fencing clears the lease", async () => {
    const { env, db } = makeEnv();
    env.RESOURCE_BUCKET = new MemoryBucket() as unknown as Env["RESOURCE_BUCKET"];
    env.DISCOVERY_PROCESSOR_ID = "discovery-processor-1";
    env.DISCOVERY_PROCESSOR_SHARED_SECRET = "discovery-bootstrap-secret";
    const sourceHeaders = { "content-type": "application/json", "cf-connecting-ip": "203.0.113.11" };
    const connected = await handleDiscoveryProcessorApi(processorRequest("/api/discovery-processor/connect", {
      method: "POST",
      headers: { ...sourceHeaders, "x-discovery-processor-id": "discovery-processor-1", "x-discovery-processor-token": "discovery-bootstrap-secret" },
      body: JSON.stringify({ instance_id: "instance-1" }),
    }), env);
    expect(connected?.status).toBe(200);
    const session = await connected!.json() as { processor_session_id: string; processor_session_token: string };
    const leaseToken = "lease-token-for-evaluation-123456";
    const now = Math.floor(Date.now() / 1000);
    db.paperCatalog.set("paper-1", {
      paper_id: "paper-1", owner_user_id: null, source_resource_id: "resource-1", visibility: "public", title: "Example paper", authors_json: "[]", year: 2023, venue: "Test venue", status: "profiled", spam_status: "scientific_paper", profile_version: "paper-profile-v1", profile_json: JSON.stringify(PAPER_PROFILE), profile_sha256: "a".repeat(64), profile_object_key: null, overview_object_key: null, created_at: now, updated_at: now,
    });
    db.dataCollections.set("collection-1", {
      collection_id: "collection-1", owner_user_id: "alice", name: "Data", source_object_key: "datasets/collection-1/source/data.csv", source_filename: "data.csv", source_content_type: "text/csv", source_sha256: "b".repeat(64), source_size_bytes: 10, status: "ready", profile_version: "dataset-profile-v1", profile_json: JSON.stringify(DATASET_PROFILE), profile_sha256: "c".repeat(64), profile_object_key: null, error_code: null, error_message_safe: null, created_at: now, updated_at: now,
    });
    db.researchMatches.set("match-1", {
      match_id: "match-1", paper_id: "paper-1", collection_id: "collection-1", paper_profile_version: "paper-profile-v1",
      dataset_profile_version: "dataset-profile-v1", status: "evaluating", hard_gate: "pending", coverage_ratio: 1,
      execution_confidence: null, scientific_fit: null, evaluator_version: null, evaluation_json: null, created_task_id: null,
      candidate_reason: "all capabilities", created_at: now, updated_at: now,
      discovery_lease_owner: session.processor_session_id, discovery_lease_expires_at: now + 300,
      discovery_lease_token_hash: hashText(leaseToken), discovery_fencing_epoch: 1,
    });
    const evaluation = {
      evaluator_version: "feasibility-v1", hard_gate: "pass",
      coverage: { supported_modules: 1, total_modules: 1, ratio: 1 },
      execution_confidence: 59, scientific_fit: 80, missing_requirements: [], risks: [],
      recommended: false, reason: "The compatible input contract needs review.",
    };
    const request = () => processorRequest("/api/discovery-processor/control", {
      method: "POST",
      headers: { ...sourceHeaders, "x-discovery-processor-session": session.processor_session_token, "x-discovery-processor-lease-token": leaseToken },
      body: JSON.stringify({ operation: "save_evaluation", kind: "match", work_id: "match-1", fencing_epoch: 1, evaluation }),
    });
    const first = await handleDiscoveryProcessorApi(request(), env);
    expect(first?.status).toBe(200);
    expect(await first!.json()).toMatchObject({ match_id: "match-1", status: "review", would_create_task: false });
    const retry = await handleDiscoveryProcessorApi(request(), env);
    expect(retry?.status).toBe(200);
    expect(await retry!.json()).toMatchObject({ match_id: "match-1", status: "review", idempotent: true, would_create_task: false });
  });

  it("rejects an evaluator pass that contradicts the current capability profiles", async () => {
    const { env, db } = makeEnv();
    env.RESOURCE_BUCKET = new MemoryBucket() as unknown as Env["RESOURCE_BUCKET"];
    env.DISCOVERY_PROCESSOR_ID = "discovery-processor-1";
    env.DISCOVERY_PROCESSOR_SHARED_SECRET = "discovery-bootstrap-secret";
    const sourceHeaders = { "content-type": "application/json", "cf-connecting-ip": "203.0.113.11" };
    const connected = await handleDiscoveryProcessorApi(processorRequest("/api/discovery-processor/connect", {
      method: "POST",
      headers: { ...sourceHeaders, "x-discovery-processor-id": "discovery-processor-1", "x-discovery-processor-token": "discovery-bootstrap-secret" },
      body: JSON.stringify({ instance_id: "instance-2" }),
    }), env);
    const session = await connected!.json() as { processor_session_id: string; processor_session_token: string };
    const leaseToken = "lease-token-for-mismatch-123456";
    const now = Math.floor(Date.now() / 1000);
    db.paperCatalog.set("paper-1", {
      paper_id: "paper-1", owner_user_id: null, source_resource_id: "resource-1", visibility: "public", title: "Example paper", authors_json: "[]", year: 2023, venue: "Test venue", status: "profiled", spam_status: "scientific_paper", profile_version: "paper-profile-v1", profile_json: JSON.stringify(PAPER_PROFILE), profile_sha256: "a".repeat(64), profile_object_key: null, overview_object_key: null, created_at: now, updated_at: now,
    });
    db.dataCollections.set("collection-1", {
      collection_id: "collection-1", owner_user_id: "alice", name: "Data", source_object_key: "datasets/collection-1/source/data.csv", source_filename: "data.csv", source_content_type: "text/csv", source_sha256: "b".repeat(64), source_size_bytes: 10, status: "ready", profile_version: "dataset-profile-v1", profile_json: JSON.stringify({ ...DATASET_PROFILE, capabilities: {} }), profile_sha256: "c".repeat(64), profile_object_key: null, error_code: null, error_message_safe: null, created_at: now, updated_at: now,
    });
    db.researchMatches.set("match-1", {
      match_id: "match-1", paper_id: "paper-1", collection_id: "collection-1", paper_profile_version: "paper-profile-v1", dataset_profile_version: "dataset-profile-v1", status: "evaluating", hard_gate: "pending", coverage_ratio: 1, execution_confidence: null, scientific_fit: null, evaluator_version: null, evaluation_json: null, created_task_id: null, candidate_reason: "all capabilities", created_at: now, updated_at: now, discovery_lease_owner: session.processor_session_id, discovery_lease_expires_at: now + 300, discovery_lease_token_hash: hashText(leaseToken), discovery_fencing_epoch: 1,
    });
    const evaluation = {
      evaluator_version: "feasibility-v1", hard_gate: "pass", coverage: { supported_modules: 1, total_modules: 1, ratio: 1 }, execution_confidence: 80, scientific_fit: 80, missing_requirements: [], risks: [], recommended: true, reason: "not actually supported",
    };
    const response = await handleDiscoveryProcessorApi(processorRequest("/api/discovery-processor/control", {
      method: "POST",
      headers: { ...sourceHeaders, "x-discovery-processor-session": session.processor_session_token, "x-discovery-processor-lease-token": leaseToken },
      body: JSON.stringify({ operation: "save_evaluation", kind: "match", work_id: "match-1", fencing_epoch: 1, evaluation }),
    }), env);
    expect(response?.status).toBe(409);
    expect(await response!.json()).toMatchObject({ error: { code: "DISCOVERY_EVALUATION_COVERAGE_MISMATCH" } });
    expect(db.researchMatches.get("match-1")?.status).toBe("evaluating");
  });
});
