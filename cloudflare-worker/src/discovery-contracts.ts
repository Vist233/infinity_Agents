/** Versioned, bounded contracts shared by the Discovery API and processor. */

export const PAPER_PROFILE_VERSION = "paper-profile-v1" as const;
export const DATASET_PROFILE_VERSION = "dataset-profile-v1" as const;
export const FEASIBILITY_EVALUATOR_VERSION = "feasibility-v1" as const;
export const PUBLICATION_EVALUATOR_VERSION = "pub-ready-v1" as const;

export const CAPABILITY_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
export const SAFE_DISCOVERY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/;

export type RequirementKind = "required" | "optional";
export type PaperCatalogStatus = "requested" | "processing" | "profiled" | "failed" | "deleted";
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
  profile_version: typeof PAPER_PROFILE_VERSION;
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
  profile_version: typeof DATASET_PROFILE_VERSION;
  model_version: string;
  provenance: {
    collection_id: string;
    inspector_version: string;
    generated_at: string;
  };
  collection_id: string;
  domain_hint: string | null;
  files: DatasetFileProfile[];
  capabilities: Record<string, unknown>;
  semantic_fields: {
    target: string | null;
    feature_names: string[];
  };
  display_tags: string[];
}

export interface CoarseMatch {
  coverage_ratio: number;
  supported_modules: number;
  total_modules: number;
  missing_required: Array<{ analysis_id: string; capability_key: string }>;
  candidate_reason: string;
}

export interface FeasibilityEvaluation {
  evaluator_version: typeof FEASIBILITY_EVALUATOR_VERSION;
  hard_gate: Exclude<HardGate, "pending">;
  coverage: {
    supported_modules: number;
    total_modules: number;
    ratio: number;
  };
  execution_confidence: number;
  scientific_fit: number;
  missing_requirements: string[];
  risks: string[];
  recommended: boolean;
  reason: string;
  provenance?: {
    model_version: string;
    generated_at: string;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown, max: number, allowEmpty = false): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!allowEmpty && !trimmed) return null;
  return trimmed.length <= max ? trimmed : null;
}

function stringArray(value: unknown, maxItems: number, maxItemLength: number): string[] | null {
  if (!Array.isArray(value) || value.length > maxItems) return null;
  const output: string[] = [];
  for (const item of value) {
    const normalized = stringValue(item, maxItemLength);
    if (!normalized) return null;
    output.push(normalized);
  }
  return output;
}

function capabilityArray(value: unknown): string[] | null {
  const values = stringArray(value, 128, 128);
  return values && values.every((item) => CAPABILITY_KEY_PATTERN.test(item)) ? [...new Set(values)] : null;
}

function evidenceArray(value: unknown): PaperEvidence[] | null {
  if (!Array.isArray(value) || value.length > 128) return null;
  const result: PaperEvidence[] = [];
  for (const item of value) {
    if (!isRecord(item)) return null;
    const pageValue = item.page;
    const page = pageValue === null || pageValue === undefined
      ? null
      : typeof pageValue === "number" && Number.isSafeInteger(pageValue) && pageValue > 0 && pageValue <= 10000 ? pageValue : null;
    if (pageValue !== null && pageValue !== undefined && page === null) return null;
    const section = item.section === null || item.section === undefined ? null : stringValue(item.section, 512);
    if (item.section !== null && item.section !== undefined && !section) return null;
    const quote = item.quote === null || item.quote === undefined ? null : stringValue(item.quote, 2_000, true);
    if (item.quote !== null && item.quote !== undefined && quote === null) return null;
    const locator = item.locator_status;
    const locatorStatus = locator === "verified" || locator === "unknown" || locator === "review"
      ? locator
      : page !== null || section !== null ? "verified" : "review";
    if (page === null && section === null && locatorStatus === "verified") return null;
    result.push({ page, section, quote, locator_status: locatorStatus });
  }
  return result;
}

