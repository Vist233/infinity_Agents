"""Versioned, bounded JSON contracts for Paper Discovery.

Model output and document metadata are untrusted input. These validators copy
only the fields accepted by the versioned contract and reject malformed or
unbounded values before they can reach D1, R2, or task creation.
"""

from __future__ import annotations

import math
import re
from typing import Any

PAPER_PROFILE_VERSION = "paper-profile-v1"
DATASET_PROFILE_VERSION = "dataset-profile-v1"
FEASIBILITY_EVALUATOR_VERSION = "feasibility-v1"
PUBLICATION_EVALUATOR_VERSION = "pub-ready-v1"
CAPABILITY_KEY_PATTERN = re.compile(r"^[a-z0-9][a-z0-9._-]{0,127}$")


def _record(value: Any) -> dict[str, Any] | None:
    return value if isinstance(value, dict) else None


def _string(value: Any, maximum: int, *, allow_empty: bool = False) -> str | None:
    if not isinstance(value, str):
        return None
    result = value.strip()
    if not allow_empty and not result:
        return None
    return result if len(result) <= maximum else None


def _strings(value: Any, maximum_items: int, maximum_item_length: int) -> list[str] | None:
    if not isinstance(value, list) or len(value) > maximum_items:
        return None
    result: list[str] = []
    for item in value:
        normalized = _string(item, maximum_item_length)
        if normalized is None:
            return None
        result.append(normalized)
    return result


def _capabilities(value: Any) -> list[str] | None:
    values = _strings(value, 128, 128)
    if values is None or any(CAPABILITY_KEY_PATTERN.fullmatch(item) is None for item in values):
        return None
    return list(dict.fromkeys(values))


def _evidence(value: Any) -> list[dict[str, Any]] | None:
    if not isinstance(value, list) or len(value) > 128:
        return None
    result: list[dict[str, Any]] = []
    for item in value:
        record = _record(item)
        if record is None:
            return None
        raw_page = record.get("page")
        page: int | None
        if raw_page is None:
            page = None
        elif isinstance(raw_page, int) and not isinstance(raw_page, bool) and 0 < raw_page <= 10_000:
            page = raw_page
        else:
            return None
        raw_section = record.get("section")
        section = None if raw_section is None else _string(raw_section, 512)
        if raw_section is not None and section is None:
            return None
        raw_quote = record.get("quote")
        quote = None if raw_quote is None else _string(raw_quote, 2_000, allow_empty=True)
        if raw_quote is not None and quote is None:
            return None
        locator = record.get("locator_status")
        if locator not in {"verified", "unknown", "review"}:
            locator = "verified" if page is not None or section is not None else "review"
        if page is None and section is None and locator == "verified":
            return None
        result.append({"page": page, "section": section, "quote": quote, "locator_status": locator})
    return result


def _analysis_module(value: Any, index: int) -> dict[str, Any] | None:
    record = _record(value)
    if record is None:
        return None
    analysis_id = _string(record.get("analysis_id"), 128)
    name = _string(record.get("name"), 255)
    goal = _string(record.get("goal"), 4_096, allow_empty=True)
    required = _capabilities(record.get("required_capabilities"))
    optional = _capabilities(record.get("optional_capabilities"))
    operations = _strings(record.get("operations"), 64, 512)
    expected = _strings(record.get("expected_outputs"), 64, 512)
    verification = _strings(record.get("verification"), 64, 512)
    evidence = _evidence(record.get("evidence"))
    if any(item is None for item in (analysis_id, name, goal, required, optional, operations, expected, verification, evidence)):
        return None
    assert analysis_id is not None and name is not None and goal is not None
    if index == 0:
        if analysis_id != "analysis-01":
            return None
    elif re.fullmatch(r"analysis-[A-Za-z0-9][A-Za-z0-9._:-]{0,120}", analysis_id) is None:
        return None
    return {
        "analysis_id": analysis_id,
        "name": name,
        "goal": goal,
        "required_capabilities": required,
        "optional_capabilities": optional,
        "operations": operations,
        "expected_outputs": expected,
        "verification": verification,
        "evidence": evidence,
    }


