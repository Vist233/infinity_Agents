"""Goal-driven Analysis Agent tools.

These tools are deliberately split from the Task API boundary. They only
create or inspect user-scoped draft material; an authenticated confirmation
request is the only code path that creates a queued Task.
"""

from __future__ import annotations

import csv
import hashlib
import json
import os
import re
import uuid
import zipfile
from pathlib import Path
from typing import Any, Dict, Optional

from agno.tools import Toolkit


MAX_TASK_INPUT_BYTES = 25 * 1024 * 1024
_SAFE_FILENAME = re.compile(r"[^A-Za-z0-9._-]+")
_MAX_ZIP_ENTRIES = 10_000
_MAX_ZIP_UNCOMPRESSED_BYTES = 10 * 1024**3


def _json(payload: Dict[str, Any]) -> str:
    return json.dumps(payload, ensure_ascii=False)


class GoalDrivenTaskTools(Toolkit):
    """Session-scoped document, resource, and draft tools for Analysis."""

    def __init__(self, *, session_id: str, session_root: Path, **kwargs: Any) -> None:
        self.session_id = str(session_id)
        self.session_root = session_root.resolve()
        self.draft_root = (self.session_root / "task-drafts").resolve()
        self.document_root = (self.draft_root / "documents").resolve()
        self.catalog_path = (self.session_root / "resource-catalog.json").resolve()
        self.draft_root.mkdir(parents=True, exist_ok=True)
        self.document_root.mkdir(parents=True, exist_ok=True)
        super().__init__(
            name="goal_driven_task_tools",
            tools=[
                self.create_execution_document,
                self.list_session_resources,
                self.inspect_dataset,
                self.prepare_goal_driven_task,
                self.revise_goal_driven_task,
                self.cancel_goal_driven_task,
            ],
            **kwargs,
        )

    def _safe_session_path(self, relative_path: str) -> Optional[Path]:
        raw = str(relative_path or "").replace("\\", "/").strip()
        if not raw or raw.startswith("/"):
            return None
        candidate = (self.session_root / raw).resolve()
        try:
            candidate.relative_to(self.session_root)
        except ValueError:
            return None
        current = self.session_root
        for part in Path(raw).parts:
            current = current / part
            if current.is_symlink():
                return None
        return candidate

    @staticmethod
    def _hash_file(path: Path) -> tuple[int, str]:
        size = 0
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                size += len(chunk)
                if size > MAX_TASK_INPUT_BYTES:
                    raise ValueError("dataset exceeds 25 MB")
                digest.update(chunk)
        return size, digest.hexdigest()

    def _load_catalog(self) -> list[Dict[str, Any]]:
        if not self.catalog_path.is_file() or self.catalog_path.is_symlink():
            return []
        try:
            payload = json.loads(self.catalog_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return []
        resources = payload.get("resources") if isinstance(payload, dict) else []
        return [item for item in resources if isinstance(item, dict)]

    def _find_resource(self, resource_id: str) -> Optional[Dict[str, Any]]:
        wanted = str(resource_id or "").strip()
        return next((item for item in self._load_catalog() if str(item.get("resource_id")) == wanted), None)

    def create_execution_document(self, document_name: str, markdown: str) -> str:
        """Write a versioned Markdown document in this session only.

        ``document_name`` is a display filename, never a path. This tool does
        not execute the document and does not create a Task.
        """
        content = str(markdown or "").replace("\x00", "").strip()
        if not content:
            return _json({"type": "execution_document_error", "error": "markdown is required"})
        encoded = content.encode("utf-8")
        if len(encoded) > MAX_TASK_INPUT_BYTES:
            return _json({"type": "execution_document_error", "error": "execution document exceeds 25 MB"})
        raw_name = Path(str(document_name or "execution-document.md")).name
        safe_name = _SAFE_FILENAME.sub("-", raw_name).strip(".-") or "execution-document"
        if not safe_name.lower().endswith((".md", ".txt")):
            safe_name += ".md"
        document_id = str(uuid.uuid4())
        path = self.document_root / document_id / safe_name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(encoded)
        return _json({
            "type": "execution_document",
            "document_id": document_id,
            "session_id": self.session_id,
            "revision": 1,
            "filename": safe_name,
            "relative_path": path.relative_to(self.session_root).as_posix(),
            "size_bytes": len(encoded),
            "sha256": hashlib.sha256(encoded).hexdigest(),
            "preview": content[:12000],
        })

    def list_session_resources(self, include_files: bool = True) -> str:
        """List only resources linked to this session and safe session files."""
        resources = []
        for item in self._load_catalog():
            resources.append({
                "resource_id": item.get("resource_id"),
                "kind": item.get("kind"),
                "filename": item.get("logical_name"),
                "size_bytes": item.get("file_size_bytes"),
                "sha256": item.get("checksum_sha256"),
                "validation": item.get("validation_result"),
                "status": item.get("status", "ready"),
            })
        files: list[Dict[str, Any]] = []
        if include_files and self.session_root.is_dir():
            for path in sorted(self.session_root.rglob("*")):
                if not path.is_file() or path.is_symlink() or path.name == "resource-catalog.json":
                    continue
                try:
                    files.append({
                        "relative_path": path.relative_to(self.session_root).as_posix(),
                        "filename": path.name,
                        "size_bytes": path.stat().st_size,
                    })
                except OSError:
                    continue
        return _json({"type": "session_resources", "session_id": self.session_id, "resources": resources, "files": files})

    def inspect_dataset(self, resource_id: str) -> str:
        """Perform bounded, read-only structure and schema inspection."""
        try:
            uuid.UUID(str(resource_id))
        except (ValueError, AttributeError):
            return _json({"type": "dataset_inspection_error", "error": "resource_id is invalid"})
        resource = self._find_resource(resource_id)
        if not resource or resource.get("kind") != "dataset":
            return _json({"type": "dataset_inspection_error", "error": "dataset is not linked to this session"})
        storage_root = Path(os.getenv("RESOURCE_STORAGE_ROOT", "/workspace/resources")).resolve()
        storage_key = str(resource.get("storage_key") or "")
        if not storage_key or storage_key.startswith("/"):
            return _json({"type": "dataset_inspection_error", "error": "dataset storage is unavailable"})
        path = (storage_root / storage_key).resolve()
        try:
            path.relative_to(storage_root)
        except ValueError:
            return _json({"type": "dataset_inspection_error", "error": "dataset storage is invalid"})
        if path.is_symlink() or not path.is_file():
            return _json({"type": "dataset_inspection_error", "error": "dataset file is unavailable"})
        try:
            size, digest = self._hash_file(path)
        except (OSError, ValueError) as exc:
            return _json({"type": "dataset_inspection_error", "error": str(exc)})
        logical_suffix = Path(str(resource.get("logical_name") or path.name)).suffix.lower()
        result: Dict[str, Any] = {
            "resource_id": str(resource_id),
            "filename": Path(str(resource.get("logical_name") or path.name)).name,
            "size_bytes": size,
            "sha256": digest,
            "hash_matches_catalog": not resource.get("checksum_sha256") or digest == resource.get("checksum_sha256"),
            "validation": {
                "passed": not resource.get("checksum_sha256") or digest == resource.get("checksum_sha256"),
                "format": logical_suffix.lstrip(".") or "binary",
            },
        }
        if not result["hash_matches_catalog"]:
            result["validation"].update({"code": "hash_mismatch", "message": "dataset hash does not match the session catalog"})
        if logical_suffix == ".zip":
            try:
                with zipfile.ZipFile(path) as archive:
                    infos = archive.infolist()
                    if not infos or len(infos) > _MAX_ZIP_ENTRIES:
                        raise ValueError("ZIP entry count is invalid")
                    total = 0
                    names = []
                    for info in infos:
                        name = info.filename.replace("\\", "/")
                        if name.startswith("/") or ".." in Path(name).parts:
                            raise ValueError("ZIP contains path traversal")
                        total += int(info.file_size or 0)
                        if total > _MAX_ZIP_UNCOMPRESSED_BYTES:
                            raise ValueError("ZIP expands beyond the inspection limit")
                        names.append(name)
                    result["validation"].update({"format": "zip", "entry_count": len(names), "total_uncompressed_bytes": total})
                    result["files"] = names[:200]
            except (OSError, ValueError, zipfile.BadZipFile) as exc:
                result["validation"] = {"passed": False, "code": "invalid_zip", "message": str(exc)}
        elif logical_suffix in {".csv", ".tsv"}:
            delimiter = "\t" if logical_suffix == ".tsv" else ","
            try:
                with path.open("r", encoding="utf-8", errors="replace", newline="") as handle:
                    rows = list(csv.reader((handle.readline() for _ in range(100)), delimiter=delimiter))
                headers = rows[0] if rows else []
                result["validation"].update({"format": logical_suffix.lstrip("."), "columns": headers[:200], "sample_rows": max(0, len(rows) - 1)})
            except (OSError, csv.Error) as exc:
                result["validation"] = {"passed": False, "code": "invalid_table", "message": str(exc)}
        return _json({"type": "dataset_inspection", "dataset": result})

    def _safe_document_bytes(self, method_document_ref: Optional[str], method_document: Optional[str]) -> tuple[Optional[bytes], Optional[str]]:
        if method_document_ref:
            source = self._safe_session_path(method_document_ref)
            if source is None or not source.is_file() or source.is_symlink() or not source.is_relative_to(self.document_root):
                raise ValueError("execution document reference is not available in this session")
            return source.read_bytes(), source.name
        if method_document is None:
            return None, None
        content = str(method_document).replace("\x00", "").strip()
        if not content:
            return None, None
        return content.encode("utf-8"), "execution-document.md"

    def _write_draft_method(self, draft_id: str, revision: int, encoded: Optional[bytes], filename: Optional[str]) -> Optional[Dict[str, Any]]:
        if encoded is None:
            return None
        if len(encoded) > MAX_TASK_INPUT_BYTES:
            raise ValueError("execution document exceeds 25 MB")
        safe_name = Path(filename or "execution-document.md").name
        if not safe_name.lower().endswith((".md", ".txt")):
            safe_name = "execution-document.md"
        path = self.draft_root / str(draft_id) / "revisions" / str(revision) / safe_name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(encoded)
        return {
            "filename": safe_name,
            "relative_path": path.relative_to(self.session_root).as_posix(),
            "size_bytes": len(encoded),
            "sha256": hashlib.sha256(encoded).hexdigest(),
            "preview": encoded.decode("utf-8", errors="replace")[:12000],
        }

    def _draft_metadata_path(self, draft_id: str) -> Path:
        return self.draft_root / str(draft_id) / "draft.json"

    def _save_metadata(self, draft_id: str, payload: Dict[str, Any]) -> None:
        path = self._draft_metadata_path(draft_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")

    def _load_metadata(self, draft_id: str) -> Dict[str, Any]:
        path = self._draft_metadata_path(draft_id)
        if not path.is_file() or path.is_symlink():
            return {}
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
            return value if isinstance(value, dict) else {}
        except (OSError, ValueError):
            return {}

    def _build_draft(
        self,
        *,
        draft_id: str,
        revision: int,
        title: str,
        goal_summary: str,
        encoded: Optional[bytes],
        filename: Optional[str],
        dataset_resource_id: Optional[str],
        dataset_filename: Optional[str],
        task_spec: Optional[Dict[str, Any]],
        missing_inputs: Optional[list[str]],
    ) -> Dict[str, Any]:
        method = self._write_draft_method(draft_id, revision, encoded, filename)
        missing = list(missing_inputs or [])
        if encoded is None and "method" not in missing:
            missing.append("method")
        if not dataset_resource_id and "dataset" not in missing:
            missing.append("dataset")
        return {
            "type": "task_draft" if revision == 1 else "task_draft_updated",
            "draft_id": draft_id,
            "session_id": self.session_id,
            "revision": revision,
            "status": "awaiting_user_confirmation" if revision == 1 else "revising",
            "title": (title.strip() or Path(filename or "execution-document.md").stem)[:255],
            "goal_summary": goal_summary.strip()[:4000],
            "method": method,
            "dataset": {"resource_id": dataset_resource_id, "filename": dataset_filename},
            "task_spec": task_spec if isinstance(task_spec, dict) else {},
            "missing_inputs": sorted(set(missing)),
        }

    def prepare_goal_driven_task(
        self,
        title: str,
        goal_summary: str,
        method_document: Optional[str] = None,
        method_document_ref: Optional[str] = None,
        dataset_resource_id: Optional[str] = None,
        dataset_filename: Optional[str] = None,
        task_spec: Optional[Dict[str, Any]] = None,
        missing_inputs: Optional[list[str]] = None,
    ) -> str:
        """Create a reviewable draft only; never queue a Task or publish an Outbox event."""
        normalized_dataset_id = str(dataset_resource_id or "").strip() or None
        if normalized_dataset_id:
            try:
                uuid.UUID(normalized_dataset_id)
            except ValueError:
                return _json({"type": "task_draft_error", "error": "dataset_resource_id is invalid"})
            if not self._find_resource(normalized_dataset_id):
                return _json({"type": "task_draft_error", "error": "dataset is not linked to this session"})
        try:
            encoded, filename = self._safe_document_bytes(method_document_ref, method_document)
            if encoded is None and not normalized_dataset_id:
                return _json({"type": "task_draft_error", "error": "method or dataset is required"})
            draft_id = str(uuid.uuid4())
            payload = self._build_draft(
                draft_id=draft_id,
                revision=1,
                title=str(title or ""),
                goal_summary=str(goal_summary or ""),
                encoded=encoded,
                filename=filename,
                dataset_resource_id=normalized_dataset_id,
                dataset_filename=dataset_filename,
                task_spec=task_spec,
                missing_inputs=missing_inputs,
            )
            self._save_metadata(draft_id, payload)
            return _json(payload)
        except (OSError, ValueError) as exc:
            return _json({"type": "task_draft_error", "error": str(exc)})

    def revise_goal_driven_task(
        self,
        draft_id: str,
        title: str,
        goal_summary: str,
        method_document: Optional[str] = None,
        method_document_ref: Optional[str] = None,
        dataset_resource_id: Optional[str] = None,
        dataset_filename: Optional[str] = None,
        task_spec: Optional[Dict[str, Any]] = None,
        missing_inputs: Optional[list[str]] = None,
    ) -> str:
        """Revise an existing unconfirmed draft and emit a new revision."""
        try:
            normalized_id = str(uuid.UUID(str(draft_id)))
        except (ValueError, AttributeError):
            return _json({"type": "task_draft_error", "error": "draft_id is invalid"})
        previous = self._load_metadata(normalized_id)
        if not previous or str(previous.get("session_id")) != self.session_id:
            return _json({"type": "task_draft_error", "error": "draft is not available in this session"})
        if previous.get("status") in {"cancelled", "confirmed", "expired"}:
            return _json({"type": "task_draft_error", "error": "draft is no longer editable"})
        try:
            encoded, filename = self._safe_document_bytes(method_document_ref, method_document)
            if encoded is None:
                current = previous.get("method") if isinstance(previous.get("method"), dict) else {}
                current_path = self._safe_session_path(str(current.get("relative_path") or ""))
                encoded = current_path.read_bytes() if current_path and current_path.is_file() else None
                filename = str(current.get("filename") or "execution-document.md") if encoded is not None else None
            current_dataset = previous.get("dataset") if isinstance(previous.get("dataset"), dict) else {}
            selected_dataset = str(dataset_resource_id or "").strip() or current_dataset.get("resource_id")
            if selected_dataset:
                uuid.UUID(str(selected_dataset))
                if not self._find_resource(str(selected_dataset)):
                    raise ValueError("dataset is not linked to this session")
            revision = int(previous.get("revision") or 1) + 1
            payload = self._build_draft(
                draft_id=normalized_id,
                revision=revision,
                title=str(title or previous.get("title") or ""),
                goal_summary=str(goal_summary or previous.get("goal_summary") or ""),
                encoded=encoded,
                filename=filename,
                dataset_resource_id=selected_dataset,
                dataset_filename=dataset_filename or current_dataset.get("filename"),
                task_spec=task_spec if isinstance(task_spec, dict) else previous.get("task_spec"),
                missing_inputs=missing_inputs,
            )
            self._save_metadata(normalized_id, payload)
            return _json(payload)
        except (OSError, ValueError) as exc:
            return _json({"type": "task_draft_error", "error": str(exc)})

    def cancel_goal_driven_task(self, draft_id: str) -> str:
        """Cancel an unconfirmed draft without creating any task-side record."""
        try:
            normalized_id = str(uuid.UUID(str(draft_id)))
        except (ValueError, AttributeError):
            return _json({"type": "task_draft_error", "error": "draft_id is invalid"})
        previous = self._load_metadata(normalized_id)
        if not previous or str(previous.get("session_id")) != self.session_id:
            return _json({"type": "task_draft_error", "error": "draft is not available in this session"})
        previous["status"] = "cancelled"
        self._save_metadata(normalized_id, previous)
        return _json({
            "type": "task_draft_cancelled",
            "draft_id": normalized_id,
            "session_id": self.session_id,
            "revision": int(previous.get("revision") or 1),
            "status": "cancelled",
        })
