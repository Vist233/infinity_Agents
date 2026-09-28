"""Bounded, deterministic inspection of single data files and ZIP archives."""

from __future__ import annotations

import csv
import hashlib
import io
import json
import math
import re
import stat
import tempfile
import time
import zipfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any, BinaryIO, Iterable

from .contracts import DATASET_PROFILE_VERSION, normalize_dataset_profile

INSPECTOR_VERSION = "dataset-inspector-v1"
MAX_MEMBERS = 1_024
MAX_MEMBER_BYTES = 64 * 1024 * 1024
MAX_EXPANDED_BYTES = 64 * 1024 * 1024
MAX_SAMPLE_ROWS = 100
MAX_SAMPLE_BYTES = 2 * 1024 * 1024
MAX_SAMPLE_COLUMNS = 128
MAX_DELIMITER_SAMPLE_BYTES = 64 * 1024
MAX_JSON_PARSE_BYTES = 8 * 1024 * 1024
MAX_JSONL_LINE_BYTES = 8 * 1024 * 1024
MAX_CSV_FIELD_BYTES = 2 * 1024 * 1024
MAX_TEXT_SAMPLE_BYTES = 16 * 1024
MAX_COLUMNS = 10_000
MAX_SCAN_SECONDS = 120.0
SUPPORTED_SUFFIXES = {".csv", ".tsv", ".json", ".jsonl", ".txt", ".md", ".readme"}
COLLECTION_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$")


class DatasetInspectionError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        self.code = code
        super().__init__(message)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _check_deadline(deadline: float) -> None:
    if time.monotonic() > deadline:
        raise DatasetInspectionError("INSPECTION_TIMEOUT", "Dataset inspection exceeded its time budget")


def _safe_member_name(name: str) -> str:
    normalized = name.replace("\\", "/")
    path = PurePosixPath(normalized)
    if not normalized or normalized.startswith("/") or "\x00" in normalized or any(part in {"", ".", ".."} for part in path.parts):
        raise DatasetInspectionError("ARCHIVE_PATH_TRAVERSAL", "Archive member path is not safe")
    return "/".join(path.parts)


def _zip_symlink(info: zipfile.ZipInfo) -> bool:
    mode = (info.external_attr >> 16) & 0xFFFF
    return stat.S_ISLNK(mode)


def _spool_stream(
    stream: BinaryIO,
    declared_size: int,
    deadline: float,
    total_before: int,
    *,
    member_error_code: str,
) -> tuple[BinaryIO, int, str, int]:
    if declared_size < 0 or declared_size > MAX_MEMBER_BYTES:
        raise DatasetInspectionError(member_error_code, "Input exceeds the per-file limit")
    # Small inputs remain memory-backed; larger inputs spill to the processor's
    # temporary filesystem instead of accumulating one unbounded bytes object.
    spool = tempfile.SpooledTemporaryFile(max_size=1 * 1024 * 1024, mode="w+b")
    size = 0
    digest_total = total_before
    digest = hashlib.sha256()
    try:
        while True:
            _check_deadline(deadline)
            chunk = stream.read(128 * 1024)
            if not chunk:
                break
            size += len(chunk)
            digest_total += len(chunk)
            if size > MAX_MEMBER_BYTES:
                raise DatasetInspectionError(member_error_code, "Input exceeds the per-file limit")
            if digest_total > MAX_EXPANDED_BYTES:
                raise DatasetInspectionError("ARCHIVE_EXPANSION_LIMIT", "Archive expansion exceeds its safety limit")
            spool.write(chunk)
            digest.update(chunk)
    except Exception:
        spool.close()
        raise
    spool.seek(0)
    return spool, size, digest.hexdigest(), digest_total


def _read_plain(path: Path, deadline: float) -> tuple[BinaryIO, int, str]:
    if path.is_symlink() or not path.is_file():
        raise DatasetInspectionError("SOURCE_NOT_REGULAR", "Dataset source must be a regular file")
    try:
        size = path.stat().st_size
    except OSError as exc:
        raise DatasetInspectionError("SOURCE_UNREADABLE", "Dataset source could not be stat-ed") from exc
    if size <= 0 or size > MAX_MEMBER_BYTES:
        raise DatasetInspectionError("SOURCE_TOO_LARGE", "Dataset source exceeds its safety limit")
    with path.open("rb") as stream:
        spool, actual_size, digest, _ = _spool_stream(
            stream, size, deadline, 0, member_error_code="SOURCE_TOO_LARGE"
        )
    if actual_size <= 0:
        spool.close()
        raise DatasetInspectionError("SOURCE_EMPTY", "Dataset source is empty")
    return spool, actual_size, digest


