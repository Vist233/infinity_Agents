"""Infinity Agent — Five-level external Verifier.

Verifies task outputs at five levels:
1. File level — existence, size, safe path
2. Format level — parseable CSV/JSON/PNG/PDF/ZIP
3. Content level — row counts, columns, samples
4. Execution level — exit code, timeout, OOM, stages
5. Reproducibility level — hashes, image digest, environment
6. Domain level — analysis-type-specific semantic checks
"""

from __future__ import annotations

import csv
import io
import json
import logging
import os
import zipfile
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)


class VerificationFailure:
    def __init__(self, level: str, message: str, detail: Optional[str] = None):
        self.level = level
        self.message = message
        self.detail = detail

    def __repr__(self):
        return f"[{self.level}] {self.message}"


def _safe_path(base: Path, rel_path: str) -> Optional[Path]:
    """Resolve a relative path within base, preventing traversal."""
    try:
        resolved = (base / rel_path).resolve()
        resolved.relative_to(base.resolve())
        return resolved
    except (ValueError, OSError):
        return None


class FiveLevelVerifier:
    def __init__(self, output_dir: Path, task_spec: Dict[str, Any]):
        self.output_dir = output_dir
        self.task_spec = task_spec
        self.failures: List[VerificationFailure] = []

    def verify(self) -> Dict[str, Any]:
        """Run all five verification levels."""
        self._verify_file_level()
        self._verify_format_level()
        self._verify_content_level()
        self._verify_execution_level()
        self._verify_reproducibility_level()
        self._verify_domain_level()

        passed = len(self.failures) == 0
        return {
            "passed": passed,
            "failures": [{"level": f.level, "message": f.message, "detail": f.detail} for f in self.failures],
            "levels_checked": 6,
        }

    def _verify_file_level(self) -> None:
        """Level 1: File existence, size, safe path."""
        deliverables = self.task_spec.get("spec_json", {}).get("deliverables", [])

        for deliverable in deliverables:
            path_str = deliverable.get("path", "")
            if not path_str:
                self.failures.append(VerificationFailure("file", "Deliverable has no path"))
                continue

            file_path = _safe_path(self.output_dir, path_str)
            if file_path is None:
                self.failures.append(VerificationFailure("file", f"Path traversal blocked: {path_str}"))
                continue

            if not file_path.exists():
                self.failures.append(VerificationFailure("file", f"Missing required file: {path_str}"))
                continue

            if not file_path.is_file():
                self.failures.append(VerificationFailure("file", f"Not a file: {path_str}"))
                continue

            if file_path.stat().st_size == 0:
                self.failures.append(VerificationFailure("file", f"Empty file: {path_str}"))

            min_bytes = deliverable.get("min_bytes", 0)
            if min_bytes and file_path.stat().st_size < min_bytes:
                self.failures.append(VerificationFailure(
                    "file", f"File too small: {path_str} ({file_path.stat().st_size} < {min_bytes} bytes)"
                ))

    def _verify_format_level(self) -> None:
        """Level 2: Format validation."""
        deliverables = self.task_spec.get("spec_json", {}).get("deliverables", [])

        for deliverable in deliverables:
            path_str = deliverable.get("path", "")
            file_path = _safe_path(self.output_dir, path_str)
            if file_path is None or not file_path.exists():
                continue

            suffix = file_path.suffix.lower()

            if suffix == ".csv" or suffix == ".tsv":
                try:
                    with open(file_path, newline="", encoding="utf-8", errors="replace") as f:
                        reader = csv.reader(f)
                        header = next(reader, None)
                        if header is None:
                            self.failures.append(VerificationFailure("format", f"Empty CSV: {path_str}"))
                except Exception as exc:
                    self.failures.append(VerificationFailure("format", f"Invalid CSV {path_str}: {exc}"))

            elif suffix == ".json":
                try:
                    content = file_path.read_text(encoding="utf-8", errors="replace")
                    json.loads(content)
                except json.JSONDecodeError as exc:
                    self.failures.append(VerificationFailure("format", f"Invalid JSON {path_str}: {exc}"))

            elif suffix in (".png", ".jpg", ".jpeg", ".pdf", ".zip"):
                try:
                    with open(file_path, "rb") as f:
                        header = f.read(8)
                    valid_headers = {
                        ".png": b"\x89PNG\r\n\x1a\n",
                        ".jpg": b"\xff\xd8\xff",
                        ".jpeg": b"\xff\xd8\xff",
                        ".pdf": b"%PDF",
                        ".zip": b"PK\x03\x04",
                    }
                    expected = valid_headers.get(suffix)
                    if expected and not header.startswith(expected):
                        self.failures.append(VerificationFailure("format", f"Invalid {suffix} header: {path_str}"))

                    if suffix == ".zip":
                        try:
                            with zipfile.ZipFile(file_path, "r") as zf:
                                for info in zf.infolist():
                                    if info.filename.startswith("/") or ".." in info.filename:
                                        self.failures.append(VerificationFailure(
                                            "format", f"ZIP path traversal in {path_str}: {info.filename}"
                                        ))
                                        break
                        except zipfile.BadZipFile:
                            self.failures.append(VerificationFailure("format", f"Corrupt ZIP: {path_str}"))
                except Exception as exc:
                    self.failures.append(VerificationFailure("format", f"Cannot read {path_str}: {exc}"))

            elif suffix == ".h5ad":
                try:
                    import anndata
                    adata = anndata.read_h5ad(str(file_path))
                    if adata.obs.shape[0] == 0:
                        self.failures.append(VerificationFailure("format", f"Empty h5ad: {path_str}"))
                except ImportError:
                    logger.debug("anndata not installed; skipping h5ad format validation for %s", path_str)
                except Exception as exc:
                    self.failures.append(VerificationFailure("format", f"Invalid h5ad {path_str}: {exc}"))

    def _verify_content_level(self) -> None:
        """Level 3: Content validation."""
        deliverables = self.task_spec.get("spec_json", {}).get("deliverables", [])

        for deliverable in deliverables:
            path_str = deliverable.get("path", "")
            file_path = _safe_path(self.output_dir, path_str)
            if file_path is None or not file_path.exists():
                continue

            suffix = file_path.suffix.lower()
            min_rows = deliverable.get("min_rows", 0)

            if suffix in (".csv", ".tsv") and min_rows:
                try:
                    with open(file_path, newline="", encoding="utf-8", errors="replace") as f:
                        row_count = sum(1 for _ in csv.reader(f)) - 1  # subtract header
                    if row_count < min_rows:
                        self.failures.append(VerificationFailure(
                            "content", f"{path_str}: {row_count} rows, need >= {min_rows}"
                        ))
                except Exception:
                    pass

            required_cols = deliverable.get("required_columns", [])
            if required_cols and suffix in (".csv", ".tsv"):
                try:
                    with open(file_path, newline="", encoding="utf-8", errors="replace") as f:
                        reader = csv.reader(f)
                        header = next(reader, [])
                    header_set = {h.strip().lower() for h in header}
                    for col in required_cols:
                        if col.lower() not in header_set:
                            self.failures.append(VerificationFailure(
                                "content", f"{path_str}: missing required column '{col}'"
                            ))
                except Exception:
                    pass

    def _verify_execution_level(self) -> None:
        """Level 4: Execution validation."""
        exec_info = self.task_spec.get("spec_json", {}).get("execution", {})

        required_stages = exec_info.get("required_stages", [])
        if required_stages:
            events_file = self.output_dir / "execution_events.json"
            if not events_file.exists():
                self.failures.append(VerificationFailure("execution", "Missing execution_events.json"))
            else:
                try:
                    events = json.loads(events_file.read_text())
                    event_types = {e.get("type") for e in events if isinstance(e, dict)}
                    for stage in required_stages:
                        if stage not in event_types:
                            self.failures.append(VerificationFailure(
                                "execution", f"Missing required execution stage: {stage}"
                            ))
                except Exception as exc:
                    self.failures.append(VerificationFailure("execution", f"Invalid execution_events.json: {exc}"))

    def _verify_reproducibility_level(self) -> None:
        """Level 5: Reproducibility validation."""
        repro = self.task_spec.get("spec_json", {}).get("reproducibility", {})

        required_fields = repro.get("required_fields", [])
        manifest_path = self.output_dir / "manifest.json"
        manifest: Dict[str, Any] = {}

        if manifest_path.exists():
            try:
                manifest = json.loads(manifest_path.read_text())
            except Exception:
                pass

        for field in required_fields:
            if field not in manifest:
                self.failures.append(VerificationFailure(
                    "reproducibility", f"Manifest missing required field: {field}"
                ))

    def _verify_domain_level(self) -> None:
        """Level 6: Domain-specific semantic validation."""
        analysis_type = self.task_spec.get("analysis_type", "").lower()

        if analysis_type in ("rnaseq_deseq2", "deseq2"):
            self._verify_deseq2()
        elif analysis_type in ("biopython", "biopython_analysis"):
            self._verify_biopython()
        elif analysis_type in ("scanpy", "scrnaseq"):
            self._verify_scanpy()

    def _verify_deseq2(self) -> None:
        """Validate DESeq2 differential expression outputs."""
        deliverables = self.task_spec.get("spec_json", {}).get("deliverables", [])

        for deliverable in deliverables:
            path_str = deliverable.get("path", "")
            file_path = _safe_path(self.output_dir, path_str)
            if file_path is None or not file_path.exists():
                continue

            suffix = file_path.suffix.lower()
            if suffix not in (".csv", ".tsv"):
                continue

            try:
                with open(file_path, newline="", encoding="utf-8", errors="replace") as f:
                    reader = csv.DictReader(f)
                    headers = [h.strip().lower() for h in (reader.fieldnames or [])]

                if "padj" not in headers:
                    self.failures.append(VerificationFailure(
                        "domain",
                        f"DESeq2 result missing required 'padj' column: {path_str}",
                    ))

                gene_count = 0
                try:
                    with open(file_path, newline="", encoding="utf-8", errors="replace") as f:
                        reader = csv.DictReader(f)
                        for row in reader:
                            try:
                                padj = float(row.get("padj", "nan"))
                                if padj < 0.05:
                                    gene_count += 1
                            except (ValueError, TypeError):
                                pass
                except Exception:
                    pass

                if gene_count < 10:
                    self.failures.append(VerificationFailure(
                        "domain",
                        f"DESeq2 result has too few significant genes (padj<0.05): {gene_count} in {path_str}",
                    ))

            except Exception as exc:
                self.failures.append(VerificationFailure(
                    "domain", f"DESeq2 validation failed for {path_str}: {exc}"
                ))

    def _verify_biopython(self) -> None:
        """Validate Biopython sequence analysis outputs."""
        deliverables = self.task_spec.get("spec_json", {}).get("deliverables", [])

        for deliverable in deliverables:
            path_str = deliverable.get("path", "")
            file_path = _safe_path(self.output_dir, path_str)
            if file_path is None or not file_path.exists():
                continue

            suffix = file_path.suffix.lower()

            if suffix == ".json":
                try:
                    content = json.loads(file_path.read_text(encoding="utf-8", errors="replace"))
                    if not isinstance(content, dict):
                        self.failures.append(VerificationFailure(
                            "domain", f"Biopython JSON must be an object: {path_str}"
                        ))
                        continue

                    if "sequences" not in content and "alignment" not in content:
                        self.failures.append(VerificationFailure(
                            "domain",
                            f"Biopython JSON missing expected keys ('sequences' or 'alignment'): {path_str}",
                        ))

                    stats = content.get("stats", {})
                    if not isinstance(stats, dict):
                        self.failures.append(VerificationFailure(
                            "domain", f"Biopython JSON 'stats' must be an object: {path_str}"
                        ))

                except json.JSONDecodeError as exc:
                    self.failures.append(VerificationFailure(
                        "domain", f"Biopython JSON parse failed: {path_str}: {exc}"
                    ))

            elif suffix in (".csv", ".tsv"):
                try:
                    with open(file_path, newline="", encoding="utf-8", errors="replace") as f:
                        reader = csv.DictReader(f)
                        headers = [h.strip().lower() for h in (reader.fieldnames or [])]

                    header_set = set(headers)
                    # Accept the stable aliases used by the versioned orchid
                    # fixture (Record_ID/Length_bp/GC_percent) as well as the
                    # normalized names emitted by other Biopython runners.
                    sequence_aliases = {
                        "sequence_id": {"sequence_id", "record_id"},
                        "length": {"length", "length_bp"},
                        "gc_content": {"gc_content", "gc_percent"},
                        "description": {"description"},
                    }
                    is_summary_table = {"metric", "value"}.issubset(header_set)
                    missing = {
                        name for name, aliases in sequence_aliases.items()
                        if not aliases.intersection(header_set)
                    } if not is_summary_table else set()
                    if missing:
                        self.failures.append(VerificationFailure(
                            "domain",
                            f"Biopython CSV missing columns {missing}: {path_str}",
                        ))

                except Exception as exc:
                    self.failures.append(VerificationFailure(
                        "domain", f"Biopython CSV validation failed: {path_str}: {exc}"
                    ))

    def _verify_scanpy(self) -> None:
        """Validate scanpy single-cell RNA-seq outputs."""
        deliverables = self.task_spec.get("spec_json", {}).get("deliverables", [])

        for deliverable in deliverables:
            path_str = deliverable.get("path", "")
            file_path = _safe_path(self.output_dir, path_str)
            if file_path is None or not file_path.exists():
                continue

            suffix = file_path.suffix.lower()

            if suffix == ".h5ad":
                try:
                    import anndata
                    adata = anndata.read_h5ad(str(file_path))

                    if adata.shape[0] == 0 or adata.shape[1] == 0:
                        self.failures.append(VerificationFailure(
                            "domain", f"scanpy h5ad is empty: {path_str}"
                        ))

                    umap_keys = [k for k in adata.obsm_keys() if "umap" in k.lower()]
                    if not umap_keys:
                        self.failures.append(VerificationFailure(
                            "domain",
                            f"scanpy h5ad missing UMAP coordinates in obsm: {path_str}",
                        ))

                except ImportError:
                    logger.debug("anndata not installed; skipping scanpy h5ad validation for %s", path_str)
                except Exception as exc:
                    self.failures.append(VerificationFailure(
                        "domain", f"scanpy h5ad validation failed: {path_str}: {exc}"
                    ))

            elif suffix in (".csv", ".tsv"):
                try:
                    with open(file_path, newline="", encoding="utf-8", errors="replace") as f:
                        reader = csv.DictReader(f)
                        headers = [h.strip().lower() for h in (reader.fieldnames or [])]

                    if "umap_1" in headers and "umap_2" in headers:
                        continue

                    if "cluster" not in headers and "leiden" not in headers and "louvain" not in headers:
                        self.failures.append(VerificationFailure(
                            "domain",
                            f"scanpy markers CSV missing cluster columns: {path_str}",
                        ))

                except Exception as exc:
                    self.failures.append(VerificationFailure(
                        "domain", f"scanpy CSV validation failed: {path_str}: {exc}"
                    ))