function analysisModule(value: unknown, index: number): AnalysisModule | null {
  if (!isRecord(value)) return null;
  const analysisId = stringValue(value.analysis_id, 128);
  const name = stringValue(value.name, 255);
  const goal = stringValue(value.goal, 4_096, true);
  const required = capabilityArray(value.required_capabilities);
  const optional = capabilityArray(value.optional_capabilities);
  const operations = stringArray(value.operations, 64, 512);
  const expected = stringArray(value.expected_outputs, 64, 512);
  const verification = stringArray(value.verification, 64, 512);
  const evidence = evidenceArray(value.evidence);
  if (!analysisId || !name || goal === null || !required || !optional || !operations || !expected || !verification || !evidence) return null;
  const expectedId = `analysis-${String(index + 1).padStart(2, "0")}`;
  if (analysisId !== expectedId && !/^analysis-[A-Za-z0-9][A-Za-z0-9._:-]{0,120}$/.test(analysisId)) return null;
  return { analysis_id: analysisId, name, goal, required_capabilities: required, optional_capabilities: optional, operations, expected_outputs: expected, verification, evidence };
}

/** Validate and copy only the versioned Paper Profile fields. */
export function normalizePaperProfile(value: unknown): PaperProfile | null {
  if (!isRecord(value) || value.profile_version !== PAPER_PROFILE_VERSION) return null;
  const paper = isRecord(value.paper) ? value.paper : null;
  const paperTitle = stringValue(paper?.title, 512);
  const authors = stringArray(paper?.authors, 128, 255);
  const abstract = stringValue(paper?.abstract, 20_000, true);
  const paperQuestion = stringValue(paper?.research_question, 4_096, true);
  const paperClaims = stringArray(paper?.main_claims, 128, 2_000);
  const researchQuestion = stringValue(value.research_question, 4_096, true);
  const mainClaims = stringArray(value.main_claims, 128, 2_000);
  const modulesRaw = Array.isArray(value.analysis_modules) ? value.analysis_modules : null;
  const modules = modulesRaw?.map((item, index) => analysisModule(item, index)) ?? null;
  const paperRequirements = capabilityArray(value.paper_level_requirements);
  const requiredCapabilities = capabilityArray(value.required_capabilities);
  const expectedOutputs = stringArray(value.expected_outputs, 128, 512);
  const verification = stringArray(value.verification, 128, 512);
  const evidence = evidenceArray(value.evidence);
  const displayTags = stringArray(value.display_tags, 64, 128);
  const modelVersion = stringValue(value.model_version, 128);
  const provenanceValue = isRecord(value.provenance) ? value.provenance : null;
  const sourceResourceId = stringValue(provenanceValue?.source_resource_id, 255);
  const compilerVersion = stringValue(provenanceValue?.compiler_version, 128);
  const generatedAt = stringValue(provenanceValue?.generated_at, 128);
  const inputSha = provenanceValue?.input_sha256 === null || provenanceValue?.input_sha256 === undefined
    ? null : stringValue(provenanceValue.input_sha256, 64);
  const yearValue = paper?.year;
  const year = yearValue === null || yearValue === undefined ? null : typeof yearValue === "number" && Number.isSafeInteger(yearValue) && yearValue >= 1800 && yearValue <= 2200 ? yearValue : null;
  const venue = paper?.venue === null || paper?.venue === undefined ? null : stringValue(paper.venue, 512);
  if (!paper || !paperTitle || !authors || abstract === null || paperQuestion === null || !paperClaims
    || !researchQuestion || !mainClaims || !modules || modules.length === 0 || modules.length > 64 || modules.some((item) => !item)
    || !paperRequirements || !requiredCapabilities || !expectedOutputs || !verification || !evidence || !displayTags
    || !modelVersion || !sourceResourceId || !compilerVersion || !generatedAt || (provenanceValue?.input_sha256 !== null && provenanceValue?.input_sha256 !== undefined && !inputSha)
    || (yearValue !== null && yearValue !== undefined && year === null) || (paper?.venue !== null && paper?.venue !== undefined && !venue)) return null;
  return {
    profile_version: PAPER_PROFILE_VERSION,
    model_version: modelVersion,
    provenance: { source_resource_id: sourceResourceId, compiler_version: compilerVersion, generated_at: generatedAt, input_sha256: inputSha },
    paper: { title: paperTitle, authors, year, venue, abstract, research_question: paperQuestion, main_claims: paperClaims },
    research_question: researchQuestion,
    main_claims: mainClaims,
    analysis_modules: modules as AnalysisModule[],
    paper_level_requirements: paperRequirements,
    required_capabilities: requiredCapabilities,
    expected_outputs: expectedOutputs,
    verification,
    evidence,
    display_tags: displayTags,
  };
}

