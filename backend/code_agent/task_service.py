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
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from backend.code_agent.models import (
    Artifact,
    DatasetSnapshot,
    IdempotencyKey,
    MethodSource,
    OutboxEvent,
    Task,
    TaskAttempt,
    TaskEvent,
    TaskSpec,
    TaskStatus,
    can_transition,
    transition_task,
)

logger = logging.getLogger(__name__)

# Well-known UUID for the default project so that fresh deployments and
# idempotent re-creation always converge on the same row.
DEFAULT_PROJECT_ID = "00000000-0000-0000-0000-000000000001"


# ============================================================================
# Projects
# ============================================================================

async def ensure_default_project(pool) -> Dict[str, Any]:
    """Create the default project if missing and return it."""
    query = """
        INSERT INTO projects (project_id, name, description)
        VALUES ($1::uuid, 'Default Project', 'Default project created at startup')
        ON CONFLICT (project_id) DO UPDATE SET updated_at = projects.updated_at
        RETURNING project_id, name, created_at
    """
    async with pool.acquire() as conn:
        row = await conn.fetchrow(query, DEFAULT_PROJECT_ID)
    return {
        "project_id": str(row["project_id"]),
        "name": row["name"],
        "created_at": row["created_at"].isoformat() if row["created_at"] else None,
    }


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

async def check_idempotency(pool, idempotency_key: str) -> Optional[Dict[str, Any]]:
    """Check if an idempotency key already exists and return the resource if so."""
    query = """
        SELECT resource_type, resource_id, created_at
        FROM idempotency_keys
        WHERE idempotency_key = $1 AND expires_at > NOW()
    """
    async with pool.acquire() as conn:
        row = await conn.fetchrow(query, idempotency_key)
    if not row:
        return None
    return {
        "resource_type": row["resource_type"],
        "resource_id": str(row["resource_id"]),
        "created_at": row["created_at"].isoformat(),
    }


async def store_idempotency_key(
    pool,
    idempotency_key: str,
    resource_type: str,
    resource_id: str,
    ttl_hours: int = 24,
) -> None:
    """Store an idempotency key."""
    query = """
        INSERT INTO idempotency_keys (idempotency_key, resource_type, resource_id, expires_at)
        VALUES ($1, $2, $3::uuid, NOW() + INTERVAL '1 hour' * $4)
        ON CONFLICT (idempotency_key) DO NOTHING
    """
    async with pool.acquire() as conn:
        await conn.execute(query, idempotency_key, resource_type, resource_id, ttl_hours)


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
        "spec_json": dict(row["spec_json"]) if row["spec_json"] else {},
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
            method_source_id, title, status, max_attempts, created_by, created_at, updated_at)
        VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7, $8, $9, NOW(), NOW())
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