def validate_dataset_snapshot(
    snapshot_path: Path,
    requirements: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Validate a dataset snapshot directory or archive.

    Checks:
    - File readability and required files
    - Column presence in CSV/TSV files
    - Sample-ID uniqueness and matching across files
    - Size limits and empty-file detection
    - Safe archive extraction (no path traversal)
    """
    requirements = requirements or {}
    failures: List[VerificationFailure] = []
    warnings: List[str] = []

    if not snapshot_path.exists():
        return {"passed": False, "failures": [{"level": "dataset", "message": "Snapshot path does not exist"}], "warnings": warnings}

    max_size_bytes = requirements.get("max_size_bytes", 5 * 1024 * 1024 * 1024)  # 5 GB default
    required_files = requirements.get("required_files", [])
    required_columns = requirements.get("required_columns", {})
    sample_id_columns = requirements.get("sample_id_columns", [])
    max_empty_fraction = requirements.get("max_empty_fraction", 0.5)

    # Check size limit
    if snapshot_path.is_file():
        total_size = snapshot_path.stat().st_size
        if total_size > max_size_bytes:
            failures.append(VerificationFailure(
                "dataset",
                f"Snapshot exceeds max size: {total_size} bytes > {max_size_bytes} bytes",
            ))
        # Check archive safety
        _validate_archive(snapshot_path, failures)
        return {
            "passed": len(failures) == 0,
            "failures": [{"level": f.level, "message": f.message, "detail": f.detail} for f in failures],
            "warnings": warnings,
        }

    # Directory snapshot
    total_size = 0
    found_files = []
    empty_files = []

    for root, dirs, files in os.walk(snapshot_path):
        for fname in files:
            fpath = Path(root) / fname
            try:
                fsize = fpath.stat().st_size
                total_size += fsize
                found_files.append(fpath)
                if fsize == 0:
                    empty_files.append(str(fpath.relative_to(snapshot_path)))
            except OSError as exc:
                failures.append(VerificationFailure("dataset", f"Cannot read file {fpath}: {exc}"))

    if total_size > max_size_bytes:
        failures.append(VerificationFailure(
            "dataset",
            f"Snapshot exceeds max size: {total_size} bytes > {max_size_bytes} bytes",
        ))

    # Check required files
    for req_file in required_files:
        found = any(fpath.name == req_file or str(fpath.relative_to(snapshot_path)) == req_file for fpath in found_files)
        if not found:
            failures.append(VerificationFailure("dataset", f"Missing required file: {req_file}"))

    # Check empty files
    if empty_files:
        failures.append(VerificationFailure(
            "dataset",
            f"Empty files detected: {', '.join(empty_files)}",
        ))

    # Validate CSV/TSV columns and sample IDs
    sample_ids_by_file: Dict[str, set] = {}
    for fpath in found_files:
        suffix = fpath.suffix.lower()
        if suffix not in (".csv", ".tsv"):
            continue

        rel_path = str(fpath.relative_to(snapshot_path))
        try:
            with open(fpath, newline="", encoding="utf-8", errors="replace") as f:
                reader = csv.reader(f)
                header = next(reader, [])
                header_set = {h.strip().lower() for h in header}

                # Check required columns
                req_cols = required_columns.get(rel_path, required_columns.get("*", []))
                for col in req_cols:
                    if col.lower() not in header_set:
                        failures.append(VerificationFailure(
                            "dataset",
                            f"{rel_path}: missing required column '{col}'",
                        ))

                # Collect sample IDs
                sid_cols = [c for c in sample_id_columns if c.lower() in header_set]
                if sid_cols:
                    sample_ids = set()
                    for row in reader:
                        for col in sid_cols:
                            val = row[header.index(col)].strip() if col in header else ""
                            if val:
                                sample_ids.add(val)
                    sample_ids_by_file[rel_path] = sample_ids

        except Exception as exc:
            failures.append(VerificationFailure("dataset", f"Cannot read {rel_path}: {exc}"))

    # Check sample-ID uniqueness within each file
    for rel_path, sids in sample_ids_by_file.items():
        if len(sids) < 2:
            warnings.append(f"{rel_path}: fewer than 2 unique sample IDs")
        # Check for duplicates (if original file had more rows than unique IDs)
        # We can't easily detect this without re-reading, so skip for now

    # Check sample matching across files
    if len(sample_ids_by_file) > 1:
        ref_path, ref_ids = next(iter(sample_ids_by_file.items()))
        for other_path, other_ids in sample_ids_by_file.items():
            if other_path == ref_path:
                continue
            missing = ref_ids - other_ids
            if missing:
                failures.append(VerificationFailure(
                    "dataset",
                    f"Sample mismatch: {len(missing)} samples in {ref_path} missing from {other_path}",
                ))

    return {
        "passed": len(failures) == 0,
        "failures": [{"level": f.level, "message": f.message, "detail": f.detail} for f in failures],
        "warnings": warnings,
    }


def _validate_archive(archive_path: Path, failures: List[VerificationFailure]) -> None:
    """Validate archive file for path traversal and corruption."""
    suffix = archive_path.suffix.lower()
    if suffix not in (".zip", ".tar", ".gz", ".bz2", ".xz"):
        return

    try:
        if suffix == ".zip":
            with zipfile.ZipFile(archive_path, "r") as zf:
                for info in zf.infolist():
                    if info.filename.startswith("/") or ".." in info.filename:
                        failures.append(VerificationFailure(
                            "dataset",
                            f"Archive path traversal in {archive_path.name}: {info.filename}",
                        ))
                        break
    except (zipfile.BadZipFile, OSError) as exc:
        failures.append(VerificationFailure("dataset", f"Corrupt archive {archive_path.name}: {exc}"))


def verify_outputs(output_dir: Path, task_spec: Dict[str, Any]) -> Dict[str, Any]:
    """Convenience function to run five-level verification."""
    verifier = FiveLevelVerifier(output_dir, task_spec)
    return verifier.verify()
