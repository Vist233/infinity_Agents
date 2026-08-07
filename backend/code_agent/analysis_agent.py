"""Infinity Agent — Analysis Agent for generating TaskSpecs."""

from __future__ import annotations

import json
import logging
import os
import re
from typing import Any, AsyncIterator, Dict, List, Optional

from anthropic import AsyncAnthropic

from backend.code_agent.models import TaskSpec

logger = logging.getLogger(__name__)

# TaskSpec schema version
_SCHEMA_VERSION = "1.0"

# Required fields for a valid TaskSpec
_REQUIRED_SPEC_FIELDS = {
    "domain": str,
    "analysis_type": str,
    "research_question": str,
    "spec_json": dict,
}

_REQUIRED_DELIVERABLE_FIELDS = {
    "path": str,
    "required": bool,
}

# System prompt for the Analysis Agent
_ANALYSIS_AGENT_SYSTEM_PROMPT = """You are the Infinity Agent Analysis Agent. Your ONLY job is to compile a user's research intent and method sources into a formal TaskSpec.

You MUST:
1. Analyze the user's research goal and any method sources they provide
2. Ask ONLY necessary scientific clarification questions (control groups, thresholds, reference genomes, etc.)
3. When you have enough information, output BOTH:
   a. A human-readable analysis plan (markdown)
   b. A machine-readable TaskSpec JSON object

The TaskSpec MUST include these exact fields:
{
  "schema_version": "1.0",
  "domain": "bioinformatics",
  "analysis_type": "rnaseq_deseq2|biopython|scanpy|...",
  "research_question": "the user's research question",
  "spec_json": {
    "deliverables": [
      {"path": "relative/path/to/file", "required": true, "min_bytes": 1024}
    ],
    "clarifications": {
      "control_groups": "confirmed value or 'user must confirm'",
      "thresholds": "confirmed value or 'user must confirm'",
      "reference_genome": "confirmed value or 'user must confirm'"
    }
  }
}

RULES:
- Never silently invent a critical scientific parameter
- Distinguish parameters from method sources vs user-confirmed vs system defaults
- If the user's input is ambiguous about biological decisions, ASK for clarification
- Do NOT execute analysis — only generate the TaskSpec
- Output the TaskSpec as valid JSON when ready
- If you need more information, ask clarifying questions first
"""

# Known method source templates
_METHOD_SOURCES = {
    "rnaseq_deseq2": {
        "title": "DESeq2 Differential Expression Analysis",
        "source_type": "official_tutorial",
        "deliverables": [
            {"path": "results/differential_expression.csv", "required": True, "min_bytes": 500},
            {"path": "figures/volcano_plot.png", "required": True, "min_bytes": 3000},
            {"path": "report/summary.md", "required": True, "min_bytes": 500},
        ],
        "defaults": {
            "adjusted_p_value": 0.05,
            "log2_fold_change": 1.0,
        },
    },
    "biopython": {
        "title": "Biopython Sequence Analysis",
        "source_type": "official_docs",
        "deliverables": [
            {"path": "results/alignment_report.csv", "required": True, "min_bytes": 200},
            {"path": "results/sequence_stats.json", "required": True, "min_bytes": 100},
            {"path": "report/summary.md", "required": True, "min_bytes": 300},
        ],
        "defaults": {},
    },
    "scanpy": {
        "title": "Scanpy Single-Cell RNA-seq Analysis",
        "source_type": "official_tutorial",
        "deliverables": [
            {"path": "results/clustered_adata.h5ad", "required": True, "min_bytes": 10000},
            {"path": "figures/umap.png", "required": True, "min_bytes": 5000},
            {"path": "results/markers.csv", "required": True, "min_bytes": 200},
            {"path": "report/summary.md", "required": True, "min_bytes": 500},
        ],
        "defaults": {
            "n_pcs": 30,
            "n_neighbors": 10,
            "resolution": 1.0,
        },
    },
}


