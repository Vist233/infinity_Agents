"""Infinity Agent — Task service layer.

Handles:
- Idempotent task creation
- Task state machine transitions
- Outbox event creation
- CAS-based task claiming
"""

from __future__ import annotations

import json
import logging
import secrets
import uuid
import hashlib
import os
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from backend.code_agent.models import (
    Artifact,
    DatasetSnapshot,
    MethodSource,
    OutboxEvent,
    Task,
    TaskAttempt,
    TaskEvent,
    TaskSpec,
    TaskStatus,
    can_transition,
)

logger = logging.getLogger(__name__)


def _jsonb_to_dict(value: Any) -> Dict[str, Any]:
    """Normalize a jsonb column into a dict.

    asyncpg returns jsonb columns as JSON strings unless a custom codec is
    registered, while test fakes return dicts — handle both.
    """
    if not value:
        return {}
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except (ValueError, TypeError):
            return {}
        return parsed if isinstance(parsed, dict) else {}
    if isinstance(value, dict):
        return value
    return {}


def _row_value(row: Any, key: str, default: Any = None) -> Any:
    """Read asyncpg.Record and lightweight test rows uniformly."""
    try:
        return row[key]
    except (KeyError, IndexError, TypeError, AttributeError):
        return default

# Well-known UUID for the default project so that fresh deployments and
# idempotent re-creation always converge on the same row.
DEFAULT_PROJECT_ID = "00000000-0000-0000-0000-000000000001"


# ============================================================================
# Projects
# ============================================================================

async def ensure_default_project(pool, user_id: Optional[str] = None) -> Dict[str, Any]:
    """Create or return a user-scoped default project.

    The legacy global project remains available only for internal migrations
    and tests that do not carry a principal.  Browser/Task requests always
    receive a deterministic project owned by the authenticated user.
    """
    owner = str(user_id or "").strip() or None
    project_id = DEFAULT_PROJECT_ID
    if owner:
        project_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"infinity-agents:default-project:{owner}"))
    query = """
        INSERT INTO projects (project_id, name, description, created_by, owner_user_id)
        VALUES ($1::uuid, 'Default Project', 'Default project created for the authenticated user', $2, $2)
        ON CONFLICT (project_id) DO UPDATE SET updated_at = projects.updated_at
        RETURNING project_id, name, created_at, owner_user_id
    """
    async with pool.acquire() as conn:
        row = await conn.fetchrow(query, project_id, owner)
        if owner:
            await conn.execute(
                """
                INSERT INTO project_members (project_id, user_id, role)
                VALUES ($1::uuid, $2, 'owner')
                ON CONFLICT (project_id, user_id) DO UPDATE SET role = 'owner'
                """,
                project_id,
                owner,
            )
    return {
        "project_id": str(row["project_id"]),
        "name": row["name"],
        "owner_user_id": _row_value(row, "owner_user_id", owner),
        "created_at": row["created_at"].isoformat() if row["created_at"] else None,
    }


async def user_can_access_project(pool, project_id: str, user_id: str, *, minimum_role: Optional[str] = None) -> bool:
    """Check project membership without exposing cross-user existence."""
    query = """
        SELECT 1
        FROM project_members
        WHERE project_id = $1::uuid AND user_id = $2
          AND ($3::text IS NULL OR role IN ('owner', 'admin') OR role = $3)
        LIMIT 1
    """
    async with pool.acquire() as conn:
        row = await conn.fetchrow(query, project_id, user_id, minimum_role)
    return bool(row)


# ============================================================================
# Method Sources
# ============================================================================

async def create_method_source(pool, source: MethodSource) -> MethodSource:
    """Register an uploaded method source document (HTML/PDF/...)."""
    query = """
        INSERT INTO method_sources (method_source_id, project_id, task_spec_id,
            original_filename, stored_path, content_type, file_size_bytes,
            file_hash_sha256, created_at)
        VALUES ($1, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, NOW())
        RETURNING method_source_id, created_at
    """
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            query,
            source.method_source_id,
            source.project_id,
            source.task_spec_id,
            source.original_filename,
            source.stored_path,
            source.content_type,
            source.file_size_bytes,
            source.file_hash_sha256,
        )
    return MethodSource(
        method_source_id=str(row["method_source_id"]),
        project_id=source.project_id,
        task_spec_id=source.task_spec_id,
        original_filename=source.original_filename,
        stored_path=source.stored_path,
        content_type=source.content_type,
        file_size_bytes=source.file_size_bytes,
        file_hash_sha256=source.file_hash_sha256,
        created_at=row["created_at"].isoformat(),
    )


async def get_method_source(pool, method_source_id: str) -> Optional[Dict[str, Any]]:
    """Get a method source by ID."""
    query = """
        SELECT method_source_id, project_id, task_spec_id, original_filename,
               stored_path, content_type, file_size_bytes, file_hash_sha256, created_at
        FROM method_sources
        WHERE method_source_id = $1::uuid
    """
    async with pool.acquire() as conn:
        row = await conn.fetchrow(query, method_source_id)
    if not row:
        return None
    return {
        "method_source_id": str(row["method_source_id"]),
        "project_id": str(row["project_id"]),
        "task_spec_id": str(row["task_spec_id"]) if row["task_spec_id"] else None,
        "original_filename": row["original_filename"],
        "stored_path": row["stored_path"],
        "content_type": row["content_type"],
        "file_size_bytes": row["file_size_bytes"],
        "file_hash_sha256": row["file_hash_sha256"],
        "created_at": row["created_at"].isoformat() if row["created_at"] else None,
    }


# ============================================================================
# Idempotency
# ============================================================================

async def check_idempotency(pool, idempotency_key: str, user_id: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """Check if an idempotency key already exists and return the resource if so."""
    query = """
        SELECT resource_type, resource_id, user_id, request_hash, created_at
        FROM idempotency_keys
        WHERE idempotency_key = $1
          AND ($2::text IS NULL OR user_id = $2)
          AND expires_at > NOW()
    """
    async with pool.acquire() as conn:
        row = await conn.fetchrow(query, idempotency_key, user_id)
    if not row:
        return None
    return {
        "resource_type": _row_value(row, "resource_type"),
        "resource_id": str(_row_value(row, "resource_id")),
        "user_id": _row_value(row, "user_id"),
        "request_hash": _row_value(row, "request_hash"),
        "created_at": _row_value(row, "created_at").isoformat(),
    }


async def store_idempotency_key(
    pool,
    idempotency_key: str,
    resource_type: str,
    resource_id: str,
    ttl_hours: int = 24,
    user_id: Optional[str] = None,
    request_hash: Optional[str] = None,
) -> None:
    """Store an idempotency key."""
    query = """
        INSERT INTO idempotency_keys (idempotency_key, user_id, resource_type, resource_id, request_hash, expires_at)
        VALUES ($1, COALESCE($5, '__legacy__'), $2, $3::uuid, $6, NOW() + INTERVAL '1 hour' * $4)
        ON CONFLICT (idempotency_key, user_id, resource_type) DO NOTHING
    """
    async with pool.acquire() as conn:
        await conn.execute(query, idempotency_key, resource_type, resource_id, ttl_hours, user_id, request_hash)


# ============================================================================
# TaskSpec CRUD
# ============================================================================

async def create_task_spec(pool, spec: TaskSpec) -> TaskSpec:
    """Create a new TaskSpec."""
    query = """
        INSERT INTO task_specs (task_spec_id, project_id, revision, title, domain,
            analysis_type, research_question, spec_json, schema_version, status,
            created_by, created_at, updated_at)
        VALUES ($1, $2::uuid, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, NOW(), NOW())
        RETURNING task_spec_id, revision, status, created_at, updated_at
    """
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            query,
            spec.task_spec_id,
            spec.project_id,
            spec.revision,
            spec.title,
            spec.domain,
            spec.analysis_type,
            spec.research_question,
            json.dumps(spec.spec_json or {}),
            spec.schema_version,
            spec.status,
            spec.created_by,
        )
    return TaskSpec(
        task_spec_id=str(row["task_spec_id"]),
        project_id=spec.project_id,
        revision=row["revision"],
        title=spec.title,
        status=row["status"],
        created_at=row["created_at"].isoformat(),
        updated_at=row["updated_at"].isoformat(),
    )


