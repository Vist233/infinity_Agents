"""Local Paper Workspace, Discovery, chat-event, and task compatibility API.

The Cloudflare implementation exposed these contracts from a Worker.  The
local implementation keeps the same JSON shapes, but makes PostgreSQL the
authority for state and :class:`LocalObjectStore` the only byte store.  The
routes are intentionally small and deterministic: uploads are bounded,
profiles are compiled locally, and a failed profile remains visible as a
durable failed record instead of disappearing into a background process.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse

from backend.auth import Principal, require_user
from backend.discovery.contracts import normalize_dataset_profile, normalize_paper_profile
from backend.discovery.dataset_inspector import DatasetInspectionError, inspect_path
from backend.discovery.evaluator import evaluate_feasibility
from backend.discovery.paper_profile import PaperProfileError, compile_paper_profile, profile_sha256, render_overview
from backend.paper_processor.ingest import ExtractionLimits, ProcessorError, extract_pdf
from backend.code_agent.models import TaskStatus
from backend.code_agent.task_service import (
    get_task as get_legacy_task,
    request_cancel_task,
    update_task_status,
)

from .object_store import LocalObjectStore, ObjectStoreError
from .repository import LocalRuntimeRepository, RuntimeConflict, RuntimeNotFound, hash_secret


MAX_PAPER_BYTES = 64 * 1024 * 1024
MAX_COLLECTION_BYTES = 25 * 1024 * 1024
MAX_MANIFEST_BYTES = 256 * 1024
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
SAFE_FILENAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._ -]{0,254}$")
PAPER_SOURCE_KINDS = {"arxiv", "pubmed_pmc", "user_upload", "approved_url"}
PAPER_STATUSES = {"requested", "downloading", "extracting", "uploading", "ready", "failed", "deleted", "cancelled"}


def _pool(request: Request):
    pool = getattr(request.app.state, "db_pool", None)
    if pool is None:
        raise HTTPException(status_code=503, detail="Database is not ready")
    return pool


def _store(request: Request) -> LocalObjectStore:
    store = getattr(request.app.state, "local_object_store", None)
    if store is None:
        root = os.getenv(
            "LOCAL_OBJECT_ROOT",
            os.getenv("ARTIFACT_STORAGE_ROOT", str(Path(__file__).resolve().parents[2] / "local-data" / "objects")),
        )
        store = LocalObjectStore(root)
        request.app.state.local_object_store = store
    return store


def _runtime_repo(request: Request) -> LocalRuntimeRepository:
    repository = getattr(request.app.state, "local_runtime_repository", None)
    if repository is None:
        repository = LocalRuntimeRepository(_pool(request))
        request.app.state.local_runtime_repository = repository
    return repository


def _uuid(value: str, code: str = "INVALID_ID") -> uuid.UUID:
    try:
        return uuid.UUID(str(value))
    except (ValueError, AttributeError, TypeError) as exc:
        raise HTTPException(status_code=400, detail=code) from exc


def _json_value(value: Any, default: Any = None) -> Any:
    if value is None:
        return default
    if isinstance(value, (dict, list)):
        return value
    if isinstance(value, str):
        try:
            return json.loads(value)
        except (TypeError, ValueError):
            return default
    return default


def _iso(value: Any) -> str | None:
    if value is None:
        return None
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return str(value)


def _epoch(value: Any) -> int:
    if value is None:
        return 0
    if hasattr(value, "timestamp"):
        return int(value.timestamp())
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def _safe_filename(value: Any, fallback: str) -> str:
    raw = str(value or "").replace("\\", "/").rsplit("/", 1)[-1].strip()
    if not raw or raw in {".", ".."}:
        raw = fallback
    raw = raw[:255]
    return raw if SAFE_FILENAME_RE.fullmatch(raw) else fallback


def _safe_error(code: str, message: str) -> tuple[str, str]:
    normalized = re.sub(r"[^A-Z0-9_]", "_", str(code or "PAPER_PROCESSOR_FAILED").upper())[:64] or "PROCESSING_FAILED"
    # Do not persist source URLs, local paths, or exception text in browser-visible fields.
    if re.search(r"https?://|file://|/tmp/|/var/|/Users/|token|secret|credential|object[_-]?key", message, re.I):
        message = "Processing failed."
    return normalized, re.sub(r"\s+", " ", str(message or "Processing failed")).strip()[:1024] or "Processing failed."


async def _legacy_artifact(pool: Any, artifact_id: str, user_id: str) -> Any:
    """Read an old artifact only after checking its task ownership."""
    allow_unowned_legacy = os.getenv("LOCAL_DEV_OPEN_TASK_API", "").strip().lower() in {"1", "true", "yes", "on"}
    try:
        async with pool.acquire() as connection:
            return await connection.fetchrow(
                """
                SELECT a.*
                FROM artifacts a
                JOIN tasks t ON t.task_id = a.task_id
                WHERE a.artifact_id = $1
                  AND (t.created_by = $2 OR ($3::boolean AND t.created_by IS NULL))
                """,
                artifact_id,
                user_id,
                allow_unowned_legacy,
            )
    except Exception:
        return None


def _legacy_artifact_path(storage_path: Any) -> Path:
    """Validate a compatibility artifact path without normalizing traversal."""
    allowed_root = Path(os.getenv("ARTIFACT_DOWNLOAD_ROOT", str(Path.cwd() / "local-data" / "task-outputs"))).resolve()
    original = Path(str(storage_path or ""))
    if not original.is_absolute():
        raise HTTPException(status_code=403, detail="Artifact path must be absolute")
    try:
        relative = original.relative_to(allowed_root)
    except ValueError as exc:
        raise HTTPException(status_code=403, detail="Artifact path is outside the allowed root") from exc
    if any(part in {".", ".."} for part in relative.parts) or original.is_symlink():
        raise HTTPException(status_code=403, detail="Artifact path is unsafe")
    resolved = original.resolve()
    if not resolved.is_relative_to(allowed_root) or not resolved.is_file() or resolved.is_symlink():
        raise HTTPException(status_code=404, detail="Artifact file not found")
    return resolved


async def _ensure_chat_session(pool, session_id: uuid.UUID, user_id: str, title: str = "New chat") -> None:
    await pool.execute(
        """
        INSERT INTO infinity_runtime.chat_sessions(session_id, user_id, title)
        VALUES ($1, $2, $3)
        ON CONFLICT (session_id) DO UPDATE SET user_id = EXCLUDED.user_id,
            title = CASE WHEN infinity_runtime.chat_sessions.title = 'New chat' THEN EXCLUDED.title ELSE infinity_runtime.chat_sessions.title END,
            updated_at = NOW()
        """,
        session_id, user_id, title[:255],
    )
    # Existing browser chat history still uses the compatibility table.  The
    # insert is best-effort because the canonical product tables are enough
    # for API-only deployments.
    try:
        await pool.execute(
            """
            INSERT INTO sessions(session_id, user_id, title, storage_mode)
            VALUES ($1, $2, $3, 'sandboxed')
            ON CONFLICT (session_id) DO NOTHING
            """,
            session_id, user_id, title[:255],
        )
    except Exception:
        pass


async def _audit(pool, resource_id: uuid.UUID, stage: str, outcome: str, error_code: str | None = None, metadata: dict[str, Any] | None = None, attempt_id: uuid.UUID | None = None) -> None:
    await pool.execute(
        """
        INSERT INTO infinity_runtime.paper_resource_audit_events
            (event_id, resource_id, attempt_id, stage, outcome, error_code, metadata_json)
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
        """,
        uuid.uuid4(), resource_id, attempt_id, stage, outcome, error_code,
        json.dumps(metadata or {}, ensure_ascii=False),
    )


async def _paper_row(pool, resource_id: uuid.UUID, user_id: str):
    return await pool.fetchrow(
        """
        SELECT r.*, COALESCE(c.paper_id, NULL) AS paper_id
        FROM infinity_runtime.paper_resources r
        LEFT JOIN infinity_runtime.paper_catalog c ON c.source_resource_id = r.resource_id
        WHERE r.resource_id = $1 AND r.user_id = $2
        """,
        resource_id, user_id,
    )


def _public_resource(row: Any) -> dict[str, Any]:
    return {
        "resource_id": str(row["resource_id"]),
        "session_id": str(row["session_id"]),
        "status": row["status"],
        "source_kind": row["source_kind"],
        "source_ref": row["source_ref"],
        "canonical_ref": row["canonical_ref"],
        "title": row["title"],
        "page_count": row["page_count"],
        "image_count": row["image_count"],
        "error_code": row["error_code"],
        "error_message_safe": row["error_message_safe"],
        "created_at": _iso(row["created_at"]),
        "updated_at": _iso(row["updated_at"]),
        "ready_at": _iso(row["ready_at"]),
    }


async def _process_paper(pool, store: LocalObjectStore, resource_id: uuid.UUID, user_id: str, paper_id: uuid.UUID | None = None) -> None:
    resource = await pool.fetchrow(
        "SELECT * FROM infinity_runtime.paper_resources WHERE resource_id = $1 AND user_id = $2",
        resource_id, user_id,
    )
    if not resource or not resource["pdf_object_key"]:
        raise RuntimeError("PAPER_SOURCE_NOT_FOUND")
    attempt_id = uuid.uuid4()
    lease_token = uuid.uuid4().hex
    await pool.execute(
        """
        INSERT INTO infinity_runtime.paper_processing_attempts
            (attempt_id, resource_id, processor_id, lease_token_hash, fencing_epoch, status, lease_expires_at)
        VALUES ($1, $2, 'local-api', $3, 1, 'claimed', NOW() + INTERVAL '15 minutes')
        """,
        attempt_id, resource_id, hash_secret(lease_token),
    )
    await pool.execute(
        "UPDATE infinity_runtime.paper_resources SET status = 'extracting', updated_at = NOW() WHERE resource_id = $1",
        resource_id,
    )
    await _audit(pool, resource_id, "extraction", "started", attempt_id=attempt_id)
    try:
        with tempfile.TemporaryDirectory(prefix="paper-local-", dir=str(store.root)) as temporary:
            source = Path(temporary) / "source.pdf"
            shutil.copyfile(store.read_path(resource["pdf_object_key"]), source)
            result = extract_pdf(
                source,
                Path(temporary) / "extracted",
                limits=ExtractionLimits(max_pdf_bytes=MAX_PAPER_BYTES),
                resource_id=str(resource_id),
            )
            text_key = f"papers/{resource_id}/text/pages.jsonl"
            image_manifest_key = f"papers/{resource_id}/images/manifest.json"
            store.write_bytes(text_key, result.text_pages_jsonl(), max_bytes=MAX_MANIFEST_BYTES)
            for image in result.images:
                image_path = Path(str(image["local_path"]))
                image_key = f"papers/{resource_id}/images/{image['image_id']}.{image_path.suffix.lstrip('.') or 'bin'}"
                store.write_bytes(image_key, image_path.read_bytes(), max_bytes=8 * 1024 * 1024)
                image["object_key"] = image_key
                image.pop("local_path", None)
            image_manifest = json.dumps({"resource_id": str(resource_id), "images": result.images}, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            store.write_bytes(image_manifest_key, image_manifest, max_bytes=MAX_MANIFEST_BYTES)
        await pool.execute(
            """
            UPDATE infinity_runtime.paper_resources
            SET status = 'ready', source_sha256 = $2, pdf_size_bytes = $3, pdf_sha256 = $2,
                text_manifest_key = $4, image_manifest_key = $5, page_count = $6,
                image_count = $7, error_code = NULL, error_message_safe = NULL,
                updated_at = NOW(), ready_at = NOW()
            WHERE resource_id = $1
            """,
            resource_id, result.source_sha256, result.source_size_bytes, text_key,
            image_manifest_key, len(result.pages), len(result.images),
        )
        for image in result.images:
            await pool.execute(
                """
                INSERT INTO infinity_runtime.paper_processor_objects
                    (resource_id, attempt_id, kind, object_id, object_key, size_bytes, sha256, content_type)
                VALUES ($1, $2, 'image', $3, $4, $5, $6, $7)
                ON CONFLICT (resource_id, kind, object_id) DO UPDATE SET object_key = EXCLUDED.object_key,
                    size_bytes = EXCLUDED.size_bytes, sha256 = EXCLUDED.sha256, content_type = EXCLUDED.content_type
                """,
                resource_id, attempt_id, image["image_id"], image["object_key"], image["size_bytes"], image["sha256"], image["content_type"],
            )
        await pool.execute(
            """
            INSERT INTO infinity_runtime.paper_processor_objects
                (resource_id, attempt_id, kind, object_id, object_key, size_bytes, sha256, content_type)
            VALUES ($1, $2, 'text_pages', 'pages', $3, $4, $5, 'application/x-ndjson')
            ON CONFLICT (resource_id, kind, object_id) DO UPDATE SET object_key = EXCLUDED.object_key,
                size_bytes = EXCLUDED.size_bytes, sha256 = EXCLUDED.sha256
            """,
            resource_id, attempt_id, text_key, len(result.text_pages_jsonl()), hashlib.sha256(result.text_pages_jsonl()).hexdigest(),
        )
        await _audit(pool, resource_id, "extraction", "succeeded", metadata={"page_count": len(result.pages), "image_count": len(result.images)}, attempt_id=attempt_id)
        if paper_id:
            try:
                profile = compile_paper_profile(
                    [str(page.get("text") or "") for page in result.pages],
                    str(resource_id),
                    input_sha256=result.source_sha256,
                )
                profile_key = f"discovery/papers/{paper_id}/profile.json"
                overview_key = f"discovery/papers/{paper_id}/overview.md"
                profile_bytes = json.dumps(profile, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
                overview_bytes = render_overview(profile).encode("utf-8")
                store.write_bytes(profile_key, profile_bytes, max_bytes=MAX_MANIFEST_BYTES)
                store.write_bytes(overview_key, overview_bytes, max_bytes=MAX_MANIFEST_BYTES)
                await pool.execute(
                    """
                    UPDATE infinity_runtime.paper_catalog
                    SET status = 'profiled', spam_status = 'scientific_paper', title = $2,
                        authors_json = $3::jsonb, year = $4, venue = $5,
                        profile_version = $6, profile_json = $7::jsonb, profile_sha256 = $8,
                        profile_object_key = $9, overview_object_key = $10, updated_at = NOW()
                    WHERE paper_id = $1 AND owner_user_id = $11
                    """,
                    paper_id, profile["paper"]["title"], json.dumps(profile["paper"]["authors"]),
                    profile["paper"]["year"], profile["paper"]["venue"], profile["profile_version"],
                    json.dumps(profile, ensure_ascii=False), profile_sha256(profile), profile_key, overview_key, user_id,
                )
                for module in profile["analysis_modules"]:
                    for capability in module["required_capabilities"]:
                        await pool.execute(
                            """
                            INSERT INTO infinity_runtime.paper_capabilities(paper_id, analysis_id, capability_key, requirement)
                            VALUES ($1, $2, $3, 'required') ON CONFLICT DO NOTHING
                            """,
                            paper_id, module["analysis_id"], capability,
                        )
                await _refresh_matches(pool, user_id)
            except PaperProfileError as exc:
                code, message = _safe_error(str(exc).split(" ", 1)[0], str(exc))
                await pool.execute(
                    "UPDATE infinity_runtime.paper_catalog SET status = 'failed', spam_status = $2, updated_at = NOW() WHERE paper_id = $1",
                    paper_id, "spam" if code == "DOCUMENT_GATE_SPAM" else "non_paper" if code == "DOCUMENT_GATE_NON_PAPER" else "invalid" if code.startswith("DOCUMENT_GATE_INVALID") else "review",
                )
                await pool.execute(
                    "UPDATE infinity_runtime.paper_resources SET error_code = $2, error_message_safe = $3, updated_at = NOW() WHERE resource_id = $1",
                    resource_id, code, message,
                )
        await pool.execute(
            "UPDATE infinity_runtime.paper_processing_attempts SET status = 'succeeded', finished_at = NOW(), lease_expires_at = NOW(), error_code = NULL, error_message_safe = NULL WHERE attempt_id = $1",
            attempt_id,
        )
    except (ProcessorError, ObjectStoreError, OSError, ValueError) as exc:
        code, message = _safe_error(getattr(exc, "code", "PAPER_PROCESSOR_FAILED"), str(exc))
        await pool.execute(
            """
            UPDATE infinity_runtime.paper_resources
            SET status = 'failed', error_code = $2, error_message_safe = $3, updated_at = NOW()
            WHERE resource_id = $1
            """,
            resource_id, code, message,
        )
        if paper_id:
            await pool.execute("UPDATE infinity_runtime.paper_catalog SET status = 'failed', spam_status = 'review', updated_at = NOW() WHERE paper_id = $1", paper_id)
        await pool.execute(
            "UPDATE infinity_runtime.paper_processing_attempts SET status = 'failed', finished_at = NOW(), error_code = $2, error_message_safe = $3, lease_expires_at = NOW() WHERE attempt_id = $1",
            attempt_id, code, message,
        )
        await _audit(pool, resource_id, "extraction", "failed", code, attempt_id=attempt_id)


def _public_paper(row: Any, *, include_profile: bool = False) -> dict[str, Any]:
    profile = _json_value(row["profile_json"]) if include_profile else None
    return {
        "paper_id": str(row["paper_id"]),
        "visibility": row["visibility"],
        "title": row["title"],
        "authors": _json_value(row["authors_json"], []),
        "year": row["year"],
        "venue": row["venue"],
        "status": row["status"],
        "spam_status": row["spam_status"],
        "profile_version": row["profile_version"],
        "profile": profile if isinstance(profile, dict) and normalize_paper_profile(profile) else None,
        "overview": None,
        "source_status": "ready" if row["status"] == "profiled" else row["status"],
        "source_resource_id": str(row["source_resource_id"]),
        "created_at": _epoch(row["created_at"]),
        "updated_at": _epoch(row["updated_at"]),
    }


async def _process_collection(pool, store: LocalObjectStore, collection_id: uuid.UUID, user_id: str) -> None:
    row = await pool.fetchrow("SELECT * FROM infinity_runtime.data_collections WHERE collection_id = $1 AND owner_user_id = $2", collection_id, user_id)
    if not row:
        return
    await pool.execute("UPDATE infinity_runtime.data_collections SET status = 'inspecting', updated_at = NOW() WHERE collection_id = $1", collection_id)
    try:
        profile = inspect_path(store.read_path(row["source_object_key"]), str(collection_id))
        profile_key = f"discovery/collections/{collection_id}/profile.json"
        profile_bytes = json.dumps(profile, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        store.write_bytes(profile_key, profile_bytes, max_bytes=MAX_MANIFEST_BYTES)
        await pool.execute(
            """
            UPDATE infinity_runtime.data_collections
            SET status = 'ready', profile_version = $2, profile_json = $3::jsonb,
                profile_sha256 = $4, profile_object_key = $5, error_code = NULL,
                error_message_safe = NULL, updated_at = NOW()
            WHERE collection_id = $1
            """,
            collection_id, profile["profile_version"], json.dumps(profile, ensure_ascii=False),
            hashlib.sha256(profile_bytes).hexdigest(), profile_key,
        )
        for key, value in profile.get("capabilities", {}).items():
            await pool.execute(
                """
                INSERT INTO infinity_runtime.dataset_capabilities(collection_id, capability_key, capability_value, confidence)
                VALUES ($1, $2, $3, 100) ON CONFLICT (collection_id, capability_key)
                DO UPDATE SET capability_value = EXCLUDED.capability_value, confidence = EXCLUDED.confidence
                """,
                collection_id, str(key)[:128], str(value)[:255],
            )
        await _refresh_matches(pool, user_id)
    except (DatasetInspectionError, ObjectStoreError, OSError, ValueError) as exc:
        code, message = _safe_error(getattr(exc, "code", "DATASET_INSPECTION_FAILED"), str(exc))
        await pool.execute(
            """
            UPDATE infinity_runtime.data_collections
            SET status = 'failed', error_code = $2, error_message_safe = $3, updated_at = NOW()
            WHERE collection_id = $1
            """,
            collection_id, code, message,
        )


async def _refresh_matches(pool, user_id: str) -> None:
    rows = await pool.fetch(
        """
        SELECT p.paper_id, p.profile_version, c.collection_id, c.profile_version AS dataset_profile_version
        FROM infinity_runtime.paper_catalog p CROSS JOIN infinity_runtime.data_collections c
        WHERE p.owner_user_id = $1 AND c.owner_user_id = $1
          AND p.status = 'profiled' AND c.status = 'ready'
        """,
        user_id,
    )
    for row in rows:
        await pool.execute(
            """
            INSERT INTO infinity_runtime.research_matches
                (match_id, paper_id, collection_id, paper_profile_version, dataset_profile_version, candidate_reason)
            VALUES ($1, $2, $3, $4, $5, 'Candidate created from compatible local profiles.')
            ON CONFLICT (paper_id, collection_id, paper_profile_version, dataset_profile_version) DO NOTHING
            """,
            uuid.uuid4(), row["paper_id"], row["collection_id"], row["profile_version"], row["dataset_profile_version"],
        )


def _public_collection(row: Any, *, include_profile: bool = False) -> dict[str, Any]:
    profile = _json_value(row["profile_json"]) if include_profile else None
    return {
        "collection_id": str(row["collection_id"]),
        "name": row["name"],
        "source_filename": row["source_filename"],
        "source_content_type": row["source_content_type"],
        "source_size_bytes": row["source_size_bytes"],
        "status": row["status"],
        "profile_version": row["profile_version"],
        "profile": profile if isinstance(profile, dict) and normalize_dataset_profile(profile, str(row["collection_id"])) else None,
        "error": {"code": row["error_code"], "message": row["error_message_safe"] or "Inspection failed."} if row["error_code"] else None,
        "created_at": _epoch(row["created_at"]),
        "updated_at": _epoch(row["updated_at"]),
    }


def _public_match(row: Any) -> dict[str, Any]:
    return {
        "match_id": str(row["match_id"]),
        "paper_id": str(row["paper_id"]),
        "collection_id": str(row["collection_id"]),
        "paper_profile_version": row["paper_profile_version"],
        "dataset_profile_version": row["dataset_profile_version"],
        "status": row["status"],
        "hard_gate": row["hard_gate"],
        "coverage_ratio": float(row["coverage_ratio"]),
        "execution_confidence": row["execution_confidence"],
        "scientific_fit": row["scientific_fit"],
        "evaluator_version": row["evaluator_version"],
        "evaluation_json": json.dumps(_json_value(row["evaluation_json"]), ensure_ascii=False) if row["evaluation_json"] is not None else None,
        "created_task_id": str(row["created_task_id"]) if row["created_task_id"] else None,
        "candidate_reason": row["candidate_reason"],
        "created_at": _epoch(row["created_at"]),
        "updated_at": _epoch(row["updated_at"]),
    }


async def _local_task(pool, task_id: uuid.UUID, user_id: str):
    return await pool.fetchrow(
        """
        SELECT t.*, s.goal, s.execution_document, s.dataset_resource_id, s.method_resource_id
        FROM infinity_runtime.tasks t JOIN infinity_runtime.task_specs s ON s.task_spec_id = t.task_spec_id
        WHERE t.task_id = $1 AND t.created_by = $2
        """,
        task_id, user_id,
    )


def _public_local_task(row: Any) -> dict[str, Any]:
    retryable = row["status"] in {"failed", "timeout"} and (int(row["attempt_count"]) < int(row["max_attempts"]) or not bool(row["retry_override_used"]))
    return {
        "task_id": str(row["task_id"]),
        "task_spec_id": str(row["task_spec_id"]),
        "dataset_snapshot_id": str(row["dataset_resource_id"]),
        "project_id": "local-runtime",
        "method_source_id": str(row["method_resource_id"]) if row["method_resource_id"] else None,
        "title": row["title"],
        "status": row["status"],
        "attempt_count": row["attempt_count"],
        "max_attempts": row["max_attempts"],
        "can_retry": retryable,
        "retry_reason": row["retry_reason"],
        "error_message": row["error_detail"],
        "created_by": row["created_by"],
        "created_at": _iso(row["created_at"]),
        "updated_at": _iso(row["updated_at"]),
        "finished_at": _iso(row["finished_at"]),
    }


def _legacy_task(row: Any) -> dict[str, Any]:
    return {
        "task_id": str(row["task_id"]), "task_spec_id": str(row["task_spec_id"]),
        "dataset_snapshot_id": str(row["dataset_snapshot_id"]), "project_id": str(row["project_id"]),
        "method_source_id": str(row["method_source_id"]) if row["method_source_id"] else None,
        "title": row["title"], "status": row["status"], "attempt_count": row["attempt_count"],
        "max_attempts": row["max_attempts"], "can_retry": row["status"] in {"failed", "timeout"},
        "retry_reason": None, "error_message": row["error_message"],
        "created_by": row["created_by"], "created_at": _iso(row["created_at"]),
        "updated_at": _iso(row["updated_at"]), "finished_at": _iso(row["finished_at"]),
    }


def create_product_router() -> APIRouter:
    router = APIRouter()

    @router.post("/api/paper/resources")
    async def create_paper_resource(request: Request, user: Principal = Depends(require_user)):
        body = await request.json()
        if not isinstance(body, dict):
            raise HTTPException(status_code=400, detail="Body must be JSON")
        source_kind = str(body.get("source_kind") or "").strip()
        source_ref = str(body.get("source_ref") or "").strip()
        if source_kind not in PAPER_SOURCE_KINDS or not source_ref or source_kind == "approved_url":
            raise HTTPException(status_code=400, detail="Invalid paper resource metadata")
        session_id = _uuid(str(body.get("session_id") or ""), "INVALID_SESSION_ID")
        pool = _pool(request)
        await _ensure_chat_session(pool, session_id, user.user_id, str(body.get("title") or "New chat"))
        resource_id = uuid.uuid4()
        row = await pool.fetchrow(
            """
            INSERT INTO infinity_runtime.paper_resources
                (resource_id, session_id, user_id, source_kind, source_ref, canonical_ref, title)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING *
            """,
            resource_id, session_id, user.user_id, source_kind, source_ref,
            str(body.get("canonical_ref") or "").strip() or None,
            str(body.get("title") or "").strip()[:512] or None,
        )
        purpose = str(body.get("purpose") or "read")
        if purpose not in {"search_result", "read", "upload"}:
            purpose = "read"
        await pool.execute(
            "INSERT INTO infinity_runtime.paper_resource_links(session_id, resource_id, purpose) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
            session_id, resource_id, purpose,
        )
        await _audit(pool, resource_id, "materialize", "succeeded")
        return JSONResponse(status_code=201, content=_public_resource(row))

    @router.get("/api/paper/resources/{resource_id}")
    async def get_paper_resource(resource_id: str, request: Request, user: Principal = Depends(require_user)):
        row = await _paper_row(_pool(request), _uuid(resource_id), user.user_id)
        if not row:
            raise HTTPException(status_code=404, detail="Paper resource not found")
        return _public_resource(row)

    @router.get("/api/paper/resources/{resource_id}/progress")
    async def paper_progress(resource_id: str, request: Request, session_id: str = Query(...), user: Principal = Depends(require_user)):
        pool = _pool(request)
        resource_uuid = _uuid(resource_id)
        session_uuid = _uuid(session_id, "Invalid session ID format")
        row = await pool.fetchrow(
            """
            SELECT r.* FROM infinity_runtime.paper_resources r
            JOIN infinity_runtime.paper_resource_links l ON l.resource_id = r.resource_id AND l.session_id = $2
            WHERE r.resource_id = $1 AND r.user_id = $3
            """,
            resource_uuid, session_uuid, user.user_id,
        )
        if not row:
            raise HTTPException(status_code=404, detail="Paper resource not found")
        events = await pool.fetch(
            "SELECT event_id, stage, outcome, error_code, created_at FROM infinity_runtime.paper_resource_audit_events WHERE resource_id = $1 ORDER BY created_at ASC LIMIT 50",
            resource_uuid,
        )
        continuations = await pool.fetch(
            "SELECT continuation_id, turn_id, status, expires_at, updated_at, completed_at FROM infinity_runtime.paper_request_continuations WHERE resource_id = $1 AND session_id = $2 ORDER BY created_at DESC LIMIT 20",
            resource_uuid, session_uuid,
        )
        continuation_json = [{
            "continuation_id": str(item["continuation_id"]), "original_turn_id": item["turn_id"], "status": item["status"],
            "expires_at": _epoch(item["expires_at"]), "updated_at": _epoch(item["updated_at"]), "completed_at": _epoch(item["completed_at"]) if item["completed_at"] else None,
        } for item in continuations]
        event_json = [{"event_id": str(item["event_id"]), "stage": item["stage"], "outcome": item["outcome"], "error_code": item["error_code"], "created_at": _epoch(item["created_at"])} for item in events]
        ready = row["status"] == "ready"
        resumable = next((item for item in continuation_json if item["status"] == "ready" and item["expires_at"] > int(datetime.now(timezone.utc).timestamp())), None)
        revision = f"{_iso(row['updated_at'])}:{max([item['updated_at'] for item in continuation_json] or [0])}:{max([item['created_at'] for item in event_json] or [0])}"
        return {
            "resource": {"resource_id": str(row["resource_id"]), "status": row["status"], "stage": row["status"], "source_kind": row["source_kind"], "title": row["title"], "page_count": row["page_count"], "image_count": row["image_count"], "error": {"code": row["error_code"], "message": row["error_message_safe"] or "Paper processing failed."} if row["error_code"] else None, "created_at": _epoch(row["created_at"]), "updated_at": _epoch(row["updated_at"]), "ready_at": _epoch(row["ready_at"]) if row["ready_at"] else None},
            "revision": revision,
            "materialize": {"invocation_status": "succeeded" if any(item["stage"] == "materialize" and item["outcome"] == "succeeded" for item in event_json) else "not_recorded", "invocation_event_id": next((item["event_id"] for item in event_json if item["stage"] == "materialize" and item["outcome"] == "succeeded"), None), "invoked_at": next((item["created_at"] for item in event_json if item["stage"] == "materialize" and item["outcome"] == "succeeded"), None), "resource_ready": ready},
            "correlation": {"continuations": continuation_json}, "events": event_json,
            "resume": {"available": bool(resumable), "continuation_id": resumable["continuation_id"] if resumable else None, "method": "POST", "path": f"/api/paper/continuations/{resumable['continuation_id']}" if resumable else None, "body": {"session_id": session_id} if resumable else None, "reason_code": None if resumable else "PAPER_CONTINUATION_NOT_READY"},
        }

    @router.get("/api/paper/resources/{resource_id}/manifest")
    async def paper_manifest(resource_id: str, request: Request, session_id: str = Query(...), user: Principal = Depends(require_user)):
        pool = _pool(request)
        row = await _paper_row(pool, _uuid(resource_id), user.user_id)
        if not row or str(row["session_id"]) != session_id:
            raise HTTPException(status_code=404, detail="Paper resource not found")
        if row["status"] != "ready" or not row["text_manifest_key"]:
            raise HTTPException(status_code=409, detail="Paper resource is not ready")
        try:
            raw = _store(request).read_path(row["text_manifest_key"]).read_bytes()
        except ObjectStoreError as exc:
            raise HTTPException(status_code=404, detail="Paper manifest not found") from exc
        if len(raw) > MAX_MANIFEST_BYTES:
            raise HTTPException(status_code=422, detail="Paper manifest is too large")
        return JSONResponse(content={"resource_id": resource_id, "text_pages_jsonl": raw.decode("utf-8", errors="replace")})

    @router.get("/api/paper/resources/{resource_id}/object")
    async def paper_object(resource_id: str, request: Request, session_id: str = Query(...), kind: str = Query("source_pdf"), user: Principal = Depends(require_user)):
        row = await _paper_row(_pool(request), _uuid(resource_id), user.user_id)
        if not row or str(row["session_id"]) != session_id:
            raise HTTPException(status_code=404, detail="Paper resource not found")
        key = {"source_pdf": row["pdf_object_key"], "text_manifest": row["text_manifest_key"], "image_manifest": row["image_manifest_key"]}.get(kind)
        if not key:
            raise HTTPException(status_code=404, detail="Paper object not found")
        try:
            path = _store(request).read_path(key)
        except ObjectStoreError as exc:
            raise HTTPException(status_code=404, detail="Paper object not found") from exc
        return FileResponse(str(path), media_type="application/pdf" if kind == "source_pdf" else "application/json")

    @router.put("/api/paper/resources/{resource_id}/object")
    async def upload_paper_object(resource_id: str, request: Request, session_id: str = Query(...), kind: str = Query("source_pdf"), user: Principal = Depends(require_user)):
        if kind != "source_pdf":
            raise HTTPException(status_code=400, detail="Only source_pdf uploads are supported")
        pool = _pool(request)
        resource_uuid = _uuid(resource_id)
        row = await _paper_row(pool, resource_uuid, user.user_id)
        if not row or str(row["session_id"]) != session_id:
            raise HTTPException(status_code=404, detail="Paper resource not found")
        if row["source_kind"] != "user_upload" or row["status"] not in {"requested", "uploading"} or row["pdf_object_key"]:
            raise HTTPException(status_code=409, detail="Paper upload state conflict")
        key = f"papers/{resource_uuid}/source.pdf"
        try:
            size, digest = await _store(request).write_stream(key, request.stream(), max_bytes=MAX_PAPER_BYTES)
        except ObjectStoreError as exc:
            raise HTTPException(status_code=413, detail="Paper upload exceeds the 64 MB limit") from exc
        if size <= 0:
            _store(request).delete(key)
            raise HTTPException(status_code=400, detail="Paper upload is empty")
        await pool.execute("UPDATE infinity_runtime.paper_resources SET status = 'uploading', pdf_object_key = $2, source_sha256 = $3, updated_at = NOW() WHERE resource_id = $1", resource_uuid, key, digest)
        await _audit(pool, resource_uuid, "upload", "succeeded", metadata={"size_bytes": size})
        await _process_paper(pool, _store(request), resource_uuid, user.user_id, uuid.UUID(str(row["paper_id"])) if row["paper_id"] else None)
        return _public_resource(await _paper_row(pool, resource_uuid, user.user_id))

    @router.post("/api/paper/resources/{resource_id}/cancel")
    async def cancel_paper(resource_id: str, request: Request, user: Principal = Depends(require_user)):
        pool = _pool(request)
        resource_uuid = _uuid(resource_id)
        row = await _paper_row(pool, resource_uuid, user.user_id)
        if not row:
            raise HTTPException(status_code=404, detail="Paper resource not found")
        await pool.execute("UPDATE infinity_runtime.paper_resources SET status = 'cancelled', updated_at = NOW() WHERE resource_id = $1 AND status NOT IN ('ready', 'deleted')", resource_uuid)
        await _audit(pool, resource_uuid, "cancel", "cancelled")
        return {"resource_id": resource_id, "status": "cancelled"}

    @router.delete("/api/paper/resources/{resource_id}")
    async def delete_paper(resource_id: str, request: Request, user: Principal = Depends(require_user)):
        pool = _pool(request)
        resource_uuid = _uuid(resource_id)
        row = await _paper_row(pool, resource_uuid, user.user_id)
        if not row:
            raise HTTPException(status_code=404, detail="Paper resource not found")
        for key in (row["pdf_object_key"], row["text_manifest_key"], row["image_manifest_key"]):
            if key:
                _store(request).delete(key)
        _store(request).delete(f"papers/{resource_uuid}/source.pdf")
        await pool.execute("UPDATE infinity_runtime.paper_resources SET status = 'deleted', updated_at = NOW() WHERE resource_id = $1", resource_uuid)
        await _audit(pool, resource_uuid, "delete", "succeeded")
        return {"resource_id": resource_id, "status": "deleted"}

    @router.post("/api/paper/continuations/{continuation_id}")
    async def resume_paper_continuation(continuation_id: str, request: Request, user: Principal = Depends(require_user)):
        body = await request.json()
        session_uuid = _uuid(str((body or {}).get("session_id") or ""), "INVALID_SESSION_ID")
        pool = _pool(request)
        continuation_uuid = _uuid(continuation_id)
        row = await pool.fetchrow(
            """
            SELECT c.*, r.status AS resource_status FROM infinity_runtime.paper_request_continuations c
            JOIN infinity_runtime.paper_resources r ON r.resource_id = c.resource_id
            WHERE c.continuation_id = $1 AND c.session_id = $2 AND c.user_id = $3
            """,
            continuation_uuid, session_uuid, user.user_id,
        )
        if not row:
            raise HTTPException(status_code=404, detail="Paper continuation not found")
        if row["resource_status"] != "ready":
            raise HTTPException(status_code=409, detail="Paper resource is not ready")
        await pool.execute("UPDATE infinity_runtime.paper_request_continuations SET status = 'completed', completed_at = NOW(), updated_at = NOW() WHERE continuation_id = $1", continuation_uuid)
        payload = {"continuation_id": continuation_id, "status": "completed", "resource_id": str(row["resource_id"])}
        return StreamingResponse(iter([f"event: done\ndata: {json.dumps(payload)}\n\n"]), media_type="text/event-stream")

    @router.get("/api/discovery/papers")
    async def list_discovery_papers(request: Request, user: Principal = Depends(require_user)):
        rows = await _pool(request).fetch("SELECT * FROM infinity_runtime.paper_catalog WHERE owner_user_id = $1 AND status <> 'deleted' ORDER BY created_at DESC LIMIT 200", user.user_id)
        return {"papers": [_public_paper(row) for row in rows]}

    @router.post("/api/discovery/papers")
    async def upload_discovery_paper(request: Request, file: UploadFile = File(...), title: str | None = Form(None), user: Principal = Depends(require_user)):
        body = await file.read(MAX_PAPER_BYTES + 1)
        if not body or len(body) > MAX_PAPER_BYTES:
            raise HTTPException(status_code=413, detail="Uploaded paper is too large or empty")
        if body[:5] != b"%PDF-":
            raise HTTPException(status_code=422, detail="The uploaded file is not a PDF")
        digest = hashlib.sha256(body).hexdigest()
        pool, store = _pool(request), _store(request)
        duplicate = await pool.fetchrow(
            """
            SELECT c.* FROM infinity_runtime.paper_catalog c
            JOIN infinity_runtime.paper_resources r ON r.resource_id = c.source_resource_id
            WHERE c.owner_user_id = $1 AND r.source_sha256 = $2 AND c.status <> 'deleted'
            ORDER BY c.created_at DESC LIMIT 1
            """,
            user.user_id, digest,
        )
        if duplicate:
            return {**_public_paper(duplicate, include_profile=True), "duplicate": True}
        paper_id, resource_id, session_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        paper_title = (str(title or "").strip() or Path(_safe_filename(file.filename, "paper.pdf")).stem or "Uploaded paper")[:512]
        await _ensure_chat_session(pool, session_id, user.user_id, f"Paper: {paper_title}")
        resource_key = f"papers/{resource_id}/source.pdf"
        store.write_bytes(resource_key, body, max_bytes=MAX_PAPER_BYTES)
        await pool.execute(
            """
            INSERT INTO infinity_runtime.paper_resources
                (resource_id, session_id, user_id, source_kind, source_ref, title, status, source_sha256, pdf_object_key, pdf_size_bytes, pdf_sha256)
            VALUES ($1, $2, $3, 'user_upload', $4, $5, 'uploading', $6, $7, $8, $6)
            """,
            resource_id, session_id, user.user_id, f"discovery-upload:{digest}", paper_title, digest, resource_key, len(body),
        )
        await pool.execute("INSERT INTO infinity_runtime.paper_resource_links(session_id, resource_id, purpose) VALUES ($1, $2, 'upload')", session_id, resource_id)
        await pool.execute(
            "INSERT INTO infinity_runtime.paper_catalog(paper_id, owner_user_id, source_resource_id, title) VALUES ($1, $2, $3, $4)",
            paper_id, user.user_id, resource_id, paper_title,
        )
        await _audit(pool, resource_id, "materialize", "succeeded")
        await _process_paper(pool, store, resource_id, user.user_id, paper_id)
        row = await pool.fetchrow("SELECT * FROM infinity_runtime.paper_catalog WHERE paper_id = $1", paper_id)
        return {**_public_paper(row, include_profile=True), "source_resource_id": str(resource_id), "source_filename": _safe_filename(file.filename, "paper.pdf"), "duplicate": False}

    @router.get("/api/discovery/papers/{paper_id}")
    async def get_discovery_paper(paper_id: str, request: Request, user: Principal = Depends(require_user)):
        row = await _pool(request).fetchrow("SELECT * FROM infinity_runtime.paper_catalog WHERE paper_id = $1 AND owner_user_id = $2 AND status <> 'deleted'", _uuid(paper_id), user.user_id)
        if not row:
            raise HTTPException(status_code=404, detail="Paper not found")
        result = _public_paper(row, include_profile=True)
        if row["overview_object_key"]:
            try:
                result["overview"] = _store(request).read_path(row["overview_object_key"]).read_text(encoding="utf-8")[:MAX_MANIFEST_BYTES]
            except (ObjectStoreError, OSError):
                pass
        return result

    @router.delete("/api/discovery/papers/{paper_id}")
    async def delete_discovery_paper(paper_id: str, request: Request, user: Principal = Depends(require_user)):
        pool = _pool(request)
        row = await pool.fetchrow("SELECT * FROM infinity_runtime.paper_catalog WHERE paper_id = $1 AND owner_user_id = $2 AND status <> 'deleted'", _uuid(paper_id), user.user_id)
        if not row:
            raise HTTPException(status_code=404, detail="Paper not found")
        await pool.execute("UPDATE infinity_runtime.paper_catalog SET status = 'deleted', updated_at = NOW() WHERE paper_id = $1", _uuid(paper_id))
        await pool.execute("UPDATE infinity_runtime.paper_resources SET status = 'deleted', updated_at = NOW() WHERE resource_id = $1", row["source_resource_id"])
        return {"paper_id": paper_id, "status": "deleted"}

    @router.get("/api/discovery/data-collections")
    async def list_discovery_collections(request: Request, user: Principal = Depends(require_user)):
        rows = await _pool(request).fetch("SELECT * FROM infinity_runtime.data_collections WHERE owner_user_id = $1 AND status <> 'deleted' ORDER BY created_at DESC LIMIT 200", user.user_id)
        return {"collections": [_public_collection(row) for row in rows]}

    @router.post("/api/discovery/data-collections")
    async def upload_discovery_collection(request: Request, file: UploadFile = File(...), name: str | None = Form(None), user: Principal = Depends(require_user)):
        body = await file.read(MAX_COLLECTION_BYTES + 1)
        if not body or len(body) > MAX_COLLECTION_BYTES:
            raise HTTPException(status_code=413, detail="Uploaded data collection is too large or empty")
        filename = _safe_filename(file.filename, "data.csv")
        is_zip = body[:4] == b"PK\x03\x04" or filename.lower().endswith(".zip")
        if not is_zip and not re.search(r"\.(csv|tsv|json|jsonl|txt|md|readme)$", filename, re.I):
            raise HTTPException(status_code=422, detail="Only CSV, TSV, JSON, TXT, or ZIP uploads are supported")
        digest = hashlib.sha256(body).hexdigest()
        pool, store = _pool(request), _store(request)
        duplicate = await pool.fetchrow("SELECT * FROM infinity_runtime.data_collections WHERE owner_user_id = $1 AND source_sha256 = $2 AND status <> 'deleted'", user.user_id, digest)
        if duplicate:
            return {**_public_collection(duplicate, include_profile=True), "duplicate": True}
        collection_id = uuid.uuid4()
        safe_name = _safe_filename(filename, "data.zip" if is_zip else "data.csv")
        content_type = file.content_type or ("application/zip" if is_zip else "text/csv")
        source_key = f"datasets/{collection_id}/source/{safe_name}"
        store.write_bytes(source_key, body, max_bytes=MAX_COLLECTION_BYTES)
        row = await pool.fetchrow(
            """
            INSERT INTO infinity_runtime.data_collections
                (collection_id, owner_user_id, name, source_object_key, source_filename, source_content_type, source_sha256, source_size_bytes)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *
            """,
            collection_id, user.user_id, (str(name or "").strip() or safe_name)[:255], source_key, safe_name, content_type[:128], digest, len(body),
        )
        await _process_collection(pool, store, collection_id, user.user_id)
        row = await pool.fetchrow("SELECT * FROM infinity_runtime.data_collections WHERE collection_id = $1", collection_id)
        return {**_public_collection(row, include_profile=True), "duplicate": False}

    @router.get("/api/discovery/data-collections/{collection_id}")
    async def get_discovery_collection(collection_id: str, request: Request, user: Principal = Depends(require_user)):
        row = await _pool(request).fetchrow("SELECT * FROM infinity_runtime.data_collections WHERE collection_id = $1 AND owner_user_id = $2 AND status <> 'deleted'", _uuid(collection_id), user.user_id)
        if not row:
            raise HTTPException(status_code=404, detail="Data collection not found")
        return _public_collection(row, include_profile=True)

    @router.delete("/api/discovery/data-collections/{collection_id}")
    async def delete_discovery_collection(collection_id: str, request: Request, user: Principal = Depends(require_user)):
        pool = _pool(request)
        row = await pool.fetchrow("SELECT * FROM infinity_runtime.data_collections WHERE collection_id = $1 AND owner_user_id = $2 AND status <> 'deleted'", _uuid(collection_id), user.user_id)
        if not row:
            raise HTTPException(status_code=404, detail="Data collection not found")
        _store(request).delete(row["source_object_key"])
        if row["profile_object_key"]:
            _store(request).delete(row["profile_object_key"])
        await pool.execute("UPDATE infinity_runtime.data_collections SET status = 'deleted', updated_at = NOW() WHERE collection_id = $1", _uuid(collection_id))
        return {"collection_id": collection_id, "status": "deleted"}

    @router.get("/api/discovery/matches")
    async def list_discovery_matches(request: Request, user: Principal = Depends(require_user)):
        rows = await _pool(request).fetch(
            """
            SELECT m.* FROM infinity_runtime.research_matches m
            JOIN infinity_runtime.paper_catalog p ON p.paper_id = m.paper_id
            WHERE p.owner_user_id = $1 ORDER BY m.updated_at DESC LIMIT 200
            """,
            user.user_id,
        )
        return {"matches": [_public_match(row) for row in rows]}

    @router.get("/api/discovery/matches/{match_id}")
    async def get_discovery_match(match_id: str, request: Request, user: Principal = Depends(require_user)):
        row = await _pool(request).fetchrow(
            """
            SELECT m.* FROM infinity_runtime.research_matches m JOIN infinity_runtime.paper_catalog p ON p.paper_id = m.paper_id
            WHERE m.match_id = $1 AND p.owner_user_id = $2
            """,
            _uuid(match_id), user.user_id,
        )
        if not row:
            raise HTTPException(status_code=404, detail="Research match was not found")
        return {"match": _public_match(row)}

    @router.post("/api/discovery/matches/{match_id}/evaluate")
    async def evaluate_discovery_match(match_id: str, request: Request, user: Principal = Depends(require_user)):
        pool = _pool(request)
        row = await pool.fetchrow(
            """
            SELECT m.*, p.profile_json AS paper_profile, c.profile_json AS dataset_profile
            FROM infinity_runtime.research_matches m JOIN infinity_runtime.paper_catalog p ON p.paper_id = m.paper_id
            JOIN infinity_runtime.data_collections c ON c.collection_id = m.collection_id
            WHERE m.match_id = $1 AND p.owner_user_id = $2
            """,
            _uuid(match_id), user.user_id,
        )
        if not row:
            raise HTTPException(status_code=404, detail="Research match was not found")
        paper, dataset = _json_value(row["paper_profile"]), _json_value(row["dataset_profile"])
        if not normalize_paper_profile(paper) or not normalize_dataset_profile(dataset, str(row["collection_id"])):
            raise HTTPException(status_code=409, detail="Profiles are not ready")
        evaluation = evaluate_feasibility(paper, dataset, environment={"supports_tabular": True})
        evaluation_key = f"discovery/matches/{match_id}/evaluation.json"
        evaluation_bytes = json.dumps(evaluation, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        _store(request).write_bytes(evaluation_key, evaluation_bytes, max_bytes=MAX_MANIFEST_BYTES)
        await pool.execute(
            """
            UPDATE infinity_runtime.research_matches
            SET status = 'evaluated', hard_gate = $2, coverage_ratio = $3,
                execution_confidence = $4, scientific_fit = $5, evaluator_version = $6,
                evaluation_json = $7::jsonb, evaluation_object_key = $8,
                candidate_reason = $9, updated_at = NOW()
            WHERE match_id = $1
            """,
            _uuid(match_id), evaluation["hard_gate"], evaluation["coverage"]["ratio"], evaluation["execution_confidence"], evaluation["scientific_fit"], evaluation["evaluator_version"], json.dumps(evaluation), evaluation_key, evaluation["reason"],
        )
        fresh = await pool.fetchrow("SELECT * FROM infinity_runtime.research_matches WHERE match_id = $1", _uuid(match_id))
        return {"match_id": match_id, "status": fresh["status"], "queued": False, "evaluation": evaluation}

    @router.post("/api/discovery/matches/{match_id}/create-task")
    async def create_discovery_task(match_id: str, request: Request, user: Principal = Depends(require_user)):
        pool, store = _pool(request), _store(request)
        row = await pool.fetchrow(
            """
            SELECT m.*, p.title, p.profile_json, p.profile_object_key, p.source_resource_id,
                   c.name AS collection_name, c.source_object_key, c.source_filename, c.source_size_bytes, c.source_sha256
            FROM infinity_runtime.research_matches m JOIN infinity_runtime.paper_catalog p ON p.paper_id = m.paper_id
            JOIN infinity_runtime.data_collections c ON c.collection_id = m.collection_id
            WHERE m.match_id = $1 AND p.owner_user_id = $2
            """,
            _uuid(match_id), user.user_id,
        )
        if not row:
            raise HTTPException(status_code=404, detail="Research match was not found")
        if row["status"] == "task_created" and row["created_task_id"]:
            return {"match_id": match_id, "task_id": str(row["created_task_id"]), "status": "task_created", "duplicate": True}
        if row["hard_gate"] != "pass" or float(row["coverage_ratio"]) < 0.6 or int(row["execution_confidence"] or 0) < 60:
            raise HTTPException(status_code=409, detail="Research match has not passed the execution gate")
        profile_key = row["profile_object_key"]
        dataset_key = row["source_object_key"]
        if not profile_key or not store.exists(profile_key) or not store.exists(dataset_key):
            raise HTTPException(status_code=409, detail="Task inputs are not available")
        profile_path = store.read_path(profile_key)
        dataset_size = int(row["source_size_bytes"])
        if dataset_size > MAX_COLLECTION_BYTES:
            raise HTTPException(status_code=413, detail="Dataset exceeds the local Worker input limit")
        async with pool.acquire() as connection:
            async with connection.transaction():
                method_id = await connection.fetchval(
                    """
                    INSERT INTO infinity_runtime.resources(resource_id, owner_user_id, kind, logical_name, object_key, content_type, file_size_bytes, checksum_sha256, state)
                    VALUES ($1, $2, 'method', $3, $4, 'application/json', $5, $6, 'ready')
                    ON CONFLICT (object_key) DO UPDATE SET state = 'ready' RETURNING resource_id
                    """,
                    uuid.uuid5(uuid.NAMESPACE_URL, f"infinity:paper-profile:{row['paper_id']}:{row['paper_profile_version']}"), user.user_id, f"{row['title']}.profile.json", profile_key, profile_path.stat().st_size, hashlib.sha256(profile_path.read_bytes()).hexdigest(),
                )
                dataset_id = await connection.fetchval(
                    """
                    INSERT INTO infinity_runtime.resources(resource_id, owner_user_id, kind, logical_name, object_key, content_type, file_size_bytes, checksum_sha256, state)
                    VALUES ($1, $2, 'dataset', $3, $4, 'application/octet-stream', $5, $6, 'ready')
                    ON CONFLICT (object_key) DO UPDATE SET state = 'ready' RETURNING resource_id
                    """,
                    uuid.uuid5(uuid.NAMESPACE_URL, f"infinity:dataset:{row['collection_id']}:{row['dataset_profile_version']}"), user.user_id, row["source_filename"], dataset_key, dataset_size, row["source_sha256"],
                )
        task_id = await _runtime_repo(request).create_task(
            created_by=user.user_id,
            title=f"Reproduce: {row['title']} on {row['collection_name']}",
            goal="Reproduce the paper's analysis against the selected local data collection.",
            execution_document={"source": "discovery", "match_id": match_id, "paper_id": str(row["paper_id"]), "collection_id": str(row["collection_id"]), "evaluation": _json_value(row["evaluation_json"], {})},
            dataset_resource_id=uuid.UUID(str(dataset_id)), method_resource_id=uuid.UUID(str(method_id)),
        )
        await pool.execute("UPDATE infinity_runtime.research_matches SET status = 'task_created', created_task_id = $2, updated_at = NOW() WHERE match_id = $1", _uuid(match_id), task_id)
        return {"match_id": match_id, "task_id": str(task_id), "status": "task_created", "duplicate": False}

    @router.get("/api/sessions/{session_id}/messages")
    async def get_canonical_session_history(session_id: str, request: Request, user: Principal = Depends(require_user)):
        """Expose legacy messages together with durable canonical event history."""
        pool = _pool(request)
        session_uuid = _uuid(session_id, "Invalid session ID format")
        session = await pool.fetchrow(
            "SELECT session_id, title FROM infinity_runtime.chat_sessions WHERE session_id = $1 AND user_id = $2",
            session_uuid, user.user_id,
        )
        if not session:
            # Sessions created before the product migration remain readable;
            # materialize their canonical owner row on first access.
            try:
                legacy_session = await pool.fetchrow(
                    "SELECT session_id, title FROM sessions WHERE session_id = $1 AND user_id = $2",
                    session_uuid, user.user_id,
                )
            except Exception:
                legacy_session = None
            if legacy_session:
                await _ensure_chat_session(
                    pool,
                    session_uuid,
                    user.user_id,
                    str(legacy_session["title"] or "New chat"),
                )
                session = await pool.fetchrow(
                    "SELECT session_id, title FROM infinity_runtime.chat_sessions WHERE session_id = $1 AND user_id = $2",
                    session_uuid, user.user_id,
                )
        if not session:
            raise HTTPException(status_code=404, detail="Session not found")
        try:
            messages = await pool.fetch(
                "SELECT role, content, created_at FROM messages WHERE session_id = $1 ORDER BY message_id ASC LIMIT 500",
                session_uuid,
            )
        except Exception:
            messages = []
        if not messages:
            messages = await pool.fetch(
                "SELECT role, content, created_at FROM infinity_runtime.chat_events WHERE session_id = $1 AND event_type IN ('user_message', 'assistant_message') ORDER BY event_id ASC LIMIT 500",
                session_uuid,
            )
        timeline_rows = await pool.fetch(
            """
            SELECT event_id, session_id, turn_id, event_type, tool_call_id, tool_name,
                   status, result_summary, tool_arguments_json
            FROM infinity_runtime.chat_events
            WHERE session_id = $1 AND event_type IN ('tool_call', 'tool_result')
            ORDER BY event_id ASC LIMIT 100
            """,
            session_uuid,
        )
        events = [{
            "session_id": str(row["session_id"]), "event_id": row["event_id"], "turn_id": row["turn_id"],
            "event_type": row["event_type"], "tool_call_id": row["tool_call_id"], "tool_name": row["tool_name"],
            "status": row["status"] or "unknown", "summary": row["result_summary"] or "",
            **({"arguments_summary": row["tool_arguments_json"]} if row["tool_arguments_json"] else {}),
        } for row in timeline_rows]
        return {
            "messages": [{"role": row["role"], "content": row["content"]} for row in messages if row["role"] in {"user", "assistant"}],
            "events": events,
            "paper_tasks": [],
            "legacy_text_only": False,
        }

    @router.get("/api/tasks")
    async def list_local_and_legacy_tasks(request: Request, limit: int = Query(50, ge=1, le=100), user: Principal = Depends(require_user)):
        pool = _pool(request)
        try:
            local_rows = await pool.fetch(
                """
                SELECT t.*, s.goal, s.execution_document, s.dataset_resource_id, s.method_resource_id
                FROM infinity_runtime.tasks t JOIN infinity_runtime.task_specs s ON s.task_spec_id = t.task_spec_id
                WHERE t.created_by = $1 ORDER BY t.created_at DESC LIMIT $2
                """,
                user.user_id, limit,
            )
        except AttributeError:
            # Legacy test doubles and explicitly compatibility-only pools do
            # not expose the canonical fetch surface.
            return {"tasks": []}
        items = [_public_local_task(row) for row in local_rows]
        # Keep old Task Center submissions visible while new Discovery tasks
        # use the canonical runtime queue.
        try:
            legacy_rows = await pool.fetch(
                "SELECT task_id, task_spec_id, dataset_snapshot_id, project_id, method_source_id, title, status, attempt_count, max_attempts, error_message, created_by, created_at, updated_at, finished_at FROM tasks WHERE created_by = $1 ORDER BY created_at DESC LIMIT $2",
                user.user_id, limit,
            )
            items.extend(_legacy_task(row) for row in legacy_rows)
        except Exception:
            pass
        items.sort(key=lambda item: item.get("created_at") or "", reverse=True)
        return {"tasks": items[:limit]}

    @router.get("/api/tasks/{task_id}")
    async def get_local_or_legacy_task(task_id: str, request: Request, user: Principal = Depends(require_user)):
        pool = _pool(request)
        try:
            parsed = _uuid(task_id)
        except HTTPException as exc:
            raise HTTPException(status_code=404, detail="Task not found") from exc
        row = await _local_task(pool, parsed, user.user_id)
        if row:
            return _public_local_task(row)
        try:
            legacy = await pool.fetchrow("SELECT task_id, task_spec_id, dataset_snapshot_id, project_id, method_source_id, title, status, attempt_count, max_attempts, error_message, created_by, created_at, updated_at, finished_at FROM tasks WHERE task_id = $1 AND created_by = $2", parsed, user.user_id)
        except Exception:
            legacy = None
        if not legacy:
            raise HTTPException(status_code=404, detail="Task not found")
        return _legacy_task(legacy)

    @router.get("/api/tasks/{task_id}/events")
    async def get_local_or_legacy_events(task_id: str, request: Request, limit: int = Query(100, ge=1, le=500), user: Principal = Depends(require_user)):
        pool = _pool(request)
        try:
            parsed = _uuid(task_id)
        except HTTPException:
            return []
        local = await _local_task(pool, parsed, user.user_id)
        if local:
            rows = await pool.fetch("SELECT task_event_id, task_id, attempt_id, event_type, event_data, created_at FROM infinity_runtime.task_events WHERE task_id = $1 ORDER BY created_at ASC LIMIT $2", parsed, limit)
            return [{"task_event_id": str(row["task_event_id"]), "task_id": str(row["task_id"]), "task_attempt_id": str(row["attempt_id"]) if row["attempt_id"] else None, "event_type": row["event_type"], "event_data": _json_value(row["event_data"], {}), "created_at": _iso(row["created_at"])} for row in rows]
        try:
            rows = await pool.fetch("SELECT task_event_id, task_id, task_attempt_id, event_type, event_data, created_at FROM task_events WHERE task_id = $1 ORDER BY created_at ASC LIMIT $2", parsed, limit)
        except Exception:
            rows = []
        return [{"task_event_id": row["task_event_id"], "task_id": str(row["task_id"]), "task_attempt_id": row["task_attempt_id"], "event_type": row["event_type"], "event_data": _json_value(row["event_data"], {}), "created_at": _iso(row["created_at"])} for row in rows]

    @router.get("/api/tasks/{task_id}/artifacts")
    async def get_local_or_legacy_artifacts(task_id: str, request: Request, user: Principal = Depends(require_user)):
        pool = _pool(request)
        try:
            parsed = _uuid(task_id)
        except HTTPException:
            return []
        local = await _local_task(pool, parsed, user.user_id)
        if local:
            rows = await pool.fetch(
                "SELECT artifact_id, name, kind, file_size_bytes, checksum_sha256, created_at FROM infinity_runtime.artifacts WHERE task_id = $1 ORDER BY created_at DESC",
                parsed,
            )
            return [{"artifact_id": str(row["artifact_id"]), "name": row["name"], "kind": row["kind"], "file_size_bytes": row["file_size_bytes"], "checksum_sha256": row["checksum_sha256"], "created_at": _iso(row["created_at"])} for row in rows]
        try:
            rows = await pool.fetch(
                "SELECT artifact_id, name, kind, file_size_bytes, checksum_sha256, created_at FROM artifacts WHERE task_id = $1 ORDER BY created_at DESC",
                parsed,
            )
        except Exception:
            rows = []
        return [{"artifact_id": str(row["artifact_id"]), "name": row["name"], "kind": row["kind"], "file_size_bytes": row["file_size_bytes"], "checksum_sha256": row["checksum_sha256"], "created_at": _iso(row["created_at"])} for row in rows]

    @router.get("/api/artifacts/{artifact_id}")
    async def download_local_artifact(artifact_id: str, request: Request, user: Principal = Depends(require_user)):
        pool = _pool(request)
        parsed = None
        try:
            parsed = _uuid(artifact_id)
        except HTTPException:
            pass
        row = None
        if parsed is not None:
            row = await pool.fetchrow(
                """
                SELECT a.* FROM infinity_runtime.artifacts a
                JOIN infinity_runtime.tasks t ON t.task_id = a.task_id
                WHERE a.artifact_id = $1 AND t.created_by = $2
                """,
                parsed, user.user_id,
            )
        if row:
            try:
                path = _store(request).read_path(row["object_key"])
            except ObjectStoreError as exc:
                raise HTTPException(status_code=404, detail="Artifact file not found") from exc
            return FileResponse(str(path), media_type=row["content_type"], filename=row["name"])

        legacy = await _legacy_artifact(pool, artifact_id, user.user_id)
        if not legacy:
            raise HTTPException(status_code=404, detail="Artifact not found")
        path = _legacy_artifact_path(legacy["storage_path"])
        return FileResponse(
            str(path),
            media_type=legacy["content_type"] or "application/zip",
            filename=f"{legacy['name'] or 'artifact'}.zip",
        )

    @router.post("/api/tasks/{task_id}/retry")
    async def retry_local_task(task_id: str, request: Request, user: Principal = Depends(require_user)):
        try:
            row = await _runtime_repo(request).retry_task_for_user(_uuid(task_id), user.user_id)
        except RuntimeNotFound as exc:
            raise HTTPException(status_code=404, detail="Task not found") from exc
        except RuntimeConflict as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        full = await _local_task(_pool(request), _uuid(task_id), user.user_id)
        return _public_local_task(full or row)

    @router.post("/api/tasks/{task_id}/cancel")
    async def cancel_local_task(task_id: str, request: Request, user: Principal = Depends(require_user)):
        pool = _pool(request)
        try:
            parsed = _uuid(task_id)
        except HTTPException:
            legacy = await get_legacy_task(pool, task_id)
            local_dev_open = os.getenv("LOCAL_DEV_OPEN_TASK_API", "").strip().lower() in {"1", "true", "yes", "on"}
            if not legacy or (
                legacy.get("created_by") != user.user_id
                and not (local_dev_open and legacy.get("created_by") is None)
            ):
                raise HTTPException(status_code=404, detail="Task not found")
            if legacy["status"] not in {"queued", "claimed", "running"}:
                raise HTTPException(status_code=400, detail=f"Cannot cancel task in status: {legacy['status']}")
            if legacy["status"] == "queued":
                result = await update_task_status(pool, task_id, TaskStatus.CANCELLED)
                if not result:
                    raise HTTPException(status_code=400, detail="Failed to cancel task")
                return {"task_id": task_id, "status": "cancelled"}
            result = await request_cancel_task(pool, task_id)
            if not result:
                raise HTTPException(status_code=400, detail="Failed to request cancellation")
            return {"task_id": task_id, "status": result["status"], "cancel_requested": True}
        row = await _local_task(pool, parsed, user.user_id)
        if not row:
            raise HTTPException(status_code=404, detail="Task not found")
        if row["status"] in {"succeeded", "failed", "cancelled", "timeout"}:
            raise HTTPException(status_code=409, detail="Task is already terminal")
        if row["status"] == "queued":
            await pool.execute("UPDATE infinity_runtime.tasks SET status = 'cancelled', finished_at = NOW(), updated_at = NOW() WHERE task_id = $1", parsed)
        else:
            await pool.execute("UPDATE infinity_runtime.tasks SET cancel_requested_at = NOW(), updated_at = NOW() WHERE task_id = $1", parsed)
        fresh = await _local_task(pool, parsed, user.user_id)
        return _public_local_task(fresh)

    @router.get("/api/health/local-runtime")
    async def local_runtime_health(request: Request):
        pool = _pool(request)
        try:
            await pool.fetchval("SELECT 1 FROM infinity_runtime.schema_migrations LIMIT 1")
            return {"status": "ok", "database": "postgresql", "object_store": str(_store(request).root)}
        except Exception as exc:
            raise HTTPException(status_code=503, detail="Local runtime is not ready") from exc

    return router
