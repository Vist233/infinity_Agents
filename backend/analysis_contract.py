"""Evidence-backed Method/TaskSpec contract for the Analysis workspace.

The compiler does not treat paper text as instructions.  A step is executable
only when its scientific claim has a resource-scoped locator, or when it is
explicitly marked unknown and therefore still requires user confirmation.
"""

from __future__ import annotations

import hashlib
from dataclasses import asdict, dataclass, field
from typing import Any, Iterable


@dataclass(frozen=True)
class EvidenceReference:
    resource_id: str
    locator: str
    source_kind: str = "paper"
    excerpt_sha256: str | None = None

    def __post_init__(self) -> None:
        if not self.resource_id or "/" in self.resource_id or "\\" in self.resource_id:
            raise ValueError("evidence resource_id must be an opaque resource identifier")
        if not self.locator or len(self.locator) > 300:
            raise ValueError("evidence locator is required and must be bounded")


@dataclass(frozen=True)
class MethodStep:
    step_id: str
    title: str
    action: str
    evidence: tuple[EvidenceReference, ...] = ()
    unknown_parameters: tuple[str, ...] = ()
    conflict_ids: tuple[str, ...] = ()


@dataclass(frozen=True)
class MethodDocument:
    version: str
    title: str
    sources: tuple[EvidenceReference, ...]
    steps: tuple[MethodStep, ...]
    input_contract: dict[str, Any] = field(default_factory=dict)
    output_contract: dict[str, Any] = field(default_factory=dict)

    def to_json(self) -> dict[str, Any]:
        return {
            "version": self.version,
            "title": self.title,
            "sources": [asdict(item) for item in self.sources],
            "steps": [
                {
                    **asdict(step),
                    "evidence": [asdict(item) for item in step.evidence],
                }
                for step in self.steps
            ],
            "input_contract": self.input_contract,
            "output_contract": self.output_contract,
        }


def validate_method_document(document: MethodDocument) -> list[str]:
    errors: list[str] = []
    source_ids = {item.resource_id for item in document.sources}
    seen_steps: set[str] = set()
    for step in document.steps:
        if not step.step_id or step.step_id in seen_steps:
            errors.append(f"duplicate or empty step_id: {step.step_id}")
        seen_steps.add(step.step_id)
        if not step.title or not step.action:
            errors.append(f"step {step.step_id} requires title and action")
        for evidence in step.evidence:
            if evidence.resource_id not in source_ids:
                errors.append(f"step {step.step_id} references an undeclared resource")
        if step.conflict_ids and not step.unknown_parameters:
            errors.append(f"step {step.step_id} has a conflict but no unresolved parameter")
        if not step.evidence and not step.unknown_parameters:
            errors.append(f"step {step.step_id} has no evidence and is not marked unknown")
    return errors


def excerpt_fingerprint(excerpt: str) -> str:
    """Store a stable digest rather than private paper text in evidence logs."""

    return hashlib.sha256(str(excerpt).encode("utf-8")).hexdigest()


def compile_method_document(
    *,
    title: str,
    sources: Iterable[EvidenceReference],
    steps: Iterable[MethodStep],
    input_contract: dict[str, Any] | None = None,
    output_contract: dict[str, Any] | None = None,
) -> MethodDocument:
    document = MethodDocument(
        version="method-v1",
        title=title,
        sources=tuple(sources),
        steps=tuple(steps),
        input_contract=input_contract or {},
        output_contract=output_contract or {},
    )
    errors = validate_method_document(document)
    if errors:
        raise ValueError("; ".join(errors))
    return document