def normalize_paper_profile(value: Any) -> dict[str, Any] | None:
    record = _record(value)
    if record is None or record.get("profile_version") != PAPER_PROFILE_VERSION:
        return None
    paper = _record(record.get("paper"))
    provenance = _record(record.get("provenance"))
    if paper is None or provenance is None:
        return None
    title = _string(paper.get("title"), 512)
    authors = _strings(paper.get("authors"), 128, 255)
    abstract = _string(paper.get("abstract"), 20_000, allow_empty=True)
    paper_question = _string(paper.get("research_question"), 4_096, allow_empty=True)
    paper_claims = _strings(paper.get("main_claims"), 128, 2_000)
    question = _string(record.get("research_question"), 4_096, allow_empty=True)
    claims = _strings(record.get("main_claims"), 128, 2_000)
    modules_raw = record.get("analysis_modules")
    modules = None if not isinstance(modules_raw, list) else [_analysis_module(item, index) for index, item in enumerate(modules_raw)]
    paper_requirements = _capabilities(record.get("paper_level_requirements"))
    required = _capabilities(record.get("required_capabilities"))
    expected = _strings(record.get("expected_outputs"), 128, 512)
    verification = _strings(record.get("verification"), 128, 512)
    evidence = _evidence(record.get("evidence"))
    tags = _strings(record.get("display_tags"), 64, 128)
    model_version = _string(record.get("model_version"), 128)
    source_id = _string(provenance.get("source_resource_id"), 255)
    compiler = _string(provenance.get("compiler_version"), 128)
    generated_at = _string(provenance.get("generated_at"), 128)
    input_sha = provenance.get("input_sha256")
    if input_sha is not None:
        input_sha = _string(input_sha, 64)
        if input_sha is None:
            return None
    raw_year = paper.get("year")
    year = None if raw_year is None else raw_year if isinstance(raw_year, int) and not isinstance(raw_year, bool) and 1800 <= raw_year <= 2200 else None
    if raw_year is not None and year is None:
        return None
    raw_venue = paper.get("venue")
    venue = None if raw_venue is None else _string(raw_venue, 512)
    if raw_venue is not None and venue is None:
        return None
    if (
        any(item is None for item in (title, authors, abstract, paper_question, paper_claims, question, claims, paper_requirements,
                                      required, expected, verification, evidence, tags, model_version, source_id, compiler, generated_at))
        or not modules or len(modules) > 64 or any(item is None for item in modules)
    ):
        return None
    assert title is not None and authors is not None and abstract is not None and paper_question is not None
    assert paper_claims is not None and question is not None and claims is not None and paper_requirements is not None
    assert required is not None and expected is not None and verification is not None and evidence is not None
    assert tags is not None and model_version is not None and source_id is not None and compiler is not None and generated_at is not None
    return {
        "profile_version": PAPER_PROFILE_VERSION,
        "model_version": model_version,
        "provenance": {"source_resource_id": source_id, "compiler_version": compiler, "generated_at": generated_at, "input_sha256": input_sha},
        "paper": {"title": title, "authors": authors, "year": year, "venue": venue, "abstract": abstract, "research_question": paper_question, "main_claims": paper_claims},
        "research_question": question,
        "main_claims": claims,
        "analysis_modules": modules,
        "paper_level_requirements": paper_requirements,
        "required_capabilities": required,
        "expected_outputs": expected,
        "verification": verification,
        "evidence": evidence,
        "display_tags": tags,
    }


_DATA_FORMATS = {"csv", "tsv", "json", "txt", "readme", "unknown"}
_DATA_TYPES = {"numeric", "categorical", "text", "boolean", "unknown"}