def validate_task_spec(spec: Dict[str, Any]) -> List[str]:
    """Validate a TaskSpec draft and return a list of error messages.

    Returns an empty list if the spec is valid.
    """
    errors: List[str] = []
    if not isinstance(spec, dict):
        return ["TaskSpec must be a JSON object"]

    for field, expected_type in _REQUIRED_SPEC_FIELDS.items():
        if field not in spec:
            errors.append(f"Missing required field: {field}")
        elif not isinstance(spec[field], expected_type):
            errors.append(f"Field '{field}' must be {expected_type.__name__}")

    spec_json = spec.get("spec_json", {})
    if isinstance(spec_json, dict):
        deliverables = spec_json.get("deliverables", [])
        if not isinstance(deliverables, list):
            errors.append("spec_json.deliverables must be a list")
        else:
            for idx, deliverable in enumerate(deliverables):
                if not isinstance(deliverable, dict):
                    errors.append(f"Deliverable {idx} must be an object")
                    continue
                for field, expected_type in _REQUIRED_DELIVERABLE_FIELDS.items():
                    if field not in deliverable:
                        errors.append(f"Deliverable {idx} missing field: {field}")
                    elif not isinstance(deliverable[field], expected_type):
                        errors.append(f"Deliverable {idx} field '{field}' must be {expected_type.__name__}")

    return errors


def _detect_case(user_input: str) -> str:
    normalized = (user_input or "").lower()
    if "case1" in normalized or "rna" in normalized or "deseq" in normalized:
        return "rnaseq_deseq2"
    if "case2" in normalized or "biopython" in normalized or "orchid" in normalized:
        return "biopython"
    if "case3" in normalized or "scanpy" in normalized or "single cell" in normalized:
        return "scanpy"
    return "generic"


def _build_task_spec_from_method(analysis_type: str, user_input: str) -> Dict[str, Any]:
    """Build a TaskSpec from known method source templates."""
    method = _METHOD_SOURCES.get(analysis_type, {})
    analysis_type_label = {
        "rnaseq_deseq2": "DESeq2 Differential Expression",
        "biopython": "Biopython Sequence Analysis",
        "scanpy": "Scanpy Single-Cell RNA-seq",
    }.get(analysis_type, analysis_type)

    deliverables = method.get("deliverables", [
        {"path": "results/output.zip", "required": True, "min_bytes": 1024},
        {"path": "report/summary.md", "required": True, "min_bytes": 500},
    ])

    return {
        "schema_version": _SCHEMA_VERSION,
        "domain": "bioinformatics",
        "analysis_type": analysis_type,
        "research_question": f"Analysis based on user request: {user_input[:200]}",
        "spec_json": {
            "title": f"{analysis_type_label} — {user_input[:60]}",
            "method_sources": [
                {
                    "source_type": method.get("source_type", "official_docs"),
                    "title": method.get("title", analysis_type_label),
                    "url": method.get("url", ""),
                    "version": method.get("version", "latest"),
                }
            ],
            "method_summary": method.get("summary", f"Run {analysis_type_label} pipeline on the provided dataset."),
            "steps": method.get("steps", [
                {"order": 1, "name": "load_data", "description": "Load and validate input dataset"},
                {"order": 2, "name": "run_analysis", "description": f"Execute {analysis_type_label} workflow"},
                {"order": 3, "name": "verify_outputs", "description": "Run five-level verification on outputs"},
                {"order": 4, "name": "package_results", "description": "Create artifact ZIP and manifest"},
            ]),
            "input_schema": method.get("input_schema", {
                "type": "object",
                "properties": {
                    "dataset": {"type": "string", "format": "file"},
                    "metadata": {"type": "object"},
                },
                "required": ["dataset"],
            }),
            "output_schema": method.get("output_schema", {
                "type": "object",
                "properties": {
                    "results": {"type": "array", "items": {"type": "string", "format": "file"}},
                    "report": {"type": "string", "format": "markdown"},
                },
                "required": ["results", "report"],
            }),
            "execution": {
                "runtime": method.get("runtime", {
                    "max_wall_clock_seconds": 1800,
                    "max_idle_seconds": 300,
                }),
                "required_stages": ["prepare", "execute", "verify", "package"],
            },
            "parameters": method.get("parameters", {
                "adjusted_p_value": {"type": "number", "default": 0.05},
                "log2_fold_change": {"type": "number", "default": 1.0},
            }),
            "user_confirmations": {
                "control_groups": "user must confirm",
                "thresholds": "user must confirm",
                "reference_genome": "user must confirm",
            },
            "validation_rules": method.get("validation_rules", [
                {"rule": "min_gene_count", "threshold": 10},
                {"rule": "padj_column_required"},
            ]),
            "deliverables": deliverables,
            "expected_deliverables": deliverables,
            "clarifications": {
                "control_groups": "user must confirm",
                "thresholds": "user must confirm",
                "reference_genome": "user must confirm",
            },
            "method_source": method.get("title", analysis_type_label),
            "method_source_type": method.get("source_type", "official_docs"),
            "defaults": method.get("defaults", {}),
            "resource_limits": {
                "cpu_cores": 4,
                "memory_gb": 16,
                "disk_gb": 50,
                "gpu_required": analysis_type == "scanpy",
            },
            "failure_boundaries": {
                "max_attempts": 3,
                "retry_on": ["oom", "timeout", "network"],
                "fail_fast_on": ["invalid_input", "license"],
            },
        },
    }


