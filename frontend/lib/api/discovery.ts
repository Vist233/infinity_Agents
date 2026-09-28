import { getApiBase, withCsrfHeader } from "@/lib/runtime-config";

export const MAX_DISCOVERY_PAPER_BYTES = 64 * 1024 * 1024;
export const MAX_DISCOVERY_COLLECTION_BYTES = 25 * 1024 * 1024;

export type PaperStatus = "requested" | "processing" | "profiled" | "failed" | "deleted";
export type SpamStatus = "pending" | "scientific_paper" | "non_paper" | "spam" | "invalid" | "review";
export type CollectionStatus = "uploaded" | "inspecting" | "ready" | "failed" | "deleted";
export type MatchStatus = "candidate" | "evaluating" | "evaluated" | "review" | "rejected" | "task_created" | "failed";
export type HardGate = "pending" | "pass" | "fail" | "review";

export interface PaperEvidence {
  page: number | null;
  section: string | null;
  quote?: string | null;
  locator_status: "verified" | "unknown" | "review";
}

export interface AnalysisModule {
  analysis_id: string;
  name: string;
  goal: string;
  required_capabilities: string[];
  optional_capabilities: string[];
  operations: string[];
  expected_outputs: string[];
  verification: string[];
  evidence: PaperEvidence[];
}

export interface PaperProfile {
  profile_version: "paper-profile-v1";
  model_version: string;
  provenance: {
    source_resource_id: string;
    compiler_version: string;
    generated_at: string;
    input_sha256?: string | null;
  };
  paper: {
    title: string;
    authors: string[];
    year: number | null;
    venue: string | null;
    abstract: string;
    research_question: string;
    main_claims: string[];
  };
  research_question: string;
  main_claims: string[];
  analysis_modules: AnalysisModule[];
  paper_level_requirements: string[];
  required_capabilities: string[];
  expected_outputs: string[];
  verification: string[];
  evidence: PaperEvidence[];
  display_tags: string[];
}

export interface DatasetFileProfile {
  path: string;
  format: "csv" | "tsv" | "json" | "txt" | "readme" | "unknown";
  size_bytes: number;
  sha256: string;
  rows: number | null;
  columns: number | null;
  column_names: string[];
  data_types: Record<string, "numeric" | "categorical" | "text" | "boolean" | "unknown">;
  missing_ratio: number | null;
  sample: Array<Record<string, unknown>>;
}

export interface DatasetProfile {
  profile_version: "dataset-profile-v1";
  model_version: string;
  provenance: { collection_id: string; inspector_version: string; generated_at: string };
  collection_id: string;
  domain_hint: string | null;
  files: DatasetFileProfile[];
  capabilities: Record<string, unknown>;
  semantic_fields: { target: string | null; feature_names: string[] };
  display_tags: string[];
}

export interface DiscoveryPaper {
  paper_id: string;
  visibility: "private" | "public";
  title: string;
  authors: string[];
  year: number | null;
  venue: string | null;
  status: PaperStatus;
  spam_status: SpamStatus;
  profile_version: string | null;
  profile: PaperProfile | null;
  overview: string | null;
  source_status: string;
  source_resource_id?: string;
  source_filename?: string;
  duplicate?: boolean;
  created_at: number;
  updated_at: number;
}

export interface DiscoveryCollection {
  collection_id: string;
  name: string;
  source_filename: string;
  source_content_type: string;
  source_size_bytes: number;
  status: CollectionStatus;
  profile_version: string | null;
  profile: DatasetProfile | null;
  error: { code: string; message: string } | null;
  duplicate?: boolean;
  created_at: number;
  updated_at: number;
}

