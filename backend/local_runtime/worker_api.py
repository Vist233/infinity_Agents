"""Local Worker v2 HTTP API equivalent to the Cloudflare Edge contract.

Same routes, headers and JSON shapes as `cloudflare-worker/src/worker-v2.ts`,
backed by the canonical PostgreSQL runtime and a controlled local object
store. The same Docker Worker image can point `WORKER_CONTROL_BASE_URL` at
this app and run without any Cloudflare credential.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import secrets
import uuid
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any, AsyncIterator

import asyncpg
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

from .api_repository import LocalRuntimeApiRepository
from .migrations import apply_migrations
from .object_store import LocalObjectStore, ObjectStoreError
from .outbox_redis import LocalOutboxPublisher, read_hints
from .repository import (
    PROTOCOL_VERSION,
    RUNTIME_CAPABILITY,
    RuntimeConflict,
    RuntimeNotFound,
    RuntimeUnauthorized,
    SessionContext,
    hash_secret,
)


WORKER_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
MAX_PART_BYTES = 16 * 1024 * 1024
MAX_ARTIFACT_MANIFEST_BYTES = 256 * 1024
MAX_ERROR_LENGTH = 500
DEFAULT_ARTIFACT_MAX_BYTES = 2 * 1024 * 1024 * 1024
FORBIDDEN_BODY_FIELDS = {
    "namespace", "pool_id", "pool", "provider", "provider_id", "trust_level",
    "worker_kind", "created_by", "owner_user_id", "redis_url", "database_url",
    "account_token", "r2_prefix", "d1_database_id",
}


def artifact_limit() -> int:
    try:
        configured = int(os.getenv("LOCAL_ARTIFACT_MAX_BYTES", str(DEFAULT_ARTIFACT_MAX_BYTES)))
    except ValueError:
        configured = DEFAULT_ARTIFACT_MAX_BYTES
    return configured if configured > 0 else DEFAULT_ARTIFACT_MAX_BYTES


def error_json(message: str, status_code: int, code: str) -> JSONResponse:
    return JSONResponse(status_code=status_code, content={"error": {"code": code, "message": message}})


def _unix(value: Any) -> int:
    return int(value.timestamp())


def _bearer_credential(request: Request) -> str | None:
    header = request.headers.get("authorization") or ""
    if not header.startswith("Bearer "):
        return None
    value = header[len("Bearer "):].strip()
    return value if 16 <= len(value) <= 512 else None


async def _body_json(request: Request) -> dict[str, Any] | None:
    try:
        value = await request.json()
        return value if isinstance(value, dict) else None
    except Exception:
        return None


def _forbidden_fields(body: dict[str, Any] | None) -> JSONResponse | None:
    if body and any(key in body for key in FORBIDDEN_BODY_FIELDS):
        return error_json("Worker infrastructure fields are server-controlled", 400, "WORKER_METADATA_FORBIDDEN")
    return None


def _safe_artifact_name(value: Any) -> str | None:
    name = str(value or "").replace("\\", "/").rsplit("/", 1)[-1].strip()
    if not name or len(name) > 240 or name in {".", ".."}:
        return None
    return name


def _error_text(value: Any, fallback: str) -> str:
    text = re.sub(r"[\u0000-\u001f\u007f]", " ", str(value or "")).strip()
    return (text or fallback)[:MAX_ERROR_LENGTH]


@dataclass(frozen=True)
class AuthenticatedSession:
    worker: asyncpg.Record
    session: asyncpg.Record
    context: SessionContext


@dataclass(frozen=True)
class ClaimShim:
    """Claim-shaped object for repository.renew_task; the lease token is already hashed."""

    task_id: uuid.UUID
    attempt_id: uuid.UUID
    lease_token_hash: str
    fencing_epoch: int


class WorkerV2Api:
    def __init__(self, repository: LocalRuntimeApiRepository, store: LocalObjectStore) -> None:
        self.repository = repository
        self.store = store

    async def authenticate_session(self, request: Request) -> AuthenticatedSession | JSONResponse:
        worker_id = (request.headers.get("x-worker-id") or "").strip()
        instance_id = (request.headers.get("x-worker-instance-id") or "").strip()
        session_id = (request.headers.get("x-worker-session-id") or "").strip()
        credential = _bearer_credential(request)
        if not worker_id or not WORKER_ID_RE.fullmatch(worker_id) or not instance_id or not session_id or not credential:
            return error_json("Worker credentials and session headers are required", 401, "WORKER_AUTH_REQUIRED")
        worker = await self.repository.load_active_worker(worker_id, credential)
        if not worker:
            return error_json("Worker credential is invalid or revoked", 401, "WORKER_AUTH_INVALID")
        protocol = request.headers.get("x-worker-protocol-version")
        capability = request.headers.get("x-worker-runtime-capability")
        if protocol != PROTOCOL_VERSION or capability != RUNTIME_CAPABILITY:
            return error_json("Worker protocol is incompatible", 409, "WORKER_PROTOCOL_INCOMPATIBLE")
        image = request.headers.get("x-worker-image-digest")
        if worker["image_digest"] and image != worker["image_digest"]:
            return error_json("Worker image is incompatible", 409, "WORKER_IMAGE_INCOMPATIBLE")
        session = await self.repository.get_live_session(session_id, worker_id)
        if not session or session["session_secret_hash"] != hash_secret(session_id):
            return error_json("Worker session is expired or invalid", 401, "WORKER_SESSION_INVALID")
        if session["instance_id"] != instance_id:
            return error_json("Worker session binding is invalid", 403, "WORKER_SESSION_MISMATCH")
        epoch_header = request.headers.get("x-worker-session-epoch")
        if epoch_header and (not epoch_header.isdigit() or int(epoch_header) != session["session_epoch"]):
            return error_json("Worker session epoch is stale", 409, "WORKER_SESSION_STALE")
        context = SessionContext(worker_id, session_id, int(session["session_epoch"]), instance_id)
        return AuthenticatedSession(worker, session, context)

    async def authenticate_attempt(
        self,
        request: Request,
        auth: AuthenticatedSession,
        task_id: uuid.UUID,
        body: dict[str, Any] | None,
        *,
        allow_succeeded: bool = False,
    ) -> tuple[asyncpg.Record, str] | JSONResponse:
        attempt_header = (request.headers.get("x-worker-attempt-id") or "").strip()
        lease_header = (request.headers.get("x-worker-lease-token") or "").strip()
        attempt_text = attempt_header or str((body or {}).get("attempt_id") or "")
        lease_text = lease_header or str((body or {}).get("lease_token") or "")
        if not UUID_RE.fullmatch(attempt_text) or not lease_text:
            return error_json("Attempt and lease credentials are required", 401, "ATTEMPT_AUTH_REQUIRED")
        try:
            attempt = await self.repository.authenticate_attempt(
                auth.context, task_id, uuid.UUID(attempt_text), lease_text,
                allow_succeeded=allow_succeeded,
            )
        except RuntimeConflict:
            return error_json("Attempt lease is invalid or expired", 409, "ATTEMPT_FENCING_REJECTED")
        return attempt, hash_secret(lease_text)

    async def connect(self, request: Request) -> JSONResponse:
        body = await _body_json(request)
        forbidden = _forbidden_fields(body)
        if forbidden:
            return forbidden
        worker_id = str((body or {}).get("worker_id") or "").strip()
        instance_id = str((body or {}).get("instance_id") or "").strip()
        protocol = str((body or {}).get("protocol_version") or "").strip()
        capability = str((body or {}).get("runtime_capability") or "").strip()
        image_digest = str((body or {}).get("image_digest") or "").strip() or None
        credential = _bearer_credential(request)
        if not worker_id or not WORKER_ID_RE.fullmatch(worker_id) or not instance_id or not credential:
            return error_json("worker_id, instance_id, and persistent credential are required", 400, "WORKER_CONNECT_INVALID")
        if protocol != PROTOCOL_VERSION or capability != RUNTIME_CAPABILITY:
            return error_json("Worker protocol or runtime is incompatible", 409, "WORKER_PROTOCOL_INCOMPATIBLE")
        try:
            context, created = await self.repository.connect_worker(
                worker_id=worker_id,
                credential=credential,
                instance_id=instance_id,
                protocol_version=protocol,
                runtime_capability=capability,
                image_digest=image_digest,
            )
        except RuntimeUnauthorized:
            return error_json("Worker credential is invalid or revoked", 401, "WORKER_AUTH_INVALID")
        except RuntimeConflict as exc:
            return error_json(str(exc), 409, str(exc))
        session = await self.repository.get_live_session(context.session_id, worker_id)
        payload = {
            "worker_id": worker_id,
            "pool_id": context.pool_id,
            "namespace": context.namespace,
            "session_id": context.session_id,
            "session_epoch": context.session_epoch,
            "lease_expires_at": _unix(session["lease_expires_at"]),
            "protocol_version": PROTOCOL_VERSION,
            "runtime_capability": RUNTIME_CAPABILITY,
            "ready": True,
            "persistent_credential": True,
        }
        return JSONResponse(status_code=201 if created else 200, content=payload)

    async def heartbeat(self, auth: AuthenticatedSession, request: Request) -> JSONResponse:
        body = await _body_json(request)
        forbidden = _forbidden_fields(body)
        if forbidden:
            return forbidden
        if not await self.repository.touch_session(auth.context):
            return error_json("Worker session was superseded", 409, "WORKER_SESSION_STALE")
        session = await self.repository.get_live_session(auth.context.session_id, auth.context.worker_id)
        return JSONResponse(content={
            "worker_id": auth.context.worker_id,
            "pool_id": auth.context.pool_id,
            "namespace": auth.context.namespace,
            "status": "ready",
            "lease_expires_at": _unix(session["lease_expires_at"]),
        })

    async def poll(self, auth: AuthenticatedSession, request: Request) -> JSONResponse:
        body = await _body_json(request)
        forbidden = _forbidden_fields(body)
        if forbidden:
            return forbidden
        if not await self.repository.touch_session(auth.context):
            return error_json("Worker session was superseded", 409, "WORKER_SESSION_STALE")
        rows = await self.repository.poll_queued_tasks(auth.context, limit=1)
        tasks = [{
            "task_id": str(row["task_id"]),
            "task_spec_id": str(row["task_spec_id"]),
            "dataset_snapshot_id": str(row["dataset_resource_id"]),
            "method_source_id": str(row["method_resource_id"]) if row["method_resource_id"] else None,
            "title": row["title"],
            "attempt_count": row["attempt_count"],
            "max_attempts": row["max_attempts"],
            "pool_id": auth.context.pool_id,
        } for row in rows]
        return JSONResponse(content={"tasks": tasks, "next_poll_seconds": 1 if tasks else 5})

    async def accept(self, auth: AuthenticatedSession, task_id: uuid.UUID, request: Request) -> JSONResponse:
        body = await _body_json(request)
        forbidden = _forbidden_fields(body)
        if forbidden:
            return forbidden
        try:
            claim = await self.repository.claim_task(auth.context, task_id)
        except RuntimeNotFound:
            return error_json("Task not found", 404, "TASK_NOT_FOUND")
        except RuntimeConflict as exc:
            code = str(exc) if str(exc) in {"TASK_NOT_AVAILABLE", "TASK_CLAIM_CONFLICT", "WORKER_SESSION_STALE"} else "TASK_CLAIM_CONFLICT"
            return error_json("Task is no longer available", 409, code)
        attempt = await self.repository.pool.fetchrow(
            "SELECT lease_expires_at FROM infinity_runtime.task_attempts WHERE attempt_id = $1",
            claim.attempt_id,
        )
        return JSONResponse(status_code=201, content={
            "task_id": str(task_id),
            "attempt_id": str(claim.attempt_id),
            "lease_token": claim.lease_token,
            "fencing_epoch": claim.fencing_epoch,
            "lease_expires_at": _unix(attempt["lease_expires_at"]),
            "attempt_number": claim.attempt_number,
            "status": "claimed",
        })

    async def renew(self, auth: AuthenticatedSession, task_id: uuid.UUID, request: Request) -> JSONResponse:
        body = await _body_json(request)
        forbidden = _forbidden_fields(body)
        if forbidden:
            return forbidden
        result = await self.authenticate_attempt(request, auth, task_id, body)
        if isinstance(result, JSONResponse):
            return result
        attempt, lease_hash = result
        claim = ClaimShim(task_id, attempt["attempt_id"], lease_hash, int(attempt["fencing_epoch"]))
        try:
            await self.repository.renew_attempt(auth.context, claim)
        except RuntimeConflict:
            return error_json("Attempt lease is stale", 409, "ATTEMPT_FENCING_REJECTED")
        refreshed = await self.repository.pool.fetchrow(
            "SELECT lease_expires_at FROM infinity_runtime.task_attempts WHERE attempt_id = $1",
            attempt["attempt_id"],
        )
        return JSONResponse(content={
            "task_id": str(task_id),
            "attempt_id": str(attempt["attempt_id"]),
            "lease_expires_at": _unix(refreshed["lease_expires_at"]),
            "status": "running",
        })

    async def spec(self, auth: AuthenticatedSession, task_id: uuid.UUID, request: Request) -> JSONResponse:
        result = await self.authenticate_attempt(request, auth, task_id, None)
        if isinstance(result, JSONResponse):
            return result
        attempt, _lease_hash = result
        row = await self.repository.get_spec_for_attempt(auth.context, task_id, attempt)
        if not row:
            return error_json("Task spec is no longer available", 409, "ATTEMPT_FENCING_REJECTED")
        method = None
        if row["method_name"] and row["method_state"] == "ready":
            method = {
                "logical_name": row["method_name"],
                "file_size_bytes": row["method_size"],
                "sha256": row["method_sha256"],
            }
        execution_document = row["execution_document"]
        if isinstance(execution_document, str):
            try:
                execution_document = json.loads(execution_document)
            except ValueError:
                execution_document = {}
        return JSONResponse(content={
            "task_id": str(task_id),
            "attempt_id": str(attempt["attempt_id"]),
            "fencing_epoch": int(attempt["fencing_epoch"]),
            "cancel_requested": row["cancel_requested_at"] is not None,
            "task_spec": {
                "title": row["title"],
                "analysis_type": "generic",
                "research_question": row["goal"],
                "goal": row["goal"],
                "execution_document": execution_document or {},
            },
            "inputs": {
                "method": method,
                "dataset": {
                    "logical_name": row["dataset_name"],
                    "file_size_bytes": row["dataset_size"],
                    "sha256": row["dataset_sha256"],
                },
            },
        })

    async def input_stream(self, auth: AuthenticatedSession, task_id: uuid.UUID, kind: str, request: Request):
        result = await self.authenticate_attempt(request, auth, task_id, None)
        if isinstance(result, JSONResponse):
            return result
        attempt, _lease_hash = result
        row = await self.repository.get_input_for_attempt(auth.context, task_id, attempt, kind)
        if not row or row["state"] != "ready":
            return error_json("Task input not found", 404, "TASK_INPUT_NOT_FOUND")
        try:
            path = self.store.read_path(row["object_key"])
        except ObjectStoreError:
            return error_json("Task input object not found", 404, "TASK_INPUT_NOT_FOUND")
        if path.stat().st_size != row["file_size_bytes"]:
            return error_json("Task input object is inconsistent", 409, "TASK_INPUT_NOT_FOUND")

        async def stream() -> AsyncIterator[bytes]:
            with path.open("rb") as handle:
                while True:
                    chunk = handle.read(1024 * 1024)
                    if not chunk:
                        break
                    yield chunk

        safe_name = str(row["logical_name"]).replace('"', "_")
        return StreamingResponse(
            stream(),
            media_type=row["content_type"],
            headers={
                "cache-control": "no-store",
                "content-length": str(row["file_size_bytes"]),
                "content-disposition": f'attachment; filename="{safe_name}"',
                "x-infinity-sha256": row["checksum_sha256"],
            },
        )

    async def start_artifact(self, auth: AuthenticatedSession, task_id: uuid.UUID, request: Request) -> JSONResponse:
        body = await _body_json(request)
        forbidden = _forbidden_fields(body)
        if forbidden:
            return forbidden
        result = await self.authenticate_attempt(request, auth, task_id, body)
        if isinstance(result, JSONResponse):
            return result
        attempt, lease_hash = result
        body = body or {}
        name = _safe_artifact_name(body.get("name"))
        kind = str(body.get("kind") or "").strip()
        content_type = str(body.get("content_type") or "").strip() or "application/zip"
        expected_size = body.get("expected_size_bytes")
        expected_sha = str(body.get("expected_sha256") or "").strip().lower()
        manifest = body.get("manifest")
        manifest_ok = isinstance(manifest, dict) and len(json.dumps(manifest).encode("utf-8")) <= MAX_ARTIFACT_MANIFEST_BYTES
        if (
            not name or not kind
            or not isinstance(expected_size, int) or expected_size <= 0 or expected_size > artifact_limit()
            or not SHA256_RE.fullmatch(expected_sha) or not manifest_ok
        ):
            return error_json("Invalid artifact metadata", 400, "INVALID_ARTIFACT_METADATA")
        upload_id = uuid.uuid4()
        artifact_id = uuid.uuid4()
        object_key = f"task-artifacts/{task_id}/{attempt['attempt_id']}/{upload_id}-{name}"
        part_size = MAX_PART_BYTES
        part_count = max(1, math.ceil(expected_size / part_size))
        try:
            await self.repository.start_artifact_upload(
                auth.context, task_id, attempt, lease_hash,
                upload_id=upload_id, artifact_id=artifact_id, object_key=object_key,
                name=name, kind=kind, content_type=content_type,
                expected_size_bytes=expected_size, expected_sha256=expected_sha,
                manifest=manifest, part_size_bytes=part_size, part_count=part_count,
            )
        except RuntimeConflict:
            return error_json("Artifact lease is invalid", 409, "ATTEMPT_FENCING_REJECTED")
        except asyncpg.UniqueViolationError:
            return error_json("An artifact upload is already open for this attempt", 409, "ARTIFACT_UPLOAD_EXISTS")
        return JSONResponse(status_code=201, content={
            "upload_id": str(upload_id),
            "object_key": object_key,
            "part_size_bytes": part_size,
            "expected_size_bytes": expected_size,
        })

    async def artifact_part(
        self, auth: AuthenticatedSession, upload_id: uuid.UUID, part_number: int, request: Request
    ) -> JSONResponse:
        if part_number <= 0 or part_number > 10000:
            return error_json("Invalid artifact part number", 400, "INVALID_ARTIFACT_PART")
        content_length = int(request.headers.get("content-length") or 0)
        if content_length > MAX_PART_BYTES:
            return error_json("Artifact part is too large", 413, "ARTIFACT_PART_TOO_LARGE")
        upload = await self.repository.get_artifact_upload(upload_id, auth.context.worker_id)
        if not upload or upload["status"] != "open" or upload["finalize_owner"] is not None:
            return error_json("Artifact upload not found", 404, "ARTIFACT_UPLOAD_NOT_FOUND")
        result = await self.authenticate_attempt(request, auth, upload["task_id"], None)
        if isinstance(result, JSONResponse):
            return result
        attempt, lease_hash = result
        if attempt["attempt_id"] != upload["attempt_id"]:
            return error_json("Artifact lease is invalid", 409, "ATTEMPT_FENCING_REJECTED")
        digest = hashlib.sha256()
        chunks: list[bytes] = []
        total = 0
        async for chunk in request.stream():
            total += len(chunk)
            if total > MAX_PART_BYTES:
                return error_json("Artifact part is too large", 413, "ARTIFACT_PART_TOO_LARGE")
            digest.update(chunk)
            chunks.append(chunk)
        if total <= 0 or (content_length > 0 and total != content_length):
            return error_json("Artifact part size is invalid", 400, "INVALID_ARTIFACT_PART")
        data = b"".join(chunks)
        sha256 = digest.hexdigest()
        try:
            part_key = self.store.part_key(str(upload_id), part_number)
            self.store.write_part(str(upload_id), part_number, data)
            await self.repository.save_artifact_part(
                auth.context, upload, attempt, lease_hash,
                part_number=part_number, part_object_key=part_key,
                size_bytes=total, checksum_sha256=sha256,
            )
        except RuntimeConflict:
            return error_json("Artifact lease is stale", 409, "ATTEMPT_FENCING_REJECTED")
        except ObjectStoreError:
            return error_json("Artifact part upload failed", 503, "ARTIFACT_UPLOAD_UNAVAILABLE")
        return JSONResponse(content={
            "upload_id": str(upload_id),
            "part_number": part_number,
            "etag": sha256,
            "size_bytes": total,
            "sha256": sha256,
        })

    async def complete_artifact(self, auth: AuthenticatedSession, upload_id: uuid.UUID, request: Request) -> JSONResponse:
        body = await _body_json(request)
        forbidden = _forbidden_fields(body)
        if forbidden:
            return forbidden
        upload = await self.repository.get_artifact_upload(upload_id, auth.context.worker_id)
        if not upload:
            return error_json("Artifact upload not found", 404, "ARTIFACT_UPLOAD_NOT_FOUND")
        existing = await self.repository.get_published_artifact_for_upload(upload_id)
        if existing and upload["status"] == "completed":
            return JSONResponse(content={
                "artifact_id": str(existing["artifact_id"]),
                "name": upload["name"],
                "file_size_bytes": existing["file_size_bytes"],
                "checksum_sha256": existing["checksum_sha256"],
                "status": "published",
                "duplicate": True,
            })
        result = await self.authenticate_attempt(
            request, auth, upload["task_id"], body,
            allow_succeeded=bool(existing),
        )
        if isinstance(result, JSONResponse):
            return result
        attempt, lease_hash = result
        if attempt["attempt_id"] != upload["attempt_id"]:
            return error_json("Artifact lease is invalid", 409, "ATTEMPT_FENCING_REJECTED")
        if upload["status"] != "open":
            return error_json("Artifact upload is not open", 409, "ARTIFACT_UPLOAD_CLOSED")
        stored_parts = await self.repository.get_upload_parts(upload_id)
        if not stored_parts or any(row["part_number"] != index + 1 for index, row in enumerate(stored_parts)):
            return error_json("Artifact parts are incomplete", 409, "ARTIFACT_PARTS_INCOMPLETE")
        requested = (body or {}).get("parts")
        if not isinstance(requested, list) or len(requested) != len(stored_parts):
            return error_json("Artifact part list does not match", 400, "ARTIFACT_PARTS_MISMATCH")
        for index, item in enumerate(requested):
            if not isinstance(item, dict):
                return error_json("Artifact part list does not match", 400, "ARTIFACT_PARTS_MISMATCH")
            if item.get("part_number") != stored_parts[index]["part_number"] or str(item.get("etag") or "") != stored_parts[index]["checksum_sha256"]:
                return error_json("Artifact part list does not match", 400, "ARTIFACT_PARTS_MISMATCH")
        finalize_owner = secrets.token_urlsafe(16)
        if not await self.repository.claim_finalize(auth.context, upload, attempt, lease_hash, finalize_owner):
            return error_json("Artifact finalize is already in progress", 409, "ARTIFACT_FINALIZE_IN_PROGRESS")
        try:
            part_paths = self.store.iter_part_paths(str(upload_id), [row["part_number"] for row in stored_parts])
            measured_size, measured_sha = self.store.assemble(
                upload["object_key"], part_paths, max_bytes=artifact_limit()
            )
        except ObjectStoreError:
            await self.repository.release_finalize(upload_id, finalize_owner)
            return error_json("Artifact finalize failed", 503, "ARTIFACT_FINALIZE_UNAVAILABLE")
        if measured_size != upload["expected_size_bytes"] or measured_sha != upload["expected_sha256"]:
            self.store.delete(upload["object_key"])
            self.store.delete_parts(str(upload_id))
            await self.repository.abort_artifact_upload(upload_id, reason="checksum mismatch")
            return error_json("Artifact checksum or size does not match", 409, "ARTIFACT_VALIDATION_FAILED")
        try:
            await self.repository.publish_artifact(
                auth.context, upload, attempt, lease_hash,
                measured_size=measured_size, measured_sha256=measured_sha,
            )
        except RuntimeConflict:
            self.store.delete(upload["object_key"])
            self.store.delete_parts(str(upload_id))
            await self.repository.release_finalize(upload_id, finalize_owner)
            return error_json("Artifact lease is stale", 409, "ATTEMPT_FENCING_REJECTED")
        self.store.delete_parts(str(upload_id))
        return JSONResponse(status_code=201, content={
            "artifact_id": str(upload["artifact_id"]),
            "name": upload["name"],
            "file_size_bytes": measured_size,
            "checksum_sha256": measured_sha,
            "status": "published",
        })

    async def finish_task(
        self, auth: AuthenticatedSession, task_id: uuid.UUID, request: Request, target: str
    ) -> JSONResponse:
        body = await _body_json(request)
        forbidden = _forbidden_fields(body)
        if forbidden:
            return forbidden
        result = await self.authenticate_attempt(request, auth, task_id, body)
        if isinstance(result, JSONResponse):
            return result
        attempt, lease_hash = result
        body = body or {}
        fallback_code = "cancelled" if target == "cancelled" else "worker_failed"
        fallback_message = "Task cancelled" if target == "cancelled" else "Worker reported failure"
        try:
            await self.repository.finish_task(
                auth.context, task_id, attempt, lease_hash,
                target=target,
                error_code=_error_text(body.get("error_code"), fallback_code)[:80],
                error_message=_error_text(body.get("error_message"), fallback_message),
            )
        except RuntimeConflict:
            return error_json("Attempt lease is stale", 409, "ATTEMPT_FENCING_REJECTED")
        return JSONResponse(content={
            "task_id": str(task_id),
            "attempt_id": str(attempt["attempt_id"]),
            "status": target,
        })


def create_worker_v2_app(database_url: str, object_root: str, redis_url: str | None = None) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        await apply_migrations(database_url)
        pool = await asyncpg.create_pool(database_url, min_size=1, max_size=10)
        repository = LocalRuntimeApiRepository(pool)
        await repository.reset_stale_finalizing()
        app.state.runtime_pool = pool
        app.state.runtime_repository = repository
        app.state.runtime_store = LocalObjectStore(object_root)
        app.state.worker_v2 = WorkerV2Api(repository, app.state.runtime_store)
        app.state.redis_url = redis_url
        publisher: LocalOutboxPublisher | None = None
        if redis_url:
            publisher = LocalOutboxPublisher(pool, redis_url)
            await publisher.recover_expired_claims()
            await publisher.start()
            app.state.outbox_publisher = publisher
        try:
            yield
        finally:
            if publisher is not None:
                await publisher.stop()
            await pool.close()

    app = FastAPI(lifespan=lifespan)

    def api(request: Request) -> WorkerV2Api:
        return request.app.state.worker_v2

    def parse_task_id(value: str) -> uuid.UUID | None:
        try:
            return uuid.UUID(value)
        except ValueError:
            return None

    def parse_upload_id(value: str) -> uuid.UUID | None:
        try:
            return uuid.UUID(value)
        except ValueError:
            return None

    @app.post("/api/worker/v2/connect")
    async def connect(request: Request):
        return await api(request).connect(request)

    @app.post("/api/worker/v2/heartbeat")
    async def heartbeat(request: Request):
        auth = await api(request).authenticate_session(request)
        if isinstance(auth, JSONResponse):
            return auth
        return await api(request).heartbeat(auth, request)

    @app.post("/api/worker/v2/poll")
    async def poll(request: Request):
        auth = await api(request).authenticate_session(request)
        if isinstance(auth, JSONResponse):
            return auth
        return await api(request).poll(auth, request)

    @app.post("/api/worker/v2/tasks/{task_id}/accept")
    async def accept(task_id: str, request: Request):
        auth = await api(request).authenticate_session(request)
        if isinstance(auth, JSONResponse):
            return auth
        parsed = parse_task_id(task_id)
        if parsed is None:
            return error_json("Invalid task ID", 400, "INVALID_TASK_ID")
        return await api(request).accept(auth, parsed, request)

    @app.post("/api/worker/v2/tasks/{task_id}/renew")
    async def renew(task_id: str, request: Request):
        auth = await api(request).authenticate_session(request)
        if isinstance(auth, JSONResponse):
            return auth
        parsed = parse_task_id(task_id)
        if parsed is None:
            return error_json("Invalid task ID", 400, "INVALID_TASK_ID")
        return await api(request).renew(auth, parsed, request)

    @app.get("/api/worker/v2/tasks/{task_id}/spec")
    async def spec(task_id: str, request: Request):
        auth = await api(request).authenticate_session(request)
        if isinstance(auth, JSONResponse):
            return auth
        parsed = parse_task_id(task_id)
        if parsed is None:
            return error_json("Invalid task ID", 400, "INVALID_TASK_ID")
        return await api(request).spec(auth, parsed, request)

    @app.get("/api/worker/v2/tasks/{task_id}/inputs/{kind}")
    async def input_stream(task_id: str, kind: str, request: Request):
        auth = await api(request).authenticate_session(request)
        if isinstance(auth, JSONResponse):
            return auth
        parsed = parse_task_id(task_id)
        if parsed is None or kind not in {"method", "dataset"}:
            return error_json("Unknown task input", 404, "TASK_INPUT_NOT_FOUND")
        return await api(request).input_stream(auth, parsed, kind, request)

    @app.post("/api/worker/v2/tasks/{task_id}/artifacts/start")
    async def start_artifact(task_id: str, request: Request):
        auth = await api(request).authenticate_session(request)
        if isinstance(auth, JSONResponse):
            return auth
        parsed = parse_task_id(task_id)
        if parsed is None:
            return error_json("Invalid task ID", 400, "INVALID_TASK_ID")
        return await api(request).start_artifact(auth, parsed, request)

    @app.post("/api/worker/v2/tasks/{task_id}/{target}")
    async def finish_task(task_id: str, target: str, request: Request):
        if target not in {"fail", "cancelled"}:
            return error_json("Not found", 404, "NOT_FOUND")
        auth = await api(request).authenticate_session(request)
        if isinstance(auth, JSONResponse):
            return auth
        parsed = parse_task_id(task_id)
        if parsed is None:
            return error_json("Invalid task ID", 400, "INVALID_TASK_ID")
        return await api(request).finish_task(auth, parsed, request, "cancelled" if target == "cancelled" else "failed")

    @app.put("/api/worker/v2/artifacts/{upload_id}/parts/{part_number}")
    async def artifact_part(upload_id: str, part_number: str, request: Request):
        auth = await api(request).authenticate_session(request)
        if isinstance(auth, JSONResponse):
            return auth
        parsed = parse_upload_id(upload_id)
        if parsed is None or not part_number.isdigit():
            return error_json("Invalid artifact part number", 400, "INVALID_ARTIFACT_PART")
        return await api(request).artifact_part(auth, parsed, int(part_number), request)

    @app.post("/api/worker/v2/artifacts/{upload_id}/complete")
    async def complete_artifact(upload_id: str, request: Request):
        auth = await api(request).authenticate_session(request)
        if isinstance(auth, JSONResponse):
            return auth
        parsed = parse_upload_id(upload_id)
        if parsed is None:
            return error_json("Artifact upload not found", 404, "ARTIFACT_UPLOAD_NOT_FOUND")
        return await api(request).complete_artifact(auth, parsed, request)

    @app.get("/v1/hints")
    async def hints(request: Request):
        """Advisory wake-up hints; PostgreSQL poll remains authoritative."""
        configured = getattr(request.app.state, "redis_url", None)
        if not configured:
            return JSONResponse(content={"items": [], "next_cursor": "0-0"})
        try:
            cursor = str(request.query_params.get("cursor") or "0-0")
            limit = int(request.query_params.get("limit") or 20)
            payload = await read_hints(configured, cursor=cursor, limit=limit)
        except Exception:
            return JSONResponse(content={"items": [], "next_cursor": "0-0"})
        return JSONResponse(content=payload)

    return app


def main() -> None:
    import uvicorn

    database_url = os.getenv("LOCAL_RUNTIME_DATABASE_URL", "").strip()
    object_root = os.getenv("LOCAL_OBJECT_ROOT", "").strip()
    redis_url = os.getenv("LOCAL_REDIS_URL", "").strip() or None
    if not database_url or not object_root:
        raise SystemExit("LOCAL_RUNTIME_DATABASE_URL and LOCAL_OBJECT_ROOT are required")
    app = create_worker_v2_app(database_url, object_root, redis_url=redis_url)
    uvicorn.run(
        app,
        host=os.getenv("LOCAL_API_HOST", "127.0.0.1"),
        port=int(os.getenv("LOCAL_API_PORT", "8090")),
    )


if __name__ == "__main__":
    main()