def _format_for_name(name: str) -> str:
    suffix = Path(name.lower()).suffix
    if suffix == ".csv":
        return "csv"
    if suffix == ".tsv":
        return "tsv"
    if suffix in {".json", ".jsonl"}:
        return "json"
    if suffix in {".txt", ".md", ".readme"} or Path(name.lower()).name.startswith("readme"):
        return "readme" if Path(name.lower()).name.startswith("readme") else "txt"
    return "unknown"


def _tabular_delimiter(stream: BinaryIO, file_format: str, deadline: float) -> str:
    if file_format == "tsv":
        return "\t"
    stream.seek(0)
    sample_bytes = stream.read(MAX_DELIMITER_SAMPLE_BYTES)
    _check_deadline(deadline)
    try:
        text = sample_bytes.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise DatasetInspectionError("TEXT_DECODE_FAILED", "Tabular data is not valid UTF-8") from exc
    sample = "\n".join(text.splitlines()[:32])[:64 * 1024]
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=",;\t")
        return dialect.delimiter
    except csv.Error:
        # Sniffer is intentionally only a first pass.  A bounded consistency
        # score keeps ordinary CSVs deterministic when the sample is sparse.
        scores: list[tuple[int, int, str]] = []
        for delimiter in (",", ";", "\t"):
            try:
                parsed = list(csv.reader(sample.splitlines(), delimiter=delimiter))
            except csv.Error:
                continue
            widths = [len(row) for row in parsed if row]
            width = max(widths, default=1)
            consistent = sum(1 for value in widths if value == width)
            scores.append((width, consistent, delimiter))
        best = max(scores, default=(1, 0, ","))
        return best[2] if best[0] > 1 else ","


def _safe_scalar(value: str) -> Any:
    value = value.strip()
    if not value:
        return None
    lowered = value.lower()
    if lowered in {"true", "false"}:
        return lowered == "true"
    try:
        number = float(value)
        if math.isfinite(number):
            return int(number) if number.is_integer() else number
    except ValueError:
        pass
    return value[:2_048]


def _infer_type(values: Iterable[Any]) -> str:
    present = [value for value in values if value is not None and value != ""]
    if not present:
        return "unknown"
    if all(isinstance(value, bool) for value in present):
        return "boolean"
    if all(isinstance(value, (int, float)) and not isinstance(value, bool) for value in present):
        return "numeric"
    distinct = {str(value)[:256] for value in present}
    return "categorical" if len(distinct) <= 32 else "text"


def _target_column(names: list[str]) -> str | None:
    known = {"target", "label", "class", "outcome", "response", "quality", "y", "score"}
    for name in names:
        if name.strip().lower() in known:
            return name
    return None


def _sample_value(value: Any) -> Any:
    return value[:256] if isinstance(value, str) else value