def _extract_json_from_text(text: str) -> Optional[Dict[str, Any]]:
    """Extract JSON object from LLM response text."""
    # Try to find JSON in code blocks
    code_block_match = re.search(r'```(?:json)?\s*(\{.*?\})\s*```', text, re.DOTALL)
    if code_block_match:
        try:
            return json.loads(code_block_match.group(1))
        except json.JSONDecodeError:
            pass

    # Try to find the largest JSON object
    json_match = re.search(r'(\{.*\})', text, re.DOTALL)
    if json_match:
        try:
            return json.loads(json_match.group(1))
        except json.JSONDecodeError:
            pass

    return None


async def _call_llm_for_analysis(user_input: str, messages: Optional[List[Dict[str, Any]]] = None) -> AsyncIterator[Dict[str, Any]]:
    """Call the real LLM (StepFun/Anthropic) to generate a TaskSpec."""
    api_key = os.getenv("STEPFUN_API_KEY") or os.getenv("ANTHROPIC_API_KEY")
    if not api_key:
        logger.warning("No API key found, falling back to deterministic mock")
        yield {"type": "status", "phase": "thinking", "elapsed_ms": 0, "attempt": 1, "max_attempts": 1, "tool_name": "analysis_agent"}
        yield {"type": "chunk", "content": "No API key configured. Using fallback mode.\n"}
        async for event in _deterministic_fallback(user_input):
            yield event
        return

    client = AsyncAnthropic(api_key=api_key)

    # Build conversation history
    system_prompt = _ANALYSIS_AGENT_SYSTEM_PROMPT
    user_messages = []

    if messages:
        for msg in messages:
            role = msg.get("role", "user")
            content = msg.get("content", "")
            if content:
                user_messages.append({"role": role, "content": content})

    # Add current user input
    user_messages.append({"role": "user", "content": user_input})

    try:
        stream = client.messages.stream(
            model=os.getenv("ANTHROPIC_MODEL", "step-3.7-flash"),
            system=system_prompt,
            messages=user_messages,
            max_tokens=4096,
        )

        full_response = ""
        async with stream as s:
            async for event in s:
                if hasattr(event, 'delta') and hasattr(event.delta, 'text'):
                    chunk = event.delta.text
                    full_response += chunk
                    yield {"type": "chunk", "content": chunk}

        # After streaming, check if we got a valid TaskSpec
        task_spec = _extract_json_from_text(full_response)

        if task_spec:
            validation_errors = validate_task_spec(task_spec)
            if not validation_errors:
                yield {
                    "type": "task_spec_draft",
                    "task_spec": task_spec,
                    "validation_errors": [],
                }
            else:
                yield {
                    "type": "task_spec_draft",
                    "task_spec": task_spec,
                    "validation_errors": validation_errors,
                }
        else:
            # No TaskSpec found — treat as clarification or plan text
            pass

        yield {"type": "status", "phase": "responding", "elapsed_ms": 1500, "attempt": 1, "max_attempts": 1}
        yield {"type": "done", "token_info": {"prompt": 0, "response": len(full_response), "total": len(full_response)}}

    except Exception as exc:
        logger.error("LLM call failed: %s", exc)
        yield {"type": "chunk", "content": f"LLM error: {exc}\nFalling back to deterministic mode.\n"}
        async for event in _deterministic_fallback(user_input):
            yield event