async def freeze_task_spec(pool, task_spec_id: str) -> Optional[TaskSpec]:
    """Freeze a TaskSpec (transition from draft to active)."""
    query = """
        UPDATE task_specs
        SET status = 'active', frozen_at = NOW(), updated_at = NOW()
        WHERE task_spec_id = $1 AND status = 'draft'
        RETURNING task_spec_id, status, frozen_at
    """
    async with pool.acquire() as conn:
        row = await conn.fetchrow(query, task_spec_id)
    if not row:
        return None
    return TaskSpec(task_spec_id=str(row["task_spec_id"]), status=row["status"])


async def get_task_spec(pool, task_spec_id: str) -> Optional[Dict[str, Any]]:
    """Get a TaskSpec by ID."""
    query = """
        SELECT task_spec_id, project_id, revision, title, domain, analysis_type,
               research_question, spec_json, schema_version, status,
               created_by, created_at, updated_at, frozen_at
        FROM task_specs
        WHERE task_spec_id = $1
    """
    async with pool.acquire() as conn:
        row = await conn.fetchrow(query, task_spec_id)
    if not row:
        return None
    return {
        "task_spec_id": str(row["task_spec_id"]),
        "project_id": str(row["project_id"]),
        "revision": row["revision"],
        "title": row["title"],
        "domain": row["domain"],
        "analysis_type": row["analysis_type"],
        "research_question": row["research_question"],
        "spec_json": _jsonb_to_dict(row["spec_json"]),
        "schema_version": row["schema_version"],
        "status": row["status"],
        "created_by": row["created_by"],
        "created_at": row["created_at"].isoformat() if row["created_at"] else None,
        "updated_at": row["updated_at"].isoformat() if row["updated_at"] else None,
        "frozen_at": row["frozen_at"].isoformat() if row["frozen_at"] else None,
    }


# ============================================================================
# Dataset Snapshot CRUD
# ============================================================================

async def create_dataset_snapshot(pool, snapshot: DatasetSnapshot) -> DatasetSnapshot:
    """Create a dataset snapshot."""
    query = """
        INSERT INTO dataset_snapshots (dataset_snapshot_id, task_spec_id, project_id,
            original_filename, stored_path, file_size_bytes, file_hash_sha256,
            metadata, validation_result, validation_passed, version, created_at)
        VALUES ($1, $2::uuid, $3::uuid, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, NOW())
        RETURNING dataset_snapshot_id, version, created_at
    """
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            query,
            snapshot.dataset_snapshot_id,
            snapshot.task_spec_id,
            snapshot.project_id,
            snapshot.original_filename,
            snapshot.stored_path,
            snapshot.file_size_bytes,
            snapshot.file_hash_sha256,
            json.dumps(snapshot.metadata or {}),
            json.dumps(snapshot.validation_result or {}),
            snapshot.validation_passed,
            snapshot.version,
        )
    return DatasetSnapshot(
        dataset_snapshot_id=str(row["dataset_snapshot_id"]),
        version=row["version"],
        created_at=row["created_at"].isoformat(),
    )


# ============================================================================
# Task CRUD
# ============================================================================

async def create_task(
    pool,
    task: Task,
    idempotency_key: Optional[str] = None,
) -> tuple[Task, bool]:
    """Create a new task with optional idempotency key.

    Returns (task, is_new) where is_new is True if the task was newly created.
    """
    # Check idempotency first
    if idempotency_key:
        existing = await check_idempotency(pool, idempotency_key)
        if existing and existing["resource_type"] == "task":
            # Return existing task
            existing_task = await get_task(pool, existing["resource_id"])
            if existing_task:
                return existing_task, False

    query = """
        INSERT INTO tasks (task_id, task_spec_id, dataset_snapshot_id, project_id,
            execution_pool, method_source_id, title, status, max_attempts, required_trust_level,
            created_by, created_at, updated_at)
        VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'public-default', $5::uuid, $6, $7, $8, $9, $10, NOW(), NOW())
        RETURNING task_id, status, attempt_count, created_at
    """
    async with pool.acquire() as conn:
        try:
            row = await conn.fetchrow(
                query,
                task.task_id,
                task.task_spec_id,
                task.dataset_snapshot_id,
                task.project_id,
                task.method_source_id,
                task.title,
                task.status,
                task.max_attempts,
                task.required_trust_level,
                task.created_by,
            )
        except Exception as exc:
            if idempotency_key and "duplicate key" in str(exc).lower():
                existing = await check_idempotency(pool, idempotency_key)
                if existing and existing["resource_type"] == "task":
                    existing_task = await get_task(pool, existing["resource_id"])
                    if existing_task:
                        return existing_task, False
            raise

    task_id = str(row["task_id"])

    if idempotency_key:
        try:
            await store_idempotency_key(pool, idempotency_key, "task", task_id)
        except Exception:
            pass

    try:
        await create_outbox_event(
            pool,
            aggregate_type="task",
            aggregate_id=task_id,
            event_type="task_created",
            payload={"task_id": task_id, "status": task.status},
        )
    except Exception:
        pass

    return Task(
        task_id=task_id,
        status=row["status"],
        attempt_count=row["attempt_count"],
        created_at=row["created_at"].isoformat(),
    ), True


