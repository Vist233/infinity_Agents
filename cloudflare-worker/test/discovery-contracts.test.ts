import { describe, expect, it } from "vitest";
import {
  coarseMatch,
  normalizeDatasetProfile,
  normalizeFeasibilityEvaluation,
  normalizePaperProfile,
  paperEvidenceStatus,
  passesAutomaticThreshold,
} from "../src/discovery-contracts";

const profile = {
  profile_version: "paper-profile-v1",
  model_version: "kimi-k2.6",
  provenance: { source_resource_id: "paper-1", compiler_version: "discovery-compiler-v1", generated_at: "2026-09-11T00:00:00Z" },
  paper: { title: "Example paper", authors: ["A"], year: 2023, venue: "arXiv", abstract: "Abstract", research_question: "Q", main_claims: ["C"] },
  research_question: "Q",
  main_claims: ["C"],
  analysis_modules: [
    { analysis_id: "analysis-01", name: "Correlation", goal: "G", required_capabilities: ["tabular.numeric_features"], optional_capabilities: [], operations: ["correlate"], expected_outputs: ["matrix"], verification: ["check"], evidence: [{ page: 2, section: "3.1", locator_status: "verified" }] },
    { analysis_id: "analysis-02", name: "Target", goal: "G", required_capabilities: ["target.ordinal_or_numeric"], optional_capabilities: [], operations: ["fit"], expected_outputs: ["score"], verification: ["check"], evidence: [{ page: null, section: null, locator_status: "review" }] },
  ],
  paper_level_requirements: [], required_capabilities: ["tabular.numeric_features"], expected_outputs: ["report"], verification: ["reproduce"], evidence: [], display_tags: ["Tabular"],
};

const dataset = {
  profile_version: "dataset-profile-v1",
  model_version: "deterministic-inspector-v1",
  provenance: { collection_id: "collection-1", inspector_version: "dataset-inspector-v1", generated_at: "2026-09-11T00:00:00Z" },
  collection_id: "collection-1", domain_hint: "machine_learning", files: [], capabilities: { "tabular.numeric_features": true, "target.ordinal_or_numeric": true }, semantic_fields: { target: "quality", feature_names: ["x"] }, display_tags: ["Tabular"],
};

describe("Discovery contracts", () => {
  it("accepts a versioned profile and computes capability coverage", () => {
    const paper = normalizePaperProfile(profile);
    const data = normalizeDatasetProfile(dataset, "collection-1");
    expect(paper).not.toBeNull();
    expect(data).not.toBeNull();
    expect(coarseMatch(paper!, data!)).toMatchObject({ supported_modules: 2, total_modules: 2, coverage_ratio: 1 });
  });

  it("rejects malformed provenance, invalid keys, and mismatched collection ids", () => {
    expect(normalizePaperProfile({ ...profile, profile_version: "paper-profile-v2" })).toBeNull();
    expect(normalizePaperProfile({ ...profile, provenance: { ...profile.provenance, source_resource_id: "" } })).toBeNull();
    expect(normalizePaperProfile({
      ...profile,
      analysis_modules: [{ ...profile.analysis_modules[0], analysis_id: "analysis-02" }, profile.analysis_modules[1]],
    })).toBeNull();
    expect(normalizeDatasetProfile({ ...dataset, capabilities: { "../secret": true } }, "collection-1")).toBeNull();
    expect(normalizeDatasetProfile({ ...dataset, domain_hint: 42 }, "collection-1")).toBeNull();
    expect(normalizeDatasetProfile(dataset, "other-collection")).toBeNull();
  });

  it("rejects malformed samples, preserves data-type keys safely, and bounds capabilities", () => {
    const file = {
      path: "data.csv", format: "csv", size_bytes: 1, sha256: "a".repeat(64), rows: 1, columns: 1,
      column_names: ["x"], data_types: JSON.parse('{"__proto__":"numeric","x":"numeric"}'),
      missing_ratio: 0, sample: [{ x: 1 }, null],
    };
    expect(normalizeDatasetProfile({ ...dataset, files: [file] }, "collection-1")).toBeNull();

    const normalized = normalizeDatasetProfile({ ...dataset, files: [{ ...file, sample: [{ x: 1 }] }] }, "collection-1");
    expect(normalized).not.toBeNull();
    expect(Object.getPrototypeOf(normalized!.files[0].data_types)).toBeNull();
    expect(normalized!.files[0].data_types).toHaveProperty("__proto__", "numeric");

    const tooManyCapabilities = Object.fromEntries(Array.from({ length: 513 }, (_, index) => [`capability-${index}`, true]));
    expect(normalizeDatasetProfile({ ...dataset, capabilities: tooManyCapabilities }, "collection-1")).toBeNull();
  });

  it("requires located evidence before a paper can enter the matching catalog", () => {
    const paper = normalizePaperProfile(profile)!;
    expect(paperEvidenceStatus(paper)).toBe("review");
    const verified = normalizePaperProfile({
      ...profile,
      evidence: [{ page: 1, section: "Abstract", locator_status: "verified" }],
      analysis_modules: profile.analysis_modules.map((module) => ({
        ...module,
        evidence: [{ page: 2, section: "Methods", locator_status: "verified" }],
      })),
    });
    expect(verified && paperEvidenceStatus(verified)).toBe("scientific_paper");
  });

  it("validates evaluator output and enforces the exact threshold", () => {
    const evaluation = normalizeFeasibilityEvaluation({ evaluator_version: "feasibility-v1", hard_gate: "pass", coverage: { supported_modules: 1, total_modules: 1, ratio: 1 }, execution_confidence: 60, scientific_fit: 60, missing_requirements: [], risks: [], recommended: true, reason: "ready" });
    expect(evaluation?.execution_confidence).toBe(60);
    expect(passesAutomaticThreshold("pass", 0.6, 60, true)).toBe(true);
    expect(passesAutomaticThreshold("pass", 0.6, 59, true)).toBe(false);
    expect(passesAutomaticThreshold("fail", 1, 99, true)).toBe(false);
    expect(passesAutomaticThreshold("pass", 1, 99, false)).toBe(false);
  });
});