function datasetFile(value: unknown): DatasetFileProfile | null {
  if (!isRecord(value)) return null;
  const path = stringValue(value.path, 512);
  const format = value.format;
  const allowedFormats = new Set(["csv", "tsv", "json", "txt", "readme", "unknown"]);
  const size = value.size_bytes;
  const sha = stringValue(value.sha256, 64);
  const rows = value.rows === null || value.rows === undefined ? null : typeof value.rows === "number" && Number.isSafeInteger(value.rows) && value.rows >= 0 ? value.rows : null;
  const columns = value.columns === null || value.columns === undefined ? null : typeof value.columns === "number" && Number.isSafeInteger(value.columns) && value.columns >= 0 ? value.columns : null;
  const names = stringArray(value.column_names, 10_000, 512);
  const dataTypesValue = value.data_types;
  const dataTypes: DatasetFileProfile["data_types"] = {};
  if (!isRecord(dataTypesValue) || Object.keys(dataTypesValue).length > 10_000) return null;
  for (const [key, dataType] of Object.entries(dataTypesValue)) {
    if (key.length > 512 || !(dataType === "numeric" || dataType === "categorical" || dataType === "text" || dataType === "boolean" || dataType === "unknown")) return null;
    dataTypes[key] = dataType;
  }
  const missing = value.missing_ratio === null || value.missing_ratio === undefined ? null : typeof value.missing_ratio === "number" && Number.isFinite(value.missing_ratio) && value.missing_ratio >= 0 && value.missing_ratio <= 1 ? value.missing_ratio : null;
  const sample = Array.isArray(value.sample) && value.sample.length <= 100 ? value.sample.filter(isRecord).slice(0, 100) : null;
  if (!path || !allowedFormats.has(String(format)) || typeof size !== "number" || !Number.isSafeInteger(size) || size < 0 || !sha || !/^[0-9a-f]{64}$/i.test(sha) || (value.rows !== null && value.rows !== undefined && rows === null) || (value.columns !== null && value.columns !== undefined && columns === null) || !names || !sample || (value.missing_ratio !== null && value.missing_ratio !== undefined && missing === null)) return null;
  return { path, format: format as DatasetFileProfile["format"], size_bytes: size, sha256: sha.toLowerCase(), rows, columns, column_names: names, data_types: dataTypes, missing_ratio: missing, sample };
}

export function normalizeDatasetProfile(value: unknown, expectedCollectionId?: string): DatasetProfile | null {
  if (!isRecord(value) || value.profile_version !== DATASET_PROFILE_VERSION) return null;
  const collectionId = stringValue(value.collection_id, 255);
  if (!collectionId || (expectedCollectionId !== undefined && collectionId !== expectedCollectionId)) return null;
  const modelVersion = stringValue(value.model_version, 128);
  const provenance = isRecord(value.provenance) ? value.provenance : null;
  const inspectorVersion = stringValue(provenance?.inspector_version, 128);
  const generatedAt = stringValue(provenance?.generated_at, 128);
  if (provenance?.collection_id !== collectionId || !modelVersion || !inspectorVersion || !generatedAt) return null;
  const filesRaw = Array.isArray(value.files) ? value.files : null;
  const files = filesRaw?.map(datasetFile) ?? null;
  const capabilitiesValue = isRecord(value.capabilities) ? value.capabilities : null;
  const capabilities: Record<string, unknown> | null = capabilitiesValue && Object.keys(capabilitiesValue).length <= 512
    && Object.keys(capabilitiesValue).every((key) => CAPABILITY_KEY_PATTERN.test(key))
    ? Object.fromEntries(Object.entries(capabilitiesValue).slice(0, 512))
    : null;
  const semantic = isRecord(value.semantic_fields) ? value.semantic_fields : null;
  const target = semantic?.target === null || semantic?.target === undefined ? null : stringValue(semantic.target, 512);
  const featureNames = stringArray(semantic?.feature_names, 10_000, 512);
  const tags = stringArray(value.display_tags, 128, 128);
  const domainHint = value.domain_hint === null || value.domain_hint === undefined ? null : stringValue(value.domain_hint, 255);
  if (!files || files.length > 256 || files.some((item) => !item) || !capabilities || !semantic || (semantic.target !== null && semantic.target !== undefined && !target) || !featureNames || !tags || (value.domain_hint !== null && value.domain_hint !== undefined && !domainHint)) return null;
  return { profile_version: DATASET_PROFILE_VERSION, model_version: modelVersion, provenance: { collection_id: collectionId, inspector_version: inspectorVersion, generated_at: generatedAt }, collection_id: collectionId, domain_hint: domainHint, files: files as DatasetFileProfile[], capabilities, semantic_fields: { target, feature_names: featureNames }, display_tags: tags };
}