def _tabular_profile(name: str, stream: BinaryIO, file_format: str, size_bytes: int, sha256: str, deadline: float) -> dict[str, Any]:
    delimiter = _tabular_delimiter(stream, file_format, deadline)
    stream.seek(0)
    text_stream = io.TextIOWrapper(stream, encoding="utf-8-sig", newline="")
    previous_field_limit = csv.field_size_limit()
    csv.field_size_limit(MAX_CSV_FIELD_BYTES)
    try:
        reader = csv.reader(text_stream, delimiter=delimiter)
        try:
            raw_header = next(reader)
        except StopIteration as exc:
            raise DatasetInspectionError("CSV_EMPTY", "Tabular data has no header") from exc
        header = [str(value).strip()[:512] for value in raw_header]
        if not header or len(header) > MAX_COLUMNS or any(not value for value in header):
            raise DatasetInspectionError("CSV_WIDE_OR_INVALID", "Tabular header is invalid or too wide")
        names: list[str] = []
        seen: dict[str, int] = {}
        for value in header:
            count = seen.get(value, 0) + 1
            seen[value] = count
            names.append(value if count == 1 else f"{value}_{count}")
        sample_rows: list[dict[str, Any]] = []
        sample_size = 0
        missing_cells = 0
        total_cells = 0
        column_values: list[list[Any]] = [[] for _ in names]
        row_count = 0
        for row in reader:
            _check_deadline(deadline)
            if len(row) > MAX_COLUMNS:
                raise DatasetInspectionError("CSV_WIDE_OR_INVALID", "A tabular row is too wide")
            padded = row[: len(names)] + [""] * max(0, len(names) - len(row))
            total_cells += len(names)
            missing_cells += sum(1 for value in padded if not value.strip())
            converted = [_safe_scalar(value) for value in padded]
            if row_count < MAX_SAMPLE_ROWS:
                for index, value in enumerate(converted[:MAX_SAMPLE_COLUMNS]):
                    if index >= len(names):
                        break
                    converted[index] = _sample_value(value)
                candidate = {names[index]: converted[index] for index in range(min(len(names), MAX_SAMPLE_COLUMNS))}
                candidate_size = len(json.dumps(candidate, ensure_ascii=False).encode("utf-8"))
                if sample_size + candidate_size <= MAX_SAMPLE_BYTES:
                    sample_rows.append(candidate)
                    sample_size += candidate_size
            if row_count < MAX_SAMPLE_ROWS:
                for index, value in enumerate(converted):
                    column_values[index].append(value)
            row_count += 1
        data_types = {name: _infer_type(column_values[index]) for index, name in enumerate(names)}
    except (csv.Error, UnicodeDecodeError) as exc:
        raise DatasetInspectionError("CSV_INVALID", "Tabular data is malformed") from exc
    finally:
        csv.field_size_limit(previous_field_limit)
        text_stream.detach()
    return {
        "path": name,
        "format": file_format,
        "size_bytes": size_bytes,
        "sha256": sha256,
        "rows": row_count,
        "columns": len(names),
        "column_names": names,
        "data_types": data_types,
        "missing_ratio": (missing_cells / total_cells) if total_cells else 0.0,
        "sample": sample_rows,
    }


def _bounded_json_value(value: Any, depth: int = 0) -> Any:
    if depth >= 3:
        return str(value)[:256]
    if isinstance(value, str):
        return value[:2_048]
    if isinstance(value, list):
        return [_bounded_json_value(item, depth + 1) for item in value[:32]]
    if isinstance(value, dict):
        return {
            str(key)[:512]: _bounded_json_value(item, depth + 1)
            for key, item in list(value.items())[:64]
        }
    if value is None or isinstance(value, (bool, int, float)):
        return value
    return str(value)[:2_048]


def _json_profile(name: str, stream: BinaryIO, size_bytes: int, sha256: str, deadline: float) -> dict[str, Any]:
    if size_bytes > MAX_JSON_PARSE_BYTES:
        raise DatasetInspectionError("JSON_TOO_LARGE", "JSON data exceeds the parser safety limit")
    stream.seek(0)
    text_stream = io.TextIOWrapper(stream, encoding="utf-8-sig", newline="")
    try:
        parsed = json.load(text_stream)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise DatasetInspectionError("JSON_INVALID", "JSON data is malformed") from exc
    finally:
        text_stream.detach()
    _check_deadline(deadline)
    records: list[dict[str, Any]]
    if isinstance(parsed, list):
        records = [item for item in parsed if isinstance(item, dict)][:MAX_SAMPLE_ROWS]
        rows = len(parsed)
    elif isinstance(parsed, dict):
        records = [parsed]
        rows = 1
    else:
        records = []
        rows = 1
    names = list(dict.fromkeys(key[:512] for record in records for key in record if isinstance(key, str)))[:MAX_COLUMNS]
    values = {name: [record.get(name) for record in records] for name in names}
    sample = [{name: _bounded_json_value(record.get(name)) for name in names} for record in records[:MAX_SAMPLE_ROWS]]
    return {
        "path": name,
        "format": "json",
        "size_bytes": size_bytes,
        "sha256": sha256,
        "rows": rows,
        "columns": len(names),
        "column_names": names,
        "data_types": {name: _infer_type(values[name]) for name in names},
        "missing_ratio": None,
        "sample": sample,
    }


