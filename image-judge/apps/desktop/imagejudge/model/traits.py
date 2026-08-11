"""Versioned, calibration-safe trait contracts for local extraction.

The legacy ImageJudge classifier remains available, but generic trait
extraction uses these explicit definitions and observations.  In particular,
an uncalibrated image can never receive a fabricated physical measurement or
numeric confidence.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterable, Literal


TraitType = Literal["count", "continuous", "ordinal", "category"]


@dataclass(frozen=True)
class TraitDefinition:
    trait_id: str
    version: str
    name: str
    type: TraitType
    unit: str | None = None
    allowed_values: tuple[str, ...] = ()
    protocol: str = ""
    calibration_required: bool = False
    qc_rules: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not self.trait_id or not self.version or not self.name:
            raise ValueError("trait_id, version and name are required")
        if self.type in {"continuous", "count"} and self.unit is None:
            raise ValueError("numeric traits must declare a unit or explicit unitless value")
        if self.type == "category" and not self.allowed_values:
            raise ValueError("category traits must declare allowed_values")


@dataclass(frozen=True)
class TraitObservation:
    run_id: str
    image_id: str
    specimen_id: str
    trait_id: str
    value: Any
    unit: str | None
    calibrated_confidence: float | None
    quality_flags: tuple[str, ...]
    model_or_rule_version: str
    review_status: Literal["ACCEPTED", "REVIEW", "UNSUPPORTED", "FAILED", "SKIPPED"]
    image_sha256: str | None = None


def validate_observation(definition: TraitDefinition, observation: TraitObservation) -> None:
    if observation.trait_id != definition.trait_id:
        raise ValueError("observation trait_id does not match definition")
    if definition.calibration_required and observation.calibrated_confidence is not None:
        raise ValueError("uncalibrated trait observations must leave confidence null")
    if observation.calibrated_confidence is not None and not 0 <= observation.calibrated_confidence <= 1:
        raise ValueError("calibrated confidence must be between 0 and 1")
    if definition.calibration_required and not observation.unit and observation.value is not None:
        raise ValueError("calibrated physical values require a unit")
    if definition.type == "category" and observation.value is not None and observation.value not in definition.allowed_values:
        raise ValueError("value is outside the TraitDefinition allowed_values")
    if definition.type in {"continuous", "count"} and observation.value is not None:
        if not isinstance(observation.value, (int, float)) or observation.value < 0:
            raise ValueError("numeric trait values must be non-negative numbers")


def make_observation(
    definition: TraitDefinition,
    *,
    run_id: str,
    image_id: str,
    specimen_id: str,
    value: Any = None,
    unit: str | None = None,
    calibrated: bool = False,
    confidence: float | None = None,
    quality_flags: Iterable[str] = (),
    model_or_rule_version: str = "rule-v1",
) -> TraitObservation:
    flags = list(quality_flags)
    status: Literal["ACCEPTED", "REVIEW", "UNSUPPORTED", "FAILED"] = "ACCEPTED"
    if "UNSUPPORTED_FORMAT" in flags:
        status = "UNSUPPORTED"
    elif "DUPLICATE" in flags:
        status = "SKIPPED"
    elif "CORRUPT_OR_UNREADABLE" in flags:
        status = "FAILED"
    elif "REVIEW_REQUIRED" in flags:
        status = "REVIEW"
    if definition.calibration_required and not calibrated:
        value = None
        unit = None
        confidence = None
        flags.append("CALIBRATION_REQUIRED")
        status = "UNSUPPORTED"
    elif confidence is None and value is not None:
        flags.append("CONFIDENCE_UNAVAILABLE")
    observation = TraitObservation(
        run_id=run_id,
        image_id=image_id,
        specimen_id=specimen_id,
        trait_id=definition.trait_id,
        value=value,
        unit=unit or definition.unit,
        calibrated_confidence=confidence if calibrated else None,
        quality_flags=tuple(dict.fromkeys(flags)),
        model_or_rule_version=model_or_rule_version,
        review_status=status,
    )
    validate_observation(definition, observation)
    return observation


class TraitBatchExtractor:
    """Deterministic local scanner that never invents uncalibrated values."""

    SUPPORTED = {".jpg", ".jpeg", ".png", ".bmp", ".webp", ".tif", ".tiff"}

    def extract(
        self,
        paths: Iterable[Path],
        definition: TraitDefinition,
        *,
        run_id: str,
        specimen_resolver: Callable[[Path], str] | None = None,
    ) -> list[TraitObservation]:
        observations: list[TraitObservation] = []
        seen: set[str] = set()
        for path in sorted((Path(p) for p in paths), key=lambda p: p.as_posix()):
            logical_key = path.as_posix()
            image_id = "image-" + hashlib.sha256(logical_key.encode("utf-8")).hexdigest()[:24]
            if logical_key in seen:
                continue
            seen.add(logical_key)
            specimen_id = specimen_resolver(path) if specimen_resolver else path.stem
            if path.suffix.lower() not in self.SUPPORTED:
                observations.append(make_observation(
                    definition, run_id=run_id, image_id=image_id,
                    specimen_id=specimen_id, quality_flags=("UNSUPPORTED_FORMAT",),
                    model_or_rule_version="scanner-v1",
                ))
                continue
            try:
                info = path.lstat()
                if path.is_symlink() or info.st_nlink != 1:
                    raise ValueError("image link is not allowed")
                data = path.read_bytes()
                digest = hashlib.sha256(data).hexdigest()
                if not data:
                    raise ValueError("empty image")
                observation = make_observation(
                    definition, run_id=run_id, image_id=image_id,
                    specimen_id=specimen_id,
                    quality_flags=("REVIEW_REQUIRED",),
                    model_or_rule_version="scanner-v1",
                )
                observations.append(TraitObservation(**{**observation.__dict__, "image_sha256": digest}))
            except (OSError, ValueError):
                observations.append(make_observation(
                    definition, run_id=run_id, image_id=image_id,
                    specimen_id=specimen_id, quality_flags=("CORRUPT_OR_UNREADABLE",),
                    model_or_rule_version="scanner-v1",
                ))
        return observations