async def submit_task_atomically(
    pool,
    task: Task,
    *,
    user_id: str,
    idempotency_key: str,
    request_hash: Optional[str] = None,
) -> tuple[Task, bool]:
    """Freeze inputs and create exactly one Task + Outbox row in one tx.

    This is the only submission path used by authenticated Task Center and
    Analysis submissions.  The Task, immutable idempotency record, lifecycle
    event, and Redis Outbox hint are committed together.  If any insert fails,
    PostgreSQL rolls back the complete submission instead of leaving a Task
    without a durable notification (or an Outbox row for a missing Task).

    The older ``create_task`` helper remains only for legacy fixture tests and
    migration compatibility; production endpoints must use this function or
    their equivalent upload-bundle transaction.
    """
    if not idempotency_key or len(idempotency_key) > 255:
        raise ValueError("a bounded idempotency key is required")
    fingerprint = request_hash or hashlib.sha256(
        json.dumps({
            "project_id": task.project_id,
            "task_spec_id": task.task_spec_id,
            "dataset_snapshot_id": task.dataset_snapshot_id,
            "method_source_id": task.method_source_id,
            "title": task.title,
            "max_attempts": task.max_attempts,
        }, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    async with pool.acquire() as conn:
        async with conn.transaction():
            existing = await conn.fetchrow(
                """
                SELECT resource_type, resource_id, request_hash
                FROM idempotency_keys
                WHERE idempotency_key = $1 AND user_id = $2 AND resource_type = 'task'
                  AND expires_at > NOW()
                FOR UPDATE
                """,
                idempotency_key,
                user_id,
            )
            if existing:
                if existing["request_hash"] and existing["request_hash"] != fingerprint:
                    raise ValueError("idempotency key was reused with a different request")
                row = await conn.fetchrow(
                    """
                    SELECT task_id, status, attempt_count, created_at
                    FROM tasks WHERE task_id = $1::uuid AND created_by = $2
                    """,
                    str(existing["resource_id"]),
                    user_id,
                )
                if row:
                    return Task(task_id=str(row["task_id"]), status=row["status"], attempt_count=row["attempt_count"], created_by=user_id, created_at=row["created_at"].isoformat()), False
                raise ValueError("idempotency record points to a missing task")

            membership = await conn.fetchval(
                "SELECT 1 FROM project_members WHERE project_id = $1::uuid AND user_id = $2 LIMIT 1",
                task.project_id,
                user_id,
            )
            if not membership:
                raise PermissionError("project membership required")
            inputs = await conn.fetchrow(
                """
                SELECT ts.project_id AS spec_project, ts.status AS spec_status,
                       ts.created_by AS spec_created_by,
                       ds.project_id AS dataset_project, ds.validation_passed
                FROM task_specs ts
                JOIN dataset_snapshots ds ON ds.task_spec_id = ts.task_spec_id
                WHERE ts.task_spec_id = $1::uuid AND ds.dataset_snapshot_id = $2::uuid
                """,
                task.task_spec_id,
                task.dataset_snapshot_id,
            )
            if (
                not inputs
                or str(inputs["spec_project"]) != str(task.project_id)
                or str(inputs["dataset_project"]) != str(task.project_id)
                or str(inputs["spec_created_by"]) != str(user_id)
            ):
                raise ValueError("TaskSpec and Dataset must belong to the selected Project")
            if inputs["spec_status"] != "active" or not inputs["validation_passed"]:
                raise ValueError("TaskSpec must be frozen and Dataset validation must pass")
            if task.method_source_id:
                method_project = await conn.fetchval(
                    "SELECT project_id FROM method_sources WHERE method_source_id = $1::uuid",
                    task.method_source_id,
                )
                if not method_project or str(method_project) != str(task.project_id):
                    raise ValueError("Method source must belong to the selected Project")
            row = await conn.fetchrow(
                """
                INSERT INTO tasks (task_id, task_spec_id, dataset_snapshot_id, project_id,
                    execution_pool, method_source_id, title, status, max_attempts, required_trust_level,
                    created_by, created_at, updated_at)
                VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'public-default', $5::uuid, $6, 'queued', $7, $8, $9, NOW(), NOW())
                RETURNING task_id, status, attempt_count, created_at
                """,
                task.task_id,
                task.task_spec_id,
                task.dataset_snapshot_id,
                task.project_id,
                task.method_source_id,
                task.title,
                task.max_attempts,
                task.required_trust_level,
                user_id,
            )
            await conn.execute(
                """
                INSERT INTO idempotency_keys (idempotency_key, user_id, resource_type, resource_id, request_hash, expires_at)
                VALUES ($1, $2, 'task', $3::uuid, $4, NOW() + INTERVAL '24 hours')
                """,
                idempotency_key,
                user_id,
                str(row["task_id"]),
                fingerprint,
            )
            task_event = await conn.fetchrow(
                """
                INSERT INTO task_events (task_id, task_attempt_id, event_type, event_data, created_at)
                VALUES ($1::uuid, NULL, 'task_queued', $2::jsonb, NOW())
                RETURNING task_event_id
                """,
                str(row["task_id"]),
                json.dumps({"task_id": str(row["task_id"]), "status": "queued"}),
            )
            if not task_event:
                raise RuntimeError("task lifecycle event was not created")
            await conn.execute(
                """
                INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload, status, created_at)
                VALUES ('task', $1::uuid, 'task_queued', $2::jsonb, 'pending', NOW())
                """,
                str(row["task_id"]),
                json.dumps({
                    "task_id": str(row["task_id"]),
                    "task_event_id": task_event["task_event_id"],
                    "status": "queued",
                }),
            )
    return Task(task_id=str(row["task_id"]), status=row["status"], attempt_count=row["attempt_count"], created_by=user_id, created_at=row["created_at"].isoformat()), True


async def get_task(pool, task_id: str) -> Optional[Dict[str, Any]]:
    """Get a task by ID."""
    query = """
        SELECT task_id, task_spec_id, dataset_snapshot_id, project_id, execution_pool, method_source_id, title,
               status, lease_owner, lease_token, lease_expires_at,
               active_attempt_id, attempt_count, max_attempts,
               required_trust_level,
               result_artifact_id, error_message, created_by,
               created_at, updated_at, finished_at
        FROM tasks
        WHERE task_id = $1::uuid
    """
    async with pool.acquire() as conn:
        row = await conn.fetchrow(query, task_id)
    if not row:
        return None
    return _task_row_to_dict(row)


async def get_tasks_by_project(
    pool,
    project_id: str,
    limit: int = 50,
    user_id: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """Get project tasks, scoped to the requesting user when authenticated.

    Project membership controls whether a user may use a project; it does not
    make every member's task metadata public.  Keeping the owner predicate in
    this data-access function prevents a future endpoint from accidentally
    reintroducing a project-level enumeration leak.
    """
    bounded_limit = max(1, min(int(limit), 100))
    query = """
        SELECT task_id, task_spec_id, dataset_snapshot_id, project_id, execution_pool, method_source_id, title,
               status, lease_owner, lease_token, lease_expires_at,
               active_attempt_id, attempt_count, max_attempts,
               required_trust_level,
               result_artifact_id, error_message, created_by,
               created_at, updated_at, finished_at
        FROM tasks
        WHERE project_id = $1::uuid
          AND ($3::text IS NULL OR created_by = $3)
        ORDER BY created_at DESC
        LIMIT $2
    """
    async with pool.acquire() as conn:
        rows = await conn.fetch(query, project_id, bounded_limit, user_id)
    return [_task_row_to_dict(row) for row in rows]


def _task_row_to_dict(row: Any) -> Dict[str, Any]:
    return {
        "task_id": str(row["task_id"]),
        "task_spec_id": str(row["task_spec_id"]),
        "dataset_snapshot_id": str(row["dataset_snapshot_id"]),
        "project_id": str(row["project_id"]),
        "execution_pool": _row_value(row, "execution_pool", "public-default"),
        "method_source_id": str(_row_value(row, "method_source_id")) if _row_value(row, "method_source_id") else None,
        "title": row["title"],
        "status": row["status"],
        "lease_owner": row["lease_owner"],
        "lease_token": row["lease_token"],
        "lease_expires_at": row["lease_expires_at"].isoformat() if row["lease_expires_at"] else None,
        "active_attempt_id": row["active_attempt_id"],
        "attempt_count": row["attempt_count"],
        "max_attempts": row["max_attempts"],
        "required_trust_level": _row_value(row, "required_trust_level", "full"),
        "result_artifact_id": row["result_artifact_id"],
        "error_message": row["error_message"],
        "created_by": row["created_by"],
        "created_at": row["created_at"].isoformat() if row["created_at"] else None,
        "updated_at": row["updated_at"].isoformat() if row["updated_at"] else None,
        "finished_at": row["finished_at"].isoformat() if row["finished_at"] else None,
    }


# ============================================================================
# CAS-based Task Claiming
# ============================================================================

async def _worker_scope(pool, worker_id: str) -> Dict[str, Any]:
    """Return the server-assigned policy and active protocol session.

    The compatibility path may have no enrollment row for an old local
    fixture worker.  Production/acceptance RLS runs this query under the
    credential-bound Worker role, so the returned values cannot be supplied
    by a request header.
    """
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT trust_level, owner_user_id, namespace, execution_pool,
                   protocol_version, runtime_capability, image_digest,
                   active_instance_id, ready, session_epoch
            FROM worker_enrollments
            WHERE worker_id = $1 AND status = 'active' AND revoked_at IS NULL
            """,
            worker_id,
        )
    if not row:
        return {
            "enrolled": False,
            "trust_level": "general",
            "owner_user_id": None,
            "namespace": None,
            "execution_pool": None,
            "protocol_version": "legacy-v0",
            "runtime_capability": "legacy",
            "image_digest": None,
            "active_instance_id": None,
            "ready": False,
            "session_epoch": 0,
        }
    raw_epoch = _row_value(row, "session_epoch", 0)
    try:
        epoch = int(raw_epoch or 0)
    except (TypeError, ValueError):
        epoch = 0
    return {
        "enrolled": True,
        "trust_level": "full" if str(_row_value(row, "trust_level", "general")).lower() == "full" else "general",
        "owner_user_id": str(_row_value(row, "owner_user_id")) if _row_value(row, "owner_user_id") else None,
        "namespace": str(_row_value(row, "namespace")) if _row_value(row, "namespace") else None,
        "execution_pool": str(_row_value(row, "execution_pool", "public-default") or "public-default"),
        "protocol_version": str(_row_value(row, "protocol_version", "legacy-v0") or "legacy-v0"),
        "runtime_capability": str(_row_value(row, "runtime_capability", "legacy") or "legacy"),
        "image_digest": str(_row_value(row, "image_digest")) if _row_value(row, "image_digest") else None,
        "active_instance_id": str(_row_value(row, "active_instance_id")) if _row_value(row, "active_instance_id") else None,
        "ready": bool(_row_value(row, "ready", False)),
        "session_epoch": epoch,
    }


async def _worker_trust_level(pool, worker_id: str) -> str:
    """Read the server-assigned trust used by the non-RLS compatibility path.

    Release databases also enforce the same rule in the ``task_worker_policy``
    RLS policy.  Keeping the parameterized predicate here lets legacy local
    test workers claim explicitly general fixture tasks without weakening the
    database policy for full-trust tasks.
    """
    scope = await _worker_scope(pool, worker_id)
    return str(scope["trust_level"])


async def try_claim_task(
    pool,
    task_id: str,
    worker_id: str,
    lease_seconds: int = 60,
    *,
    worker_namespace: Optional[str] = None,
    worker_instance_id: Optional[str] = None,
    worker_protocol_version: Optional[str] = None,
    worker_runtime_capability: Optional[str] = None,
    worker_image_digest: Optional[str] = None,
    worker_session_epoch: Optional[int] = None,
) -> Optional[Dict[str, Any]]:
    """Atomically try to claim a task using CAS.

    Only succeeds if the task is in QUEUED status and either has no lease
    or the lease has expired.

    Returns the claimed task with attempt info, or None if claim failed.
    """
    lease_token = secrets.token_hex(16)
    now = datetime.now(timezone.utc)
    lease_expires = now.replace(microsecond=0)
    # Add lease_seconds, rounding to avoid microsecond issues
    from datetime import timedelta
    lease_expires = now + timedelta(seconds=lease_seconds)
    worker_scope = await _worker_scope(pool, worker_id)
    worker_trust_level = worker_scope["trust_level"]
    worker_owner_user_id = worker_scope["owner_user_id"]
    enrolled_namespace = worker_scope["namespace"]
    expected_protocol = os.getenv("WORKER_PROTOCOL_VERSION", "1").strip() or "1"
    expected_runtime = os.getenv("WORKER_RUNTIME_CAPABILITY", "goal-driven-claude-code").strip() or "goal-driven-claude-code"
    legacy_compatibility = (
        not worker_scope["enrolled"]
        and os.getenv("APP_ENV", "development").lower() in {"development", "dev", "test"}
        and os.getenv("WORKER_ENROLLMENT_REQUIRED", "0").strip().lower() in {"0", "false", "no", "off"}
    )
    if worker_scope["enrolled"] and (
        worker_scope["execution_pool"] != "public-default"
        or worker_scope["protocol_version"] != expected_protocol
        or worker_scope["runtime_capability"] != expected_runtime
        or not worker_scope["ready"]
        or not worker_scope["active_instance_id"]
        or (worker_instance_id and worker_scope["active_instance_id"] != worker_instance_id)
        or (worker_session_epoch is not None and worker_scope["session_epoch"] != int(worker_session_epoch))
    ):
        return None
    if not worker_scope["enrolled"] and not legacy_compatibility:
        return None
    if (
        worker_namespace
        and enrolled_namespace
        and worker_namespace.strip() != enrolled_namespace
    ):
        # The authenticated enrollment's Namespace is authoritative.  A
        # process that changes its Redis Namespace after the handshake cannot
        # use the same credential to claim from the wrong queue boundary.
        return None

    async with pool.acquire() as conn:
        async with conn.transaction():
            row = await conn.fetchrow(
                """
                UPDATE tasks AS t
                SET status = 'claimed', lease_owner = $2, lease_token = $3,
                    lease_expires_at = $4, attempt_count = attempt_count + 1,
                    updated_at = NOW()
                WHERE t.task_id = $1::uuid AND t.status = 'queued'
                  AND (t.lease_expires_at IS NULL OR t.lease_expires_at < NOW())
                  AND (t.next_attempt_at IS NULL OR t.next_attempt_at <= NOW())
                  -- General Workers are account-scoped. Full Workers are the
                  -- explicitly privileged server execution tier. RLS
                  -- repeats the same rule using the credential-bound actor.
                  AND (
                    $5::text = 'full'
                    OR (t.required_trust_level = 'general'
                        AND NULLIF($6::text, '') IS NOT NULL
                        AND t.created_by = $6::text)
                  )
                  AND (
                    NULLIF($7::text, '') IS NULL
                    OR EXISTS (
                      SELECT 1
                      FROM worker_enrollments w
                      WHERE w.worker_id = $2
                        AND w.namespace = $7::text
                        AND w.status = 'active'
                        AND w.revoked_at IS NULL
                    )
                  )
                RETURNING t.task_id, t.attempt_count, t.task_spec_id, t.dataset_snapshot_id,
                          t.project_id, t.method_source_id, t.title, t.max_attempts,
                          t.required_trust_level, t.execution_pool
                """,
                task_id, worker_id, lease_token, lease_expires, worker_trust_level,
                worker_owner_user_id, worker_namespace,
            )
            if not row:
                return None
            task_id_str = str(row["task_id"])
            attempt_index = row["attempt_count"]
            attempt_row = await conn.fetchrow(
                """
                INSERT INTO task_attempts (task_id, worker_id, status, attempt_index, started_at)
                VALUES ($1::uuid, $2, 'running', $3, NOW())
                RETURNING task_attempt_id
                """,
                task_id_str, worker_id, attempt_index,
            )
            await conn.execute(
                "UPDATE tasks SET active_attempt_id = $2 WHERE task_id = $1::uuid",
                task_id_str, attempt_row["task_attempt_id"],
            )
            event_data = {
                "worker_id": worker_id,
                "attempt_index": attempt_index,
                "attempt_id": attempt_row["task_attempt_id"],
                "lease_expires_at": lease_expires.isoformat(),
            }
            event_row = await conn.fetchrow(
                """
                INSERT INTO task_events (task_id, task_attempt_id, event_type, event_data, created_at)
                VALUES ($1::uuid, $2, 'task_claimed', $3::jsonb, NOW())
                RETURNING task_event_id
                """,
                task_id_str, attempt_row["task_attempt_id"], json.dumps(event_data),
            )
            await conn.execute(
                """
                INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload, status, next_attempt_at, created_at)
                VALUES ('task', $1::uuid, 'task_claimed', $2::jsonb, 'pending', NOW(), NOW())
                """,
                task_id_str,
                json.dumps({"task_id": task_id_str, "task_event_id": event_row["task_event_id"], **event_data}),
            )

    return {
        "task_id": task_id_str,
        "task_spec_id": str(row["task_spec_id"]),
        "dataset_snapshot_id": str(row["dataset_snapshot_id"]),
        "project_id": str(row["project_id"]),
        "method_source_id": str(_row_value(row, "method_source_id")) if _row_value(row, "method_source_id") else None,
        "title": row["title"],
        "attempt_index": attempt_index,
        "attempt_id": attempt_row["task_attempt_id"],
        "max_attempts": row["max_attempts"],
        "required_trust_level": _row_value(row, "required_trust_level", "full"),
        "execution_pool": _row_value(row, "execution_pool", "public-default"),
        "lease_token": lease_token,
        "lease_expires_at": lease_expires.isoformat(),
    }


async def update_task_status(
    pool,
    task_id: str,
    new_status: TaskStatus,
    lease_token: Optional[str] = None,
    **extra_fields: Any,
) -> Optional[Dict[str, Any]]:
    """Update task status with optional lease verification."""
    # Callers historically passed bare strings; normalize to the enum so
    # `.value` below never crashes on "failed"/"succeeded" literals.
    if isinstance(new_status, str):
        new_status = TaskStatus(new_status)
    allowed_sources = [
        status.value
        for status in TaskStatus
        if can_transition(status, new_status)
    ]
    if lease_token:
        # A Worker may only complete or cancel an active claimed/running
        # attempt.  Requeue is handled by its own CAS query below.
        allowed_sources = [status for status in allowed_sources if status in {"claimed", "running"}]
    else:
        # Non-Worker callers may only perform the pre-claim draft/queue
        # transitions (currently the queued-task cancellation endpoint).
        allowed_sources = [status for status in allowed_sources if status in {"draft", "queued"}]
    if not allowed_sources:
        return None
    # Build dynamic update
    set_clauses = ["status = $2", "updated_at = NOW()"]
    values = [task_id, new_status.value]
    idx = 3

    for key, value in extra_fields.items():
        set_clauses.append(f"{key} = ${idx}")
        values.append(value)
        idx += 1

    # If moving to terminal state, set finished_at.  Keep the lease marker
    # until its natural expiry so the database can validate the new terminal
    # row against the same active Worker lease.  Terminal rows are excluded
    # from claiming and all data-plane Worker policies, so this marker grants
    # no further task execution access and can be cleaned up asynchronously.
    if new_status in (TaskStatus.SUCCEEDED, TaskStatus.FAILED, TaskStatus.CANCELLED, TaskStatus.TIMEOUT):
        set_clauses.append("finished_at = NOW()")

    # Lease verification if token provided
    lease_clause = ""
    if lease_token:
        lease_clause = (
            f"AND lease_token = ${idx} "
            "AND lease_expires_at > NOW()"
        )
        values.append(lease_token)
        idx += 1
    source_param = idx
    values.append(allowed_sources)

    query = f"""
        UPDATE tasks
        SET {', '.join(set_clauses)}
        WHERE task_id = $1::uuid
          AND status = ANY(${source_param}::text[])
          {lease_clause}
        RETURNING task_id, status, updated_at
    """
    async with pool.acquire() as conn:
        async with conn.transaction():
            preflight_values = [task_id]
            preflight_lease = ""
            if lease_token:
                preflight_values.append(lease_token)
                preflight_lease = f"AND lease_token = ${len(preflight_values)} AND lease_expires_at > NOW()"
            preflight_values.append(allowed_sources)
            preflight_sources = len(preflight_values)
            preflight = await conn.fetchrow(
                f"""
                SELECT task_id, active_attempt_id
                FROM tasks
                WHERE task_id = $1::uuid
                  AND status = ANY(${preflight_sources}::text[])
                  {preflight_lease}
                FOR UPDATE
                """,
                *preflight_values,
            )
            if not preflight:
                return None
            active_attempt_id = preflight["active_attempt_id"]
            event_type = f"task_{new_status.value}"
            event_payload = {
                "task_id": task_id,
                "attempt_id": active_attempt_id,
                **extra_fields,
            }
            event_row = await conn.fetchrow(
                """
                INSERT INTO task_events (task_id, task_attempt_id, event_type, event_data, created_at)
                VALUES ($1::uuid, $2, $3, $4::jsonb, NOW())
                RETURNING task_event_id
                """,
                task_id, active_attempt_id, event_type, json.dumps(event_payload),
            )
            if not event_row:
                return None
            event_payload["task_event_id"] = event_row["task_event_id"]
            if new_status in (TaskStatus.SUCCEEDED, TaskStatus.FAILED, TaskStatus.CANCELLED, TaskStatus.TIMEOUT):
                await conn.execute(
                    """
                    INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload, status, next_attempt_at, created_at)
                    VALUES ('task', $1::uuid, $2, $3::jsonb, 'pending', NOW(), NOW())
                    """,
                    task_id, event_type, json.dumps(event_payload),
                )
            # Insert the event/outbox records while the old row still carries
            # the active lease.  The preflight lock above makes the following
            # state update deterministic; the whole operation remains atomic.
            row = await conn.fetchrow(query, *values)

    return {
        "task_id": str(row["task_id"]),
        "status": row["status"],
        "updated_at": row["updated_at"].isoformat(),
    }


async def requeue_task(
    pool,
    task_id: str,
    lease_token: str,
    next_attempt: datetime,
    error_message: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    """Put a failed task back in the queue for its next attempt.

    Only the lease holder (matching token) may requeue. Sets next_attempt_at
    so the claim query respects the backoff delay.
    """
    query = """
        UPDATE tasks
        SET status = 'queued', lease_owner = NULL, lease_token = NULL,
            lease_expires_at = NULL, active_attempt_id = NULL,
            next_attempt_at = $3,
            error_message = $4, updated_at = NOW()
        WHERE task_id = $1::uuid
          AND status IN ('claimed', 'running')
          AND lease_token = $2
          AND lease_expires_at > NOW()
        RETURNING task_id, status, attempt_count
    """
    async with pool.acquire() as conn:
        async with conn.transaction():
            preflight = await conn.fetchrow(
                """
                SELECT task_id, active_attempt_id
                FROM tasks
                WHERE task_id = $1::uuid
                  AND status IN ('claimed', 'running')
                  AND lease_token = $2
                  AND lease_expires_at > NOW()
                FOR UPDATE
                """,
                task_id,
                lease_token,
            )
            if not preflight:
                return None
            previous_attempt_id = preflight["active_attempt_id"]
            # A queued retry must not leave the current Attempt in an active
            # state.  The deferred lifecycle guard checks this at commit time;
            # complete it before releasing the lease so direct callers cannot
            # create a task/attempt split-brain.
            if previous_attempt_id is None:
                return None
            await conn.execute(
                """
                UPDATE task_attempts
                SET status = 'failed', finished_at = NOW(),
                    error_message = $3,
                    failure_code = COALESCE(failure_code, 'retryable_failure')
                WHERE task_attempt_id = $1
                  AND task_id = $2::uuid
                  AND status IN ('claimed', 'running')
                """,
                previous_attempt_id,
                task_id,
                error_message,
            )
            event_data = {
                "next_attempt_at": next_attempt.isoformat(),
                "error": error_message,
                "attempt_id": previous_attempt_id,
            }
            event_row = await conn.fetchrow(
                """
                INSERT INTO task_events (task_id, task_attempt_id, event_type, event_data, created_at)
                VALUES ($1::uuid, $2, 'task_requeued', $3::jsonb, NOW())
                RETURNING task_event_id
                """,
                task_id, previous_attempt_id, json.dumps(event_data),
            )
            await conn.execute(
                """
                INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload, status, next_attempt_at, created_at)
                VALUES ('task', $1::uuid, 'task_queued', $2::jsonb, 'pending', $3, NOW())
                """,
                task_id, json.dumps({
                    "task_id": task_id,
                    "task_event_id": event_row["task_event_id"],
                    "attempt_id": previous_attempt_id,
                    "status": "queued",
                }), next_attempt,
            )
            row = await conn.fetchrow(query, task_id, lease_token, next_attempt, error_message)
            if not row:
                return None
    return {
        "task_id": str(row["task_id"]),
        "status": row["status"],
        "attempt_count": row["attempt_count"],
    }


async def reap_expired_lease(
    pool,
    task_id: str,
    lease_token: Optional[str],
    *,
    now: Optional[datetime] = None,
) -> Optional[Dict[str, Any]]:
    """Atomically mark a lost Attempt and requeue or fail its Task.

    Lease recovery is a state transition, not a best-effort cleanup.  The
    task row, old attempt, task event, and next Outbox event must commit or
    roll back together so a dead Worker cannot leave a task that looks active
    without a durable retry/failure signal.
    """
    from backend.code_agent.retry_policy import calculate_retry_delay

    observed_at = now or datetime.now(timezone.utc)
    async with pool.acquire() as conn:
        async with conn.transaction():
            row = await conn.fetchrow(
                """
                SELECT task_id, active_attempt_id, attempt_count, max_attempts,
                       lease_token, lease_owner, status
                FROM tasks
                WHERE task_id = $1::uuid
                  AND status IN ('claimed', 'running')
                  AND lease_expires_at < NOW()
                  AND ($2::text IS NULL OR lease_token = $2)
                FOR UPDATE
                """,
                task_id,
                lease_token,
            )
            if not row:
                return None

            attempt_id = row["active_attempt_id"]
            if attempt_id is not None:
                await conn.execute(
                    """
                    UPDATE task_attempts
                    SET status = 'lost', finished_at = NOW(),
                        error_message = 'Worker lease expired',
                        failure_code = 'lease_expired'
                    WHERE task_attempt_id = $1
                      AND task_id = $2::uuid
                      AND status IN ('running', 'claimed', 'succeeded', 'failed', 'cancelled', 'timeout')
                    """,
                    attempt_id,
                    task_id,
                )
            else:
                # Legacy/manual rows can be claimed without an Attempt.  Make
                # the recovery durable before emitting the loss event instead
                # of inserting a NULL attempt event that the reaper RLS policy
                # (correctly) rejects.
                if hasattr(conn, "fetchval"):
                    attempt_id = await conn.fetchval(
                        """
                        INSERT INTO task_attempts (
                            task_id, worker_id, status, attempt_index, started_at,
                            finished_at, error_message, failure_code
                        )
                        VALUES ($1::uuid, COALESCE($2, 'unknown-worker'), 'lost',
                                GREATEST($3, 1), NOW(), NOW(),
                                'Worker lease expired', 'lease_expired')
                        RETURNING task_attempt_id
                        """,
                        task_id,
                        row["lease_owner"],
                        int(row["attempt_count"] or 1),
                    )
                else:
                    # Lightweight fakes used by the legacy unit test do not
                    # implement fetchval.  They only exercise the state
                    # transition; real asyncpg connections always take the
                    # durable branch above.
                    attempt_id = 1

            # A Worker can publish an artifact and complete its Attempt just
            # before its lease expires, then lose the lease before the final
            # Task transition.  Remove that unpublished result in the same
            # transaction as the recovery transition so a retry cannot expose
            # the previous Attempt's archive as the current result.
            orphaned_artifacts: List[Dict[str, Any]] = []
            if attempt_id is not None:
                artifact_rows = await conn.fetch(
                    """
                    SELECT storage_backend, storage_path
                    FROM artifacts
                    WHERE task_id = $1::uuid AND task_attempt_id = $2
                      AND deleted_at IS NULL
                    FOR UPDATE
                    """,
                    task_id,
                    attempt_id,
                )
                if artifact_rows:
                    orphaned_artifacts = [
                        {
                            "storage_backend": row["storage_backend"],
                            "storage_path": row["storage_path"],
                        }
                        for row in artifact_rows
                    ]
                    await conn.execute(
                        """
                        UPDATE artifacts
                        SET deleted_at = NOW()
                        WHERE task_id = $1::uuid AND task_attempt_id = $2
                          AND deleted_at IS NULL
                        """,
                        task_id,
                        attempt_id,
                    )

            attempt_count = int(row["attempt_count"] or 0)
            max_attempts = int(row["max_attempts"] or 1)
            if attempt_count < max_attempts:
                next_attempt = observed_at + calculate_retry_delay(attempt_count)
                await conn.execute(
                    """
                    UPDATE tasks
                    SET status = 'queued', lease_owner = NULL, lease_token = NULL,
                        lease_expires_at = NULL, active_attempt_id = NULL,
                        next_attempt_at = $2, error_message = 'Worker lease expired',
                        updated_at = NOW()
                    WHERE task_id = $1::uuid
                    """,
                    task_id,
                    next_attempt,
                )
                event_type = "task_queued"
                payload = {
                    "task_id": task_id,
                    "status": "queued",
                    "reason": "lease_expired",
                    "next_attempt_at": next_attempt.isoformat(),
                }
                event_data = {
                    "reason": "lease_expired",
                    "next_attempt_at": next_attempt.isoformat(),
                }
                next_attempt_at = next_attempt
            else:
                await conn.execute(
                    """
                    UPDATE tasks
                    SET status = 'failed', lease_owner = NULL, lease_token = NULL,
                        lease_expires_at = NULL, active_attempt_id = NULL,
                        error_message = 'Worker lease expired after max attempts',
                        finished_at = NOW(), updated_at = NOW()
                    WHERE task_id = $1::uuid
                    """,
                    task_id,
                )
                event_type = "task_failed"
                payload = {
                    "task_id": task_id,
                    "status": "failed",
                    "reason": "lease_expired",
                }
                event_data = {"reason": "lease_expired", "terminal": True}
                next_attempt_at = None

            event_row = await conn.fetchrow(
                """
                INSERT INTO task_events (task_id, task_attempt_id, event_type, event_data, created_at)
                VALUES ($1::uuid, $2, 'attempt_lost', $3::jsonb, NOW())
                RETURNING task_event_id
                """,
                task_id,
                attempt_id,
                json.dumps(event_data),
            )
            event_id = event_row["task_event_id"] if event_row else 0
            await conn.execute(
                """
                INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload,
                                           status, next_attempt_at, created_at)
                VALUES ('task', $1::uuid, $2, $3::jsonb, 'pending', COALESCE($4, NOW()), NOW())
                """,
                task_id,
                event_type,
                json.dumps({**payload, "task_event_id": event_id}),
                next_attempt_at,
            )

    return {
        "task_id": task_id,
        "status": payload["status"],
        "attempt_id": attempt_id,
        "reason": "lease_expired",
        "orphaned_artifacts": orphaned_artifacts,
    }


async def request_cancel_task(pool, task_id: str) -> Optional[Dict[str, Any]]:
    """Request cancellation of a running task.

    Sets cancel_requested_at so the worker can detect it and gracefully
    stop the Docker container before marking the task as CANCELLED.
    """
    query = """
        UPDATE tasks
        SET cancel_requested_at = NOW(), updated_at = NOW()
        WHERE task_id = $1::uuid AND status IN ('claimed', 'running')
        RETURNING task_id, status, cancel_requested_at
    """
    async with pool.acquire() as conn:
        row = await conn.fetchrow(query, task_id)
    if not row:
        return None
    await create_task_event(
        pool,
        task_id=task_id,
        event_type="cancel_requested",
        event_data={},
    )
    return {
        "task_id": str(row["task_id"]),
        "status": row["status"],
        "cancel_requested_at": row["cancel_requested_at"].isoformat() if row["cancel_requested_at"] else None,
    }


async def renew_lease(pool, task_id: str, lease_token: str, lease_seconds: int = 60) -> bool:
    """Renew a task lease. Only the owner with the correct token can renew."""
    from datetime import timedelta
    new_expiry = datetime.now(timezone.utc) + timedelta(seconds=lease_seconds)
    query = """
        UPDATE tasks
        SET lease_expires_at = $3, updated_at = NOW()
        WHERE task_id = $1::uuid AND lease_token = $2 AND lease_expires_at > NOW()
    """
    async with pool.acquire() as conn:
        result = await conn.execute(query, task_id, lease_token, new_expiry)
    parts = result.split(" ")
    return len(parts) == 2 and int(parts[1]) > 0


# ============================================================================
# Task Events
# ============================================================================

async def create_task_event(
    pool,
    task_id: str,
    event_type: str,
    event_data: Optional[Dict[str, Any]] = None,
    task_attempt_id: Optional[int] = None,
) -> TaskEvent:
    """Create a task event."""
    query = """
        INSERT INTO task_events (task_id, task_attempt_id, event_type, event_data, created_at)
        VALUES ($1::uuid, $2, $3, $4::jsonb, NOW())
        RETURNING task_event_id, created_at
    """
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            query, task_id, task_attempt_id, event_type, json.dumps(event_data or {})
        )
    return TaskEvent(
        task_event_id=row["task_event_id"],
        task_id=task_id,
        task_attempt_id=task_attempt_id,
        event_type=event_type,
        event_data=event_data or {},
        created_at=row["created_at"].isoformat(),
    )


async def get_task_events(
    pool,
    task_id: str,
    limit: int = 100,
    after_id: int = 0,
) -> List[Dict[str, Any]]:
    """Get events for a task, ordered by time."""
    bounded_limit = max(1, min(int(limit), 500))
    query = """
        SELECT task_event_id, task_id, task_attempt_id, event_type, event_data, created_at
        FROM task_events
        WHERE task_id = $1::uuid
          AND task_event_id > $2
        ORDER BY created_at ASC
        LIMIT $3
    """
    async with pool.acquire() as conn:
        rows = await conn.fetch(query, task_id, max(0, int(after_id)), bounded_limit)
    return [
        {
            "task_event_id": row["task_event_id"],
            "task_id": str(row["task_id"]),
            "task_attempt_id": row["task_attempt_id"],
            "event_type": row["event_type"],
            "event_data": _jsonb_to_dict(row["event_data"]),
            "created_at": row["created_at"].isoformat() if row["created_at"] else None,
        }
        for row in rows
    ]


# ============================================================================
# Outbox Events
# ============================================================================

async def create_outbox_event(
    pool,
    aggregate_type: str,
    aggregate_id: str,
    event_type: str,
    payload: Dict[str, Any],
    next_attempt_at: Optional[datetime] = None,
) -> OutboxEvent:
    """Create an outbox event for async publishing."""
    query = """
        INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload, next_attempt_at, created_at)
        VALUES ($1, $2::uuid, $3, $4::jsonb, COALESCE($5, NOW()), NOW())
        RETURNING outbox_event_id, created_at
    """
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            query, aggregate_type, aggregate_id, event_type,
            json.dumps(payload or {}), next_attempt_at,
        )
    return OutboxEvent(
        outbox_event_id=row["outbox_event_id"],
        aggregate_type=aggregate_type,
        aggregate_id=aggregate_id,
        event_type=event_type,
        payload=payload,
        created_at=row["created_at"].isoformat(),
    )


async def get_pending_outbox_events(pool, limit: int = 50) -> List[Dict[str, Any]]:
    """Claim pending outbox events for one publisher instance.

    A SELECT with ``FOR UPDATE`` on a connection that is immediately closed
    releases the lock before Redis publish.  Claiming with a durable
    ``publishing`` state prevents two publisher loops from concurrently
    delivering the same event; failures are returned to ``pending``.
    """
    query = """
        WITH picked AS (
            SELECT outbox_event_id
            FROM outbox_events
            WHERE (status = 'pending' AND next_attempt_at <= NOW())
               OR (status = 'publishing' AND claim_expires_at < NOW())
            ORDER BY created_at ASC
            LIMIT $1
            FOR UPDATE SKIP LOCKED
        )
        UPDATE outbox_events AS e
        SET status = 'publishing', claim_expires_at = NOW() + INTERVAL '30 seconds',
            claim_token = gen_random_uuid()::text
        FROM picked
        WHERE e.outbox_event_id = picked.outbox_event_id
        RETURNING e.outbox_event_id, e.aggregate_type, e.aggregate_id, e.event_type,
                  e.payload, e.retry_count, e.created_at, e.claim_expires_at, e.claim_token
    """
    async with pool.acquire() as conn:
        rows = await conn.fetch(query, limit)
    return [
        {
            "outbox_event_id": row["outbox_event_id"],
            "aggregate_type": row["aggregate_type"],
            "aggregate_id": str(row["aggregate_id"]),
            "event_type": row["event_type"],
            "payload": _jsonb_to_dict(row["payload"]),
            "retry_count": row["retry_count"],
            "created_at": row["created_at"].isoformat() if row["created_at"] else None,
            "claim_expires_at": _row_value(row, "claim_expires_at").isoformat() if _row_value(row, "claim_expires_at") else None,
            # Lightweight fakes used by unit tests predate claim fencing;
            # keep their records usable while real PostgreSQL always returns
            # the database-generated token.
            "claim_token": _row_value(row, "claim_token") or f"legacy-{row['outbox_event_id']}",
        }
        for row in rows
    ]


async def mark_outbox_published(pool, outbox_event_id: int, claim_token: str) -> None:
    """Mark an outbox event as published."""
    query = """
        UPDATE outbox_events
        SET status = 'published', published_at = NOW(), claim_expires_at = NULL,
            claim_token = NULL
        WHERE outbox_event_id = $1 AND status = 'publishing' AND claim_token = $2
    """
    async with pool.acquire() as conn:
        await conn.execute(query, outbox_event_id, claim_token)


async def mark_outbox_failed(pool, outbox_event_id: int, claim_token: str, error: str) -> None:
    """Return an outbox event to the retry queue after a publish failure."""
    query = """
        UPDATE outbox_events
        SET status = 'pending', last_error = $3, retry_count = retry_count + 1,
            claim_expires_at = NULL, claim_token = NULL,
            next_attempt_at = NOW() + LEAST(INTERVAL '5 minutes',
                INTERVAL '1 second' * POWER(2, LEAST(retry_count, 8)))
        WHERE outbox_event_id = $1 AND status = 'publishing' AND claim_token = $2
    """
    async with pool.acquire() as conn:
        await conn.execute(query, outbox_event_id, claim_token, redact_error(error))


async def release_outbox_event(pool, outbox_event_id: int, claim_token: str, error: Optional[str] = None) -> None:
    """Release a claimed event when Redis is temporarily unavailable."""
    query = """
        UPDATE outbox_events
        SET status = 'pending', claim_expires_at = NULL, claim_token = NULL,
            last_error = COALESCE($3, last_error)
        WHERE outbox_event_id = $1 AND status = 'publishing' AND claim_token = $2
    """
    async with pool.acquire() as conn:
        await conn.execute(query, outbox_event_id, claim_token, redact_error(error) if error else None)


def redact_error(error: object) -> str:
    """Bound error text before it can enter the database."""
    from backend.security import redact_secrets
    return redact_secrets(error, max_chars=500)


# ============================================================================
# Artifacts
# ============================================================================

async def create_artifact(pool, artifact: Artifact) -> Artifact:
    """Create an artifact record."""
    query = """
        INSERT INTO artifacts (artifact_id, task_id, task_attempt_id, name, kind,
            storage_backend, storage_path, file_size_bytes, checksum_sha256,
            content_type, metadata, created_at)
        VALUES ($1, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, NOW())
        RETURNING created_at
    """
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            query,
            artifact.artifact_id,
            artifact.task_id,
            artifact.task_attempt_id,
            artifact.name,
            artifact.kind,
            artifact.storage_backend,
            artifact.storage_path,
            artifact.file_size_bytes,
            artifact.checksum_sha256,
            artifact.content_type,
            json.dumps(artifact.metadata or {}),
        )
    return Artifact(
        artifact_id=artifact.artifact_id,
        task_id=artifact.task_id,
        name=artifact.name,
        created_at=row["created_at"].isoformat(),
    )


async def create_artifact_if_current_lease(
    pool,
    artifact: Artifact,
    lease_token: str,
    worker_id: Optional[str] = None,
) -> Optional[Artifact]:
    """Insert an artifact only while the worker still owns the lease."""
    query = """
        INSERT INTO artifacts (artifact_id, task_id, task_attempt_id, name, kind,
            storage_backend, storage_path, file_size_bytes, checksum_sha256,
            content_type, metadata, created_at)
        SELECT $1, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, NOW()
        FROM tasks
        WHERE task_id = $2::uuid AND lease_token = $12
          AND active_attempt_id = $3
          AND status IN ('claimed', 'running') AND lease_expires_at > NOW()
          AND (
              $13::text IS NULL
              OR EXISTS (
                  SELECT 1
                  FROM worker_enrollments w
                  WHERE w.worker_id = $13
                    AND w.status = 'active'
                    AND w.revoked_at IS NULL
                    AND (tasks.required_trust_level = 'general' OR w.trust_level = 'full')
              )
          )
        RETURNING created_at
    """
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            query,
            artifact.artifact_id,
            artifact.task_id,
            artifact.task_attempt_id,
            artifact.name,
            artifact.kind,
            artifact.storage_backend,
            artifact.storage_path,
            artifact.file_size_bytes,
            artifact.checksum_sha256,
            artifact.content_type,
            json.dumps(artifact.metadata or {}),
            lease_token,
            worker_id,
        )
    if not row:
        return None
    return Artifact(
        artifact_id=artifact.artifact_id,
        task_id=artifact.task_id,
        task_attempt_id=artifact.task_attempt_id,
        name=artifact.name,
        kind=artifact.kind,
        storage_backend=artifact.storage_backend,
        storage_path=artifact.storage_path,
        file_size_bytes=artifact.file_size_bytes,
        checksum_sha256=artifact.checksum_sha256,
        content_type=artifact.content_type,
        metadata=artifact.metadata,
        created_at=row["created_at"].isoformat() if row["created_at"] else None,
    )


async def get_artifacts_for_task(pool, task_id: str) -> List[Dict[str, Any]]:
    """Get all artifacts for a task."""
    query = """
        SELECT artifact_id, task_id, task_attempt_id, name, kind,
               storage_backend, storage_path, file_size_bytes, checksum_sha256,
               content_type, metadata, created_at
        FROM artifacts
        WHERE task_id = $1::uuid AND deleted_at IS NULL
        ORDER BY created_at ASC
    """
    async with pool.acquire() as conn:
        rows = await conn.fetch(query, task_id)
    return [
        {
            "artifact_id": row["artifact_id"],
            "task_id": str(row["task_id"]),
            "task_attempt_id": row["task_attempt_id"],
            "name": row["name"],
            "kind": row["kind"],
            "storage_backend": row["storage_backend"],
            "storage_path": row["storage_path"],
            "file_size_bytes": row["file_size_bytes"],
            "checksum_sha256": row["checksum_sha256"],
            "content_type": row["content_type"],
            "metadata": _jsonb_to_dict(row["metadata"]),
            "created_at": row["created_at"].isoformat() if row["created_at"] else None,
        }
        for row in rows
    ]


async def get_artifact(pool, artifact_id: str) -> Optional[Dict[str, Any]]:
    """Get a single artifact by ID."""
    query = """
        SELECT artifact_id, task_id, task_attempt_id, name, kind,
               storage_backend, storage_path, file_size_bytes, checksum_sha256,
               content_type, metadata, created_at
        FROM artifacts
        WHERE artifact_id = $1 AND deleted_at IS NULL
    """
    async with pool.acquire() as conn:
        row = await conn.fetchrow(query, artifact_id)
    if not row:
        return None
    return {
        "artifact_id": row["artifact_id"],
        "task_id": str(row["task_id"]),
        "task_attempt_id": row["task_attempt_id"],
        "name": row["name"],
        "kind": row["kind"],
        "storage_backend": row["storage_backend"],
        "storage_path": row["storage_path"],
        "file_size_bytes": row["file_size_bytes"],
        "checksum_sha256": row["checksum_sha256"],
        "content_type": row["content_type"],
        "metadata": _jsonb_to_dict(row["metadata"]),
        "created_at": row["created_at"].isoformat() if row["created_at"] else None,
    }


async def delete_artifact_if_current_lease(
    pool,
    artifact_id: str,
    task_id: str,
    attempt_id: int,
    lease_token: str,
    worker_id: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    """Delete a just-published artifact while its Worker lease is active.

    Artifact upload and attempt completion cross a network boundary for
    remote Workers.  This lease-bound compensation path removes an uploaded
    artifact when completion fails, preventing stale result archives from
    being presented as task output.
    """
    query = """
        DELETE FROM artifacts a
        USING tasks t
        WHERE a.artifact_id = $1
          AND a.task_id = $2::uuid
          AND a.task_attempt_id = $3
          AND t.task_id = a.task_id
          AND t.active_attempt_id = $3
          AND t.lease_token = $4
          AND t.status IN ('claimed', 'running')
          AND t.lease_expires_at > NOW()
          AND ($5::text IS NULL OR t.lease_owner = $5)
        RETURNING a.storage_backend, a.storage_path
    """
    async with pool.acquire() as conn:
        row = await conn.fetchrow(query, artifact_id, task_id, attempt_id, lease_token, worker_id)
    if not row:
        return None
    return {"storage_backend": row["storage_backend"], "storage_path": row["storage_path"]}


# ============================================================================
# TaskAttempt
# ============================================================================

async def create_task_attempt(
    pool,
    task_id: str,
    worker_id: str,
    attempt_index: int,
) -> TaskAttempt:
    """Create a new task attempt."""
    query = """
        INSERT INTO task_attempts (task_id, worker_id, status, attempt_index, started_at)
        VALUES ($1::uuid, $2, 'running', $3, NOW())
        RETURNING task_attempt_id, started_at
    """
    async with pool.acquire() as conn:
        row = await conn.fetchrow(query, task_id, worker_id, attempt_index)
    return TaskAttempt(
        task_attempt_id=row["task_attempt_id"],
        task_id=task_id,
        worker_id=worker_id,
        attempt_index=attempt_index,
        started_at=row["started_at"].isoformat(),
    )


async def complete_task_attempt(
    pool,
    attempt_id: int,
    status: str,
    *,
    task_id: str,
    lease_token: str,
    exit_code: Optional[int] = None,
    error_message: Optional[str] = None,
    token_usage: Optional[Dict[str, Any]] = None,
    executor_image_digest: Optional[str] = None,
    failure_code: Optional[str] = None,
) -> None:
    """Complete only the still-active attempt held by the current Worker."""
    if not task_id or not lease_token:
        raise ValueError("task_id and lease_token are required to complete an attempt")
    if status not in {"succeeded", "failed", "cancelled", "timeout"}:
        raise ValueError("attempt completion status is invalid")
    query = """
        UPDATE task_attempts
        SET status = $2, finished_at = NOW(), exit_code = $3,
            error_message = $4, token_usage = $5::jsonb,
            executor_image_digest = $6, failure_code = $7
        WHERE task_attempt_id = $1
          AND task_id = $8::uuid
          AND status IN ('claimed', 'running')
          AND EXISTS (
              SELECT 1 FROM tasks
              WHERE tasks.task_id = task_attempts.task_id
                AND tasks.active_attempt_id = task_attempts.task_attempt_id
                AND tasks.status IN ('claimed', 'running')
                AND tasks.lease_token = $9
                AND tasks.lease_expires_at > NOW()
          )
    """
    async with pool.acquire() as conn:
        result = await conn.execute(
            query, attempt_id, status, exit_code, error_message,
            json.dumps(token_usage or {}), executor_image_digest, failure_code,
            task_id, lease_token,
        )
    if result.split(" ")[-1] == "0":
        raise RuntimeError("task attempt is no longer the active leased attempt")