def _text_profile(name: str, stream: BinaryIO, size_bytes: int, sha256: str) -> dict[str, Any]:
    stream.seek(0)
    sample_bytes = stream.read(MAX_TEXT_SAMPLE_BYTES)
    try:
        text = sample_bytes.decode("utf-8-sig", errors="replace")
    except Exception:
        text = ""
    return {
        "path": name,
        "format": _format_for_name(name),
        "size_bytes": size_bytes,
        "sha256": sha256,
        "rows": None,
        "columns": None,
        "column_names": [],
        "data_types": {},
        "missing_ratio": None,
        "sample": ([{"text": text[:2_048]}] if text else []),
    }


def _jsonl_profile(name: str, stream: BinaryIO, size_bytes: int, sha256: str, deadline: float) -> dict[str, Any]:
    stream.seek(0)
    rows = 0
    parsed: list[dict[str, Any]] = []
    first_line = True
    try:
        while True:
            _check_deadline(deadline)
            line = stream.readline(MAX_JSONL_LINE_BYTES + 1)
            if not line:
                break
            if len(line) > MAX_JSONL_LINE_BYTES:
                raise DatasetInspectionError("JSONL_LINE_TOO_LARGE", "JSONL record exceeds the per-line limit")
            try:
                text = line.decode("utf-8-sig" if first_line else "utf-8")
            except UnicodeDecodeError as exc:
                raise DatasetInspectionError("JSON_INVALID", "JSONL data is malformed") from exc
            first_line = False
            if not text.strip():
                continue
            try:
                item = json.loads(text)
            except json.JSONDecodeError as exc:
                raise DatasetInspectionError("JSON_INVALID", "JSONL data is malformed") from exc
            if isinstance(item, dict) and len(parsed) < MAX_SAMPLE_ROWS:
                parsed.append(item)
            rows += 1
    except OSError as exc:
        raise DatasetInspectionError("JSON_INVALID", "JSONL data is unreadable") from exc
    names = list(dict.fromkeys(key[:512] for item in parsed for key in item if isinstance(key, str)))[:MAX_COLUMNS]
    return {
        "path": name,
        "format": "json",
        "size_bytes": size_bytes,
        "sha256": sha256,
        "rows": rows,
        "columns": len(names),
        "column_names": names,
        "data_types": {key: _infer_type([item.get(key) for item in parsed]) for key in names},
        "missing_ratio": None,
        "sample": [{key: _bounded_json_value(item.get(key)) for key in names} for item in parsed[:MAX_SAMPLE_ROWS]],
    }


def _profile_file(name: str, stream: BinaryIO, size_bytes: int, sha256: str, deadline: float) -> dict[str, Any]:
    file_format = _format_for_name(name)
    if file_format in {"csv", "tsv"}:
        return _tabular_profile(name, stream, file_format, size_bytes, sha256, deadline)
    if file_format == "json":
        if name.lower().endswith(".jsonl"):
            return _jsonl_profile(name, stream, size_bytes, sha256, deadline)
        return _json_profile(name, stream, size_bytes, sha256, deadline)
    if file_format in {"txt", "readme"}:
        return _text_profile(name, stream, size_bytes, sha256)
    return {
        "path": name,
        "format": "unknown",
        "size_bytes": size_bytes,
        "sha256": sha256,
        "rows": None,
        "columns": None,
        "column_names": [],
        "data_types": {},
        "missing_ratio": None,
        "sample": [],
    }


def _profile_collection(collection_id: str, files: list[dict[str, Any]], generated_at: str) -> dict[str, Any]:
    tabular = [item for item in files if item["format"] in {"csv", "tsv", "json"} and item["columns"]]
    all_names: list[str] = []
    all_types: dict[str, str] = {}
    sample_count = 0
    missing = False
    for item in tabular:
        all_names.extend(item["column_names"])
        all_types.update(item["data_types"])
        sample_count += int(item["rows"] or 0)
        missing = missing or bool(item["missing_ratio"] and item["missing_ratio"] > 0)
    target = _target_column(all_names)
    if target is not None:
        features = [name for name in all_names if name != target]
    else:
        features = all_names
    target_type = all_types.get(target) if target else None
    numeric_features = sum(1 for name in features if all_types.get(name) == "numeric")
    categorical_features = sum(1 for name in features if all_types.get(name) == "categorical")
    capabilities: dict[str, Any] = {
        "tabular.numeric_features": numeric_features > 0,
        "tabular.categorical_features": categorical_features > 0,
        "dataset.has_missing_values": missing,
        "dataset.sample_count": sample_count,
        "dataset.feature_count": len(features),
    }
    if target_type in {"numeric", "categorical"}:
        capabilities["target.numeric"] = target_type == "numeric"
        capabilities["target.ordinal"] = target_type == "categorical"
        capabilities["target.ordinal_or_numeric"] = True
    tags: list[str] = []
    if tabular:
        tags.append("Tabular")
    if target_type == "numeric":
        tags.append("Regression")
    elif target_type == "categorical":
        tags.append("Classification")
    if features:
        tags.append(f"{len(features)} Features")
    if sample_count:
        tags.append(f"{sample_count} Samples")
    profile = {
        "profile_version": DATASET_PROFILE_VERSION,
        "model_version": INSPECTOR_VERSION,
        "provenance": {"collection_id": collection_id, "inspector_version": INSPECTOR_VERSION, "generated_at": generated_at},
        "collection_id": collection_id,
        "domain_hint": "machine_learning" if target is not None and numeric_features > 0 else None,
        "files": files[:256],
        "capabilities": capabilities,
        "semantic_fields": {"target": target, "feature_names": features[:10_000]},
        "display_tags": tags[:128],
    }
    if normalize_dataset_profile(profile, collection_id) is None:
        raise DatasetInspectionError("PROFILE_INVALID", "Generated dataset profile failed its contract")
    return profile