export function normalizeFeasibilityEvaluation(value: unknown): FeasibilityEvaluation | null {
  if (!isRecord(value) || value.evaluator_version !== FEASIBILITY_EVALUATOR_VERSION) return null;
  const hardGate = value.hard_gate;
  if (!(hardGate === "pass" || hardGate === "fail" || hardGate === "review")) return null;
  const coverageValue = isRecord(value.coverage) ? value.coverage : null;
  const supported = coverageValue?.supported_modules;
  const total = coverageValue?.total_modules;
  const ratio = coverageValue?.ratio;
  const numberScore = (candidate: unknown): candidate is number => typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0 && candidate <= 100;
  const missing = stringArray(value.missing_requirements, 256, 512);
  const risks = stringArray(value.risks, 256, 512);
  const reason = stringValue(value.reason, 8_192);
  if (!coverageValue || typeof supported !== "number" || !Number.isSafeInteger(supported) || supported < 0 || typeof total !== "number" || !Number.isSafeInteger(total) || total < 0 || typeof ratio !== "number" || !Number.isFinite(ratio) || ratio < 0 || ratio > 1 || !numberScore(value.execution_confidence) || !numberScore(value.scientific_fit) || !missing || !risks || typeof value.recommended !== "boolean" || !reason) return null;
  const provenance = value.provenance === undefined ? undefined : isRecord(value.provenance) ? { model_version: stringValue(value.provenance.model_version, 128), generated_at: stringValue(value.provenance.generated_at, 128) } : null;
  if (provenance === null || (provenance && (!provenance.model_version || !provenance.generated_at))) return null;
  return { evaluator_version: FEASIBILITY_EVALUATOR_VERSION, hard_gate: hardGate, coverage: { supported_modules: supported, total_modules: total, ratio }, execution_confidence: value.execution_confidence, scientific_fit: value.scientific_fit, missing_requirements: missing, risks, recommended: value.recommended, reason, provenance: provenance as FeasibilityEvaluation["provenance"] };
}

export function isCapabilityAvailable(value: unknown): boolean {
  if (value === false || value === null || value === undefined) return false;
  if (typeof value === "number") return Number.isFinite(value) && value > 0;
  if (typeof value === "string") return value.trim().length > 0 && value.trim().toLowerCase() !== "false";
  return true;
}

export function coarseMatch(profile: PaperProfile, dataset: DatasetProfile): CoarseMatch {
  const missingRequired: CoarseMatch["missing_required"] = [];
  let supported = 0;
  for (const module of profile.analysis_modules) {
    const missing = module.required_capabilities.filter((key) => !isCapabilityAvailable(dataset.capabilities[key]));
    if (missing.length === 0) supported += 1;
    else for (const capabilityKey of missing) missingRequired.push({ analysis_id: module.analysis_id, capability_key: capabilityKey });
  }
  const total = profile.analysis_modules.length;
  const ratio = total === 0 ? 0 : supported / total;
  return { coverage_ratio: ratio, supported_modules: supported, total_modules: total, missing_required: missingRequired, candidate_reason: missingRequired.length === 0 ? "All required analysis capabilities are present." : `${supported}/${total} analysis modules have all required capabilities.` };
}

export function passesAutomaticThreshold(hardGate: HardGate, coverageRatio: number, executionConfidence: number, autoExecute: boolean): boolean {
  return autoExecute && hardGate === "pass" && coverageRatio >= 0.6 && executionConfidence >= 60;
}