def _finite_ratio(value: Any) -> float | None:
    if value is None:
        return None
    if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(float(value)) and 0 <= float(value) <= 1:
        return float(value)
    return None


def _dataset_file(value: Any) -> dict[str, Any] | None:
    record = _record(value)
    if record is None:
        return None
    path = _string(record.get("path"), 512)
    file_format = record.get("format")
    size = record.get("size_bytes")
    sha = _string(record.get("sha256"), 64)
    rows = record.get("rows")
    columns = record.get("columns")
    names = _strings(record.get("column_names"), 10_000, 512)
    data_types_value = _record(record.get("data_types"))
    sample_value = record.get("sample")
    if rows is not None and (not isinstance(rows, int) or isinstance(rows, bool) or rows < 0):
        return None
    if columns is not None and (not isinstance(columns, int) or isinstance(columns, bool) or columns < 0):
        return None
    if not isinstance(size, int) or isinstance(size, bool) or size < 0:
        return None
    if not path or file_format not in _DATA_FORMATS or sha is None or re.fullmatch(r"[0-9a-fA-F]{64}", sha) is None or names is None or data_types_value is None:
        return None
    if not isinstance(sample_value, list) or len(sample_value) > 100 or any(not isinstance(item, dict) for item in sample_value):
        return None
    if len(data_types_value) > 10_000 or any(len(key) > 512 or value not in _DATA_TYPES for key, value in data_types_value.items()):
        return None
    missing_raw = record.get("missing_ratio")
    missing_ratio = _finite_ratio(missing_raw)
    if missing_raw is not None and missing_ratio is None:
        return None
    return {
        "path": path,
        "format": file_format,
        "size_bytes": size,
        "sha256": sha.lower(),
        "rows": rows,
        "columns": columns,
        "column_names": names,
        "data_types": dict(data_types_value),
        "missing_ratio": missing_ratio,
        "sample": [dict(item) for item in sample_value],
    }


def normalize_dataset_profile(value: Any, expected_collection_id: str | None = None) -> dict[str, Any] | None:
    record = _record(value)
    if record is None or record.get("profile_version") != DATASET_PROFILE_VERSION:
        return None
    collection_id = _string(record.get("collection_id"), 255)
    provenance = _record(record.get("provenance"))
    if collection_id is None or (expected_collection_id is not None and collection_id != expected_collection_id) or provenance is None:
        return None
    if provenance.get("collection_id") != collection_id:
        return None
    model_version = _string(record.get("model_version"), 128)
    inspector = _string(provenance.get("inspector_version"), 128)
    generated_at = _string(provenance.get("generated_at"), 128)
    files_raw = record.get("files")
    files = None if not isinstance(files_raw, list) else [_dataset_file(item) for item in files_raw]
    capabilities_value = _record(record.get("capabilities"))
    semantic = _record(record.get("semantic_fields"))
    tags = _strings(record.get("display_tags"), 128, 128)
    domain_raw = record.get("domain_hint")
    domain = None if domain_raw is None else _string(domain_raw, 255)
    target_raw = semantic.get("target") if semantic is not None else None
    target = None if target_raw is None else _string(target_raw, 512)
    features = _strings(semantic.get("feature_names") if semantic is not None else None, 10_000, 512)
    if (
        model_version is None or inspector is None or generated_at is None or files is None or len(files) > 256
        or any(item is None for item in files) or capabilities_value is None or semantic is None or features is None
        or tags is None or (domain_raw is not None and domain is None) or (target_raw is not None and target is None)
        or any(CAPABILITY_KEY_PATTERN.fullmatch(key) is None for key in capabilities_value)
    ):
        return None
    assert domain is not None or domain_raw is None
    assert target is not None or target_raw is None
    return {
        "profile_version": DATASET_PROFILE_VERSION,
        "model_version": model_version,
        "provenance": {"collection_id": collection_id, "inspector_version": inspector, "generated_at": generated_at},
        "collection_id": collection_id,
        "domain_hint": domain,
        "files": files,
        "capabilities": dict(capabilities_value),
        "semantic_fields": {"target": target, "feature_names": features},
        "display_tags": tags,
    }