def inspect_path(path: Path | str, collection_id: str, *, generated_at: str | None = None, timeout_seconds: float = 30.0) -> dict[str, Any]:
    """Inspect a regular data file or ZIP without extracting archive members."""

    source = Path(path)
    deadline = time.monotonic() + min(MAX_SCAN_SECONDS, max(0.001, float(timeout_seconds)))
    if COLLECTION_ID_PATTERN.fullmatch(collection_id) is None:
        raise DatasetInspectionError("INVALID_COLLECTION_ID", "Collection identity is invalid")
    try:
        if source.is_symlink() or not source.is_file():
            raise DatasetInspectionError("SOURCE_NOT_REGULAR", "Dataset source must be a regular file")
        with source.open("rb") as probe:
            magic = probe.read(4)
        is_archive = source.suffix.lower() == ".zip" or magic.startswith(b"PK\x03\x04")
    except OSError as exc:
        raise DatasetInspectionError("SOURCE_UNREADABLE", "Dataset source could not be read") from exc
    files: list[dict[str, Any]] = []
    if is_archive:
        expanded = 0
        try:
            with zipfile.ZipFile(source) as archive:
                infos = archive.infolist()
                if len(infos) > MAX_MEMBERS:
                    raise DatasetInspectionError("ARCHIVE_MEMBER_LIMIT", "Archive contains too many members")
                for info in infos:
                    _check_deadline(deadline)
                    safe_name = _safe_member_name(info.filename)
                    if info.is_dir():
                        continue
                    if _zip_symlink(info):
                        raise DatasetInspectionError("ARCHIVE_SYMLINK", "Archive symlinks are not permitted")
                    if info.file_size > MAX_MEMBER_BYTES or expanded + info.file_size > MAX_EXPANDED_BYTES:
                        raise DatasetInspectionError("ARCHIVE_EXPANSION_LIMIT", "Archive expansion exceeds its safety limit")
                    if info.file_size > max(1, info.compress_size) * 100 and info.file_size > 1 * 1024 * 1024:
                        raise DatasetInspectionError("ARCHIVE_COMPRESSION_RATIO", "Archive member compression ratio is unsafe")
                    with archive.open(info, "r") as member:
                        spool, size_bytes, sha256, expanded = _spool_stream(
                            member, info.file_size, deadline, expanded,
                            member_error_code="ARCHIVE_MEMBER_TOO_LARGE",
                        )
                    try:
                        files.append(_profile_file(safe_name, spool, size_bytes, sha256, deadline))
                    finally:
                        spool.close()
        except DatasetInspectionError:
            raise
        except (OSError, zipfile.BadZipFile, zipfile.LargeZipFile) as exc:
            raise DatasetInspectionError("ARCHIVE_INVALID", "ZIP archive is corrupt or unreadable") from exc
    else:
        spool, size_bytes, sha256 = _read_plain(source, deadline)
        try:
            files.append(_profile_file(source.name, spool, size_bytes, sha256, deadline))
        finally:
            spool.close()
    if not files:
        raise DatasetInspectionError("NO_INSPECTABLE_FILES", "Dataset contains no supported files")
    return _profile_collection(collection_id, files, generated_at or _now_iso())
