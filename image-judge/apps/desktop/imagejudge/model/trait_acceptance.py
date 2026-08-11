"""Reproducible local Trait/Observation acceptance runner.

This runner is intentionally conservative: it can produce category/count
observations from a deterministic local rule, but never manufactures a
calibrated physical value or numeric confidence.  It persists every input,
supports resume, and emits only logical IDs in its evidence files.
"""

from __future__ import annotations

import csv
import hashlib
import json
import time
from collections import Counter
from pathlib import Path
from typing import Callable, Iterable, Mapping

from .traits import TraitBatchExtractor, TraitDefinition, TraitObservation, make_observation
from ..persistence.db import init_db
from ..persistence.repository import Repository


def _digest(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            hasher.update(chunk)
    return hasher.hexdigest()


def _image_id(logical_name: str) -> str:
    return "image-" + hashlib.sha256(logical_name.encode("utf-8")).hexdigest()[:24]


def compute_category_metrics(observations: Iterable[TraitObservation], truth: Mapping[str, str]) -> dict:
    pairs = [(truth[item.image_id], str(item.value)) for item in observations if item.image_id in truth and item.value is not None]
    labels = sorted({label for pair in pairs for label in pair})
    f1_values: list[float] = []
    per_class: dict[str, dict[str, float]] = {}
    for label in labels:
        tp = sum(actual == label and predicted == label for actual, predicted in pairs)
        fp = sum(actual != label and predicted == label for actual, predicted in pairs)
        fn = sum(actual == label and predicted != label for actual, predicted in pairs)
        precision = tp / (tp + fp) if tp + fp else 0.0
        recall = tp / (tp + fn) if tp + fn else 0.0
        f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
        per_class[label] = {"precision": precision, "recall": recall, "f1": f1}
        f1_values.append(f1)
    return {
        "labeled": len(pairs),
        "macro_f1": sum(f1_values) / len(f1_values) if f1_values else None,
        "per_class": per_class,
    }


class TraitBatchAcceptance:
    def __init__(self, db_path: Path, output_dir: Path) -> None:
        self.db_path = Path(db_path)
        self.output_dir = Path(output_dir)
        init_db(self.db_path)
        self.repository = Repository(self.db_path)

    def run(
        self,
        paths: Iterable[Path],
        definition: TraitDefinition,
        *,
        run_id: str,
        truth: Mapping[str, str] | None = None,
        specimen_resolver: Callable[[Path], str] | None = None,
        validate_image_bytes: bool = False,
    ) -> dict:
        started = time.perf_counter()
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.repository.save_trait_definition(definition)
        existing = {row.image_id: row for row in self.repository.list_trait_observations(run_id)}
        ordered = sorted({Path(path) for path in paths}, key=lambda path: path.as_posix())
        by_digest: dict[str, str] = {}
        observations: list[TraitObservation] = []
        extractor = TraitBatchExtractor()

        for path in ordered:
            logical_name = path.as_posix()
            image_id = _image_id(logical_name)
            if image_id in existing:
                row = existing[image_id]
                observations.append(TraitObservation(
                    run_id=run_id, image_id=row.image_id, specimen_id=row.specimen_id,
                    trait_id=row.trait_id, value=json.loads(row.value_json or "null"),
                    unit=row.unit or None, calibrated_confidence=row.calibrated_confidence,
                    quality_flags=tuple(json.loads(row.quality_flags_json or "[]")),
                    model_or_rule_version=row.model_or_rule_version,
                    review_status=row.review_status, image_sha256=row.image_sha256 or None,
                ))
                continue

            if not path.exists() or path.is_symlink() or not path.is_file():
                observation = make_observation(definition, run_id=run_id, image_id=image_id, specimen_id=path.stem, quality_flags=("CORRUPT_OR_UNREADABLE",), model_or_rule_version="scanner-v1")
            elif path.suffix.lower() in extractor.SUPPORTED:
                digest = _digest(path)
                if digest in by_digest:
                    observation = make_observation(definition, run_id=run_id, image_id=image_id, specimen_id=(specimen_resolver(path) if specimen_resolver else path.stem), quality_flags=("DUPLICATE",), model_or_rule_version="scanner-v1")
                    observation = TraitObservation(**{**observation.__dict__, "image_sha256": digest})
                elif validate_image_bytes:
                    try:
                        from PIL import Image
                        with Image.open(path) as image:
                            image.verify()
                        by_digest[digest] = image_id
                        observation = extractor.extract([path], definition, run_id=run_id, specimen_resolver=specimen_resolver)[0]
                        observation = TraitObservation(**{**observation.__dict__, "image_sha256": digest})
                    except Exception:
                        observation = make_observation(definition, run_id=run_id, image_id=image_id, specimen_id=path.stem, quality_flags=("CORRUPT_OR_UNREADABLE",), model_or_rule_version="scanner-v1")
                else:
                    by_digest[digest] = image_id
                    observation = extractor.extract([path], definition, run_id=run_id, specimen_resolver=specimen_resolver)[0]
                    observation = TraitObservation(**{**observation.__dict__, "image_sha256": digest})
            else:
                observation = extractor.extract([path], definition, run_id=run_id, specimen_resolver=specimen_resolver)[0]
            self.repository.save_trait_observation(observation)
            observations.append(observation)

        self._write_evidence(run_id, definition, observations, truth or {}, started)
        statuses = Counter(item.review_status for item in observations)
        return {
            "run_id": run_id,
            "total": len(observations),
            "statuses": dict(statuses),
            "elapsed_seconds": round(time.perf_counter() - started, 4),
            "images_per_minute": round(len(observations) / max(time.perf_counter() - started, 0.001) * 60, 2),
            "metrics": compute_category_metrics(observations, truth or {}) if definition.type in {"category", "ordinal"} else {},
        }

    def _write_evidence(self, run_id: str, definition: TraitDefinition, observations: list[TraitObservation], truth: Mapping[str, str], started: float) -> None:
        rows = [{
            "run_id": item.run_id, "image_id": item.image_id, "specimen_id": item.specimen_id,
            "trait_id": item.trait_id, "value": json.dumps(item.value, ensure_ascii=False),
            "unit": item.unit or "", "calibrated_confidence": "" if item.calibrated_confidence is None else item.calibrated_confidence,
            "quality_flags": ";".join(item.quality_flags), "model_or_rule_version": item.model_or_rule_version,
            "review_status": item.review_status, "image_sha256": item.image_sha256 or "",
        } for item in observations]
        with (self.output_dir / "observations.csv").open("w", newline="", encoding="utf-8") as handle:
            writer = csv.DictWriter(handle, fieldnames=list(rows[0]) if rows else ["run_id", "image_id"])
            writer.writeheader()
            writer.writerows(rows)
        failures = [row for row in rows if row.get("review_status") in {"FAILED", "UNSUPPORTED", "REVIEW"}]
        (self.output_dir / "failures.json").write_text(json.dumps(failures, ensure_ascii=False, indent=2), encoding="utf-8")
        summary = {
            "run_id": run_id,
            "trait_id": definition.trait_id,
            "trait_version": definition.version,
            "counts": dict(Counter(item.review_status for item in observations)),
            "total": len(observations),
            "elapsed_seconds": round(time.perf_counter() - started, 4),
            "calibration_required": definition.calibration_required,
            "absolute_paths_in_evidence": False,
            "metrics": compute_category_metrics(observations, truth) if truth else {},
        }
        (self.output_dir / "qc.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2, sort_keys=True), encoding="utf-8")
        (self.output_dir / "run_manifest.json").write_text(json.dumps({"run_id": run_id, "trait": definition.trait_id, "trait_version": definition.version, "count": len(observations), "rule_version": "scanner-v1"}, ensure_ascii=False, indent=2, sort_keys=True), encoding="utf-8")