async def get_task(pool, task_id: str) -> Optional[Dict[str, Any]]:
    """Get a task by ID."""
    query = """
        SELECT task_id, task_spec_id, dataset_snapshot_id, project_id, method_source_id, title,
               status, lease_owner, lease_token, lease_expires_at,
               active_attempt_id, attempt_count, max_attempts,
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


async def get_tasks_by_project(pool, project_id: str, limit: int = 50) -> List[Dict[str, Any]]:
    """Get tasks for a project."""
    query = """
        SELECT task_id, task_spec_id, dataset_snapshot_id, project_id, method_source_id, title,
               status, lease_owner, lease_token, lease_expires_at,
               active_attempt_id, attempt_count, max_attempts,
               result_artifact_id, error_message, created_by,
               created_at, updated_at, finished_at
        FROM tasks
        WHERE project_id = $1::uuid
        ORDER BY created_at DESC
        LIMIT $2
    """
    async with pool.acquire() as conn:
        rows = await conn.fetch(query, project_id, limit)
    return [_task_row_to_dict(row) for row in rows]


def _task_row_to_dict(row: Any) -> Dict[str, Any]:
    return {
        "task_id": str(row["task_id"]),
        "task_spec_id": str(row["task_spec_id"]),
        "dataset_snapshot_id": str(row["dataset_snapshot_id"]),
        "project_id": str(row["project_id"]),
        "method_source_id": str(row["method_source_id"]) if row.get("method_source_id") else None,
        "title": row["title"],
        "status": row["status"],
        "lease_owner": row["lease_owner"],
        "lease_token": row["lease_token"],
        "lease_expires_at": row["lease_expires_at"].isoformat() if row["lease_expires_at"] else None,
        "active_attempt_id": row["active_attempt_id"],
        "attempt_count": row["attempt_count"],
        "max_attempts": row["max_attempts"],
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

async def try_claim_task(
    pool,
    task_id: str,
    worker_id: str,
    lease_seconds: int = 60,
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

    # Atomically try to claim
    claim_query = """
        UPDATE tasks
        SET status = 'claimed',
            lease_owner = $2,
            lease_token = $3,
            lease_expires_at = $4,
            attempt_count = attempt_count + 1,
            updated_at = NOW()
        WHERE task_id = $1::uuid
          AND status = 'queued'
          AND (lease_expires_at IS NULL OR lease_expires_at < NOW())
          AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
        RETURNING task_id, attempt_count, task_spec_id, dataset_snapshot_id,
                  project_id, method_source_id, title, max_attempts
    """
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            claim_query, task_id, worker_id, lease_token, lease_expires
        )

    if not row:
        return None

    task_id_str = str(row["task_id"])
    attempt_index = row["attempt_count"]

    # Create attempt record
    attempt_query = """
        INSERT INTO task_attempts (task_id, worker_id, status, attempt_index, started_at)
        VALUES ($1::uuid, $2, 'running', $3, NOW())
        RETURNING task_attempt_id
    """
    async with pool.acquire() as conn:
        attempt_row = await conn.fetchrow(attempt_query, task_id_str, worker_id, attempt_index)

    # Update task with active attempt
    update_query = """
        UPDATE tasks SET active_attempt_id = $2 WHERE task_id = $1::uuid
    """
    async with pool.acquire() as conn:
        await conn.execute(update_query, task_id_str, attempt_row["task_attempt_id"])

    # Create task event
    await create_task_event(
        pool,
        task_id=task_id_str,
        event_type="task_claimed",
        event_data={
            "worker_id": worker_id,
            "attempt_index": attempt_index,
            "lease_expires_at": lease_expires.isoformat(),
        },
    )

    # Create outbox event
    await create_outbox_event(
        pool,
        aggregate_type="task",
        aggregate_id=task_id_str,
        event_type="task_claimed",
        payload={
            "task_id": task_id_str,
            "worker_id": worker_id,
            "attempt_index": attempt_index,
        },
    )

    return {
        "task_id": task_id_str,
        "task_spec_id": str(row["task_spec_id"]),
        "dataset_snapshot_id": str(row["dataset_snapshot_id"]),
        "project_id": str(row["project_id"]),
        "method_source_id": str(row["method_source_id"]) if row.get("method_source_id") else None,
        "title": row["title"],
        "attempt_index": attempt_index,
        "attempt_id": attempt_row["task_attempt_id"],
        "max_attempts": row["max_attempts"],
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
    # Build dynamic update
    set_clauses = ["status = $2", "updated_at = NOW()"]
    values = [task_id, new_status.value]
    idx = 3

    for key, value in extra_fields.items():
        set_clauses.append(f"{key} = ${idx}")
        values.append(value)
        idx += 1

    # If moving to terminal state, set finished_at
    if new_status in (TaskStatus.SUCCEEDED, TaskStatus.FAILED, TaskStatus.CANCELLED, TaskStatus.TIMEOUT):
        set_clauses.append("finished_at = NOW()")

    # Lease verification if token provided
    lease_clause = ""
    if lease_token:
        lease_clause = f"AND lease_token = ${idx}"
        values.append(lease_token)
        idx += 1

    query = f"""
        UPDATE tasks
        SET {', '.join(set_clauses)}
        WHERE task_id = $1::uuid {lease_clause}
        RETURNING task_id, status, updated_at
    """
    async with pool.acquire() as conn:
        row = await conn.fetchrow(query, *values)

    if not row:
        return None

    # Create event
    await create_task_event(
        pool,
        task_id=task_id,
        event_type=f"task_{new_status.value}",
        event_data=extra_fields,
    )

    # Create outbox event for terminal states
    if new_status in (TaskStatus.SUCCEEDED, TaskStatus.FAILED, TaskStatus.CANCELLED, TaskStatus.TIMEOUT):
        await create_outbox_event(
            pool,
            aggregate_type="task",
            aggregate_id=task_id,
            event_type=f"task_{new_status.value}",
            payload={"task_id": task_id, **extra_fields},
        )

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
            lease_expires_at = NULL, next_attempt_at = $3,
            error_message = $4, updated_at = NOW()
        WHERE task_id = $1::uuid AND lease_token = $2
        RETURNING task_id, status, attempt_count
    """
    async with pool.acquire() as conn:
        row = await conn.fetchrow(query, task_id, lease_token, next_attempt, error_message)
    if not row:
        return None
    await create_task_event(
        pool,
        task_id=task_id,
        event_type="task_requeued",
        event_data={"next_attempt_at": next_attempt.isoformat(), "error": error_message},
    )
    await create_outbox_event(
        pool,
        aggregate_type="task",
        aggregate_id=task_id,
        event_type="task_queued",
        payload={"task_id": task_id, "status": "queued"},
    )
    return {
        "task_id": str(row["task_id"]),
        "status": row["status"],
        "attempt_count": row["attempt_count"],
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


async def get_task_events(pool, task_id: str, limit: int = 100) -> List[Dict[str, Any]]:
    """Get events for a task, ordered by time."""
    query = """
        SELECT task_event_id, task_id, task_attempt_id, event_type, event_data, created_at
        FROM task_events
        WHERE task_id = $1::uuid
        ORDER BY created_at ASC
        LIMIT $2
    """
    async with pool.acquire() as conn:
        rows = await conn.fetch(query, task_id, limit)
    return [
        {
            "task_event_id": row["task_event_id"],
            "task_id": str(row["task_id"]),
            "task_attempt_id": row["task_attempt_id"],
            "event_type": row["event_type"],
            "event_data": dict(row["event_data"]) if row["event_data"] else {},
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
) -> OutboxEvent:
    """Create an outbox event for async publishing."""
    query = """
        INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload, created_at)
        VALUES ($1, $2::uuid, $3, $4::jsonb, NOW())
        RETURNING outbox_event_id, created_at
    """
    async with pool.acquire() as conn:
        row = await conn.fetchrow(query, aggregate_type, aggregate_id, event_type, json.dumps(payload or {}))
    return OutboxEvent(
        outbox_event_id=row["outbox_event_id"],
        aggregate_type=aggregate_type,
        aggregate_id=aggregate_id,
        event_type=event_type,
        payload=payload,
        created_at=row["created_at"].isoformat(),
    )


async def get_pending_outbox_events(pool, limit: int = 50) -> List[Dict[str, Any]]:
    """Get pending outbox events for publishing."""
    query = """
        SELECT outbox_event_id, aggregate_type, aggregate_id, event_type, payload,
               retry_count, created_at
        FROM outbox_events
        WHERE status = 'pending'
        ORDER BY created_at ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED
    """
    async with pool.acquire() as conn:
        rows = await conn.fetch(query, limit)
    return [
        {
            "outbox_event_id": row["outbox_event_id"],
            "aggregate_type": row["aggregate_type"],
            "aggregate_id": str(row["aggregate_id"]),
            "event_type": row["event_type"],
            "payload": dict(row["payload"]) if row["payload"] else {},
            "retry_count": row["retry_count"],
            "created_at": row["created_at"].isoformat() if row["created_at"] else None,
        }
        for row in rows
    ]


async def mark_outbox_published(pool, outbox_event_id: int) -> None:
    """Mark an outbox event as published."""
    query = """
        UPDATE outbox_events
        SET status = 'published', published_at = NOW()
        WHERE outbox_event_id = $1
    """
    async with pool.acquire() as conn:
        await conn.execute(query, outbox_event_id)


async def mark_outbox_failed(pool, outbox_event_id: int, error: str) -> None:
    """Mark an outbox event as failed."""
    query = """
        UPDATE outbox_events
        SET status = 'failed', last_error = $2, retry_count = retry_count + 1
        WHERE outbox_event_id = $1
    """
    async with pool.acquire() as conn:
        await conn.execute(query, outbox_event_id, error)


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


async def get_artifacts_for_task(pool, task_id: str) -> List[Dict[str, Any]]:
    """Get all artifacts for a task."""
    query = """
        SELECT artifact_id, task_id, task_attempt_id, name, kind,
               storage_backend, storage_path, file_size_bytes, checksum_sha256,
               content_type, metadata, created_at
        FROM artifacts
        WHERE task_id = $1::uuid
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
            "metadata": dict(row["metadata"]) if row["metadata"] else {},
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
        WHERE artifact_id = $1
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
        "metadata": dict(row["metadata"]) if row["metadata"] else {},
        "created_at": row["created_at"].isoformat() if row["created_at"] else None,
    }


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
    exit_code: Optional[int] = None,
    error_message: Optional[str] = None,
    token_usage: Optional[Dict[str, Any]] = None,
    executor_image_digest: Optional[str] = None,
    failure_code: Optional[str] = None,
) -> None:
    """Complete a task attempt."""
    query = """
        UPDATE task_attempts
        SET status = $2, finished_at = NOW(), exit_code = $3,
            error_message = $4, token_usage = $5::jsonb,
            executor_image_digest = $6, failure_code = $7
        WHERE task_attempt_id = $1
    """
    async with pool.acquire() as conn:
        await conn.execute(
            query, attempt_id, status, exit_code, error_message,
            json.dumps(token_usage or {}), executor_image_digest, failure_code,
        )