async def _deterministic_fallback(user_input: str) -> AsyncIterator[Dict[str, Any]]:
    """Deterministic fake runtime that produces a valid TaskSpec."""
    yield {"type": "status", "phase": "thinking", "elapsed_ms": 0, "attempt": 1, "max_attempts": 1, "tool_name": "analysis_agent"}

    analysis_type = _detect_case(user_input)

    if analysis_type == "generic":
        yield {"type": "chunk", "content": "I need a bit more information to design the analysis.\n\nPlease specify:\n- Control groups (e.g., treated vs untreated)\n- Statistical thresholds (p-value, padj)\n- Reference genomes or datasets\n\nFor example: \"case1 RNA-seq DESeq2 differential expression with padj < 0.05\""}
        yield {"type": "done", "token_info": {"prompt": 0, "response": 50, "total": 50}}
        return

    task_spec = _build_task_spec_from_method(analysis_type, user_input)

    validation_errors = validate_task_spec(task_spec)
    if validation_errors:
        yield {"type": "chunk", "content": f"Invalid TaskSpec: {', '.join(validation_errors)}\n"}
        yield {"type": "done", "token_info": {"prompt": 0, "response": 0, "total": 0}}
        return

    plan_text = (
        f"## Analysis Plan ({analysis_type})\n\n"
        f"I have designed the following task specification:\n\n"
        f"- **Domain**: {task_spec['domain']}\n"
        f"- **Analysis Type**: {task_spec['analysis_type']}\n"
        f"- **Research Question**: {task_spec['research_question']}\n\n"
        f"### Deliverables\n"
    )
    for deliverable in task_spec["spec_json"]["deliverables"]:
        plan_text += f"- `{deliverable['path']}` (required: {deliverable['required']})\n"
    plan_text += (
        "\nPlease review the TaskSpec draft below. You can upload your dataset and confirm to create the task.\n"
    )

    yield {"type": "chunk", "content": plan_text}
    yield {
        "type": "task_spec_draft",
        "task_spec": task_spec,
        "validation_errors": [],
    }
    yield {"type": "status", "phase": "responding", "elapsed_ms": 1200, "attempt": 1, "max_attempts": 1}
    yield {"type": "done", "token_info": {"prompt": 0, "response": len(plan_text), "total": len(plan_text)}}


async def run_analysis_stream(
    user_input: str,
    messages: Optional[List[Dict[str, Any]]] = None,
) -> AsyncIterator[Dict[str, Any]]:
    """Generate a TaskSpec draft from a user conversation.

    If STEPFUN_API_KEY or ANTHROPIC_API_KEY is available, uses the real LLM.
    Otherwise falls back to deterministic mock for testing.
    """
    api_key = os.getenv("STEPFUN_API_KEY") or os.getenv("ANTHROPIC_API_KEY")
    if api_key:
        async for event in _call_llm_for_analysis(user_input, messages):
            yield event
    else:
        async for event in _deterministic_fallback(user_input):
            yield event