export interface DiscoveryMatch {
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

export interface DiscoveryApiError extends Error {
  status?: number;
  code?: string;
}

function makeError(message: string, status?: number, code?: string): DiscoveryApiError {
  const error = new Error(message) as DiscoveryApiError;
  error.status = status;
  error.code = code;
  return error;
}

async function responseError(response: Response): Promise<DiscoveryApiError> {
  let message = `Request failed (${response.status})`;
  let code: string | undefined;
  try {
    const payload = await response.json() as { error?: { message?: unknown; code?: unknown }; detail?: unknown };
    const candidate = payload.error?.message ?? payload.detail;
    if (typeof candidate === "string" && candidate.trim()) message = candidate;
    if (typeof payload.error?.code === "string") code = payload.error.code;
  } catch {
    // Keep a stable status error for non-JSON responses.
  }
  return makeError(message, response.status, code);
}

async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${getApiBase()}${path}`, {
      ...init,
      credentials: "include",
      headers: withCsrfHeader(init.headers),
    });
  } catch (error) {
    throw makeError(`Network request failed: ${error instanceof Error ? error.message : "unknown error"}`, undefined, "network_error");
  }
  if (!response.ok) throw await responseError(response);
  try {
    return await response.json() as T;
  } catch {
    throw makeError("Discovery API returned invalid JSON", response.status, "invalid_json");
  }
}

export async function listPapers(): Promise<DiscoveryPaper[]> {
  const payload = await requestJson<{ papers?: DiscoveryPaper[] }>("/api/discovery/papers");
  return Array.isArray(payload.papers) ? payload.papers : [];
}

export async function getPaper(paperId: string): Promise<DiscoveryPaper> {
  return requestJson<DiscoveryPaper>(`/api/discovery/papers/${encodeURIComponent(paperId)}`);
}

export async function uploadPaper(file: File, title?: string): Promise<DiscoveryPaper> {
  if (file.size <= 0 || file.size > MAX_DISCOVERY_PAPER_BYTES) throw makeError("Paper PDF exceeds the 64 MB limit", 413, "DISCOVERY_PAPER_TOO_LARGE");
  const form = new FormData();
  form.set("file", file);
  if (title?.trim()) form.set("title", title.trim());
  return requestJson<DiscoveryPaper>("/api/discovery/papers", { method: "POST", body: form });
}

export async function deletePaper(paperId: string): Promise<{ paper_id: string; status: "deleted" }> {
  return requestJson(`/api/discovery/papers/${encodeURIComponent(paperId)}`, { method: "DELETE" });
}

export async function listCollections(): Promise<DiscoveryCollection[]> {
  const payload = await requestJson<{ collections?: DiscoveryCollection[] }>("/api/discovery/data-collections");
  return Array.isArray(payload.collections) ? payload.collections : [];
}

export async function getCollection(collectionId: string): Promise<DiscoveryCollection> {
  return requestJson<DiscoveryCollection>(`/api/discovery/data-collections/${encodeURIComponent(collectionId)}`);
}

export async function uploadCollection(file: File, name?: string): Promise<DiscoveryCollection> {
  if (file.size <= 0 || file.size > MAX_DISCOVERY_COLLECTION_BYTES) throw makeError("Data Collection exceeds the 25 MB limit", 413, "DISCOVERY_COLLECTION_TOO_LARGE");
  const form = new FormData();
  form.set("file", file);
  if (name?.trim()) form.set("name", name.trim());
  return requestJson<DiscoveryCollection>("/api/discovery/data-collections", { method: "POST", body: form });
}

export async function deleteCollection(collectionId: string): Promise<{ collection_id: string; status: "deleted" }> {
  return requestJson(`/api/discovery/data-collections/${encodeURIComponent(collectionId)}`, { method: "DELETE" });
}

export async function listMatches(): Promise<DiscoveryMatch[]> {
  const payload = await requestJson<{ matches?: DiscoveryMatch[] }>("/api/discovery/matches");
  return Array.isArray(payload.matches) ? payload.matches : [];
}

export async function getMatch(matchId: string): Promise<DiscoveryMatch> {
  const payload = await requestJson<{ match?: DiscoveryMatch }>(`/api/discovery/matches/${encodeURIComponent(matchId)}`);
  if (!payload.match) throw makeError("Research match was not found", 404, "DISCOVERY_MATCH_NOT_FOUND");
  return payload.match;
}

export async function requestMatchEvaluation(matchId: string): Promise<{
  match_id: string;
  status: MatchStatus;
  queued: boolean;
  evaluation: unknown;
}> {
  return requestJson(`/api/discovery/matches/${encodeURIComponent(matchId)}/evaluate`, { method: "POST" });
}

export async function createTaskFromMatch(matchId: string): Promise<{
  match_id: string;
  task_id: string;
  status: "task_created";
  duplicate: boolean;
}> {
  return requestJson(`/api/discovery/matches/${encodeURIComponent(matchId)}/create-task`, { method: "POST" });
}