def normalize_feasibility_evaluation(value: Any) -> dict[str, Any] | None:
    record = _record(value)
    if record is None or record.get("evaluator_version") != FEASIBILITY_EVALUATOR_VERSION:
        return None
    hard_gate = record.get("hard_gate")
    if hard_gate not in {"pass", "fail", "review"}:
        return None
    coverage = _record(record.get("coverage"))
    if coverage is None:
        return None
    supported = coverage.get("supported_modules")
    total = coverage.get("total_modules")
    ratio = coverage.get("ratio")
    def score(candidate: Any) -> bool:
        return isinstance(candidate, int) and not isinstance(candidate, bool) and 0 <= candidate <= 100
    missing = _strings(record.get("missing_requirements"), 256, 512)
    risks = _strings(record.get("risks"), 256, 512)
    reason = _string(record.get("reason"), 8_192)
    if (
        not isinstance(supported, int) or isinstance(supported, bool) or supported < 0
        or not isinstance(total, int) or isinstance(total, bool) or total < 0
        or not isinstance(ratio, (int, float)) or isinstance(ratio, bool) or not math.isfinite(float(ratio)) or not 0 <= float(ratio) <= 1
        or not score(record.get("execution_confidence")) or not score(record.get("scientific_fit"))
        or missing is None or risks is None or not isinstance(record.get("recommended"), bool) or reason is None
    ):
        return None
    provenance_value = record.get("provenance")
    provenance: dict[str, str] | None
    if provenance_value is None:
        provenance = None
    elif isinstance(provenance_value, dict):
        model_version = _string(provenance_value.get("model_version"), 128)
        generated_at = _string(provenance_value.get("generated_at"), 128)
        if model_version is None or generated_at is None:
            return None
        provenance = {"model_version": model_version, "generated_at": generated_at}
    else:
        return None
    return {
        "evaluator_version": FEASIBILITY_EVALUATOR_VERSION,
        "hard_gate": hard_gate,
        "coverage": {"supported_modules": supported, "total_modules": total, "ratio": float(ratio)},
        "execution_confidence": record["execution_confidence"],
        "scientific_fit": record["scientific_fit"],
        "missing_requirements": missing,
        "risks": risks,
        "recommended": record["recommended"],
        "reason": reason,
        **({"provenance": provenance} if provenance is not None else {}),
    }


def _capability_available(value: Any) -> bool:
    if value is None or value is False:
        return False
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return math.isfinite(float(value)) and float(value) > 0
    if isinstance(value, str):
        return bool(value.strip()) and value.strip().lower() != "false"
    return True


def coarse_match(paper: dict[str, Any], dataset: dict[str, Any]) -> dict[str, Any]:
    modules = paper.get("analysis_modules", [])
    available = dataset.get("capabilities", {})
    missing: list[dict[str, str]] = []
    supported = 0
    for module in modules:
        required = module.get("required_capabilities", [])
        absent = [key for key in required if not _capability_available(available.get(key))]
        if absent:
            missing.extend({"analysis_id": module.get("analysis_id", "unknown"), "capability_key": key} for key in absent)
        else:
            supported += 1
    total = len(modules)
    ratio = supported / total if total else 0.0
    reason = "All required analysis capabilities are present." if not missing else f"{supported}/{total} analysis modules have all required capabilities."
    return {"coverage_ratio": ratio, "supported_modules": supported, "total_modules": total, "missing_required": missing, "candidate_reason": reason}


def passes_automatic_threshold(hard_gate: str, coverage_ratio: float, execution_confidence: int, auto_execute: bool) -> bool:
    return bool(auto_execute and hard_gate == "pass" and coverage_ratio >= 0.60 and execution_confidence >= 60)
