"""Transactional PostgreSQL state machine for public v2 Docker Workers."""

from __future__ import annotations

import hashlib
import hmac
import json
import secrets
import uuid
from dataclasses import dataclass
from datetime import timedelta
from typing import Any

import asyncpg


SESSION_TTL_SECONDS = 90
ATTEMPT_TTL_SECONDS = 90
POOL_ID = "public-default"
NAMESPACE = "infinity-public"
PROTOCOL_VERSION = "2"
RUNTIME_CAPABILITY = "goal-driven-claude-code"


class RuntimeConflict(RuntimeError):
    """A compare-and-set boundary was lost."""


class RuntimeUnauthorized(RuntimeError):
    """A Worker credential or Session binding is invalid."""


class RuntimeNotFound(RuntimeError):
    """The requested runtime object does not exist."""


@dataclass(frozen=True)
class SessionContext:
    worker_id: str
    session_id: str
    session_epoch: int
    instance_id: str
    pool_id: str = POOL_ID
    namespace: str = NAMESPACE


@dataclass(frozen=True)
class Claim:
    task_id: uuid.UUID
    attempt_id: uuid.UUID
    lease_token: str
    fencing_epoch: int
    attempt_number: int


def hash_secret(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


class LocalRuntimeRepository:
    def __init__(self, pool: asyncpg.Pool):
        self.pool = pool

    async def issue_worker(
        self,
        *,
        worker_id: str,
        created_by: str,
        credential: str,
        image_digest: str | None = None,
    ) -> None:
        await self.pool.execute(
            """
            INSERT INTO infinity_runtime.workers
                (worker_id, created_by, credential_hash, image_digest)
            VALUES ($1, $2, $3, $4)
            """,
            worker_id,
            created_by,
            hash_secret(credential),
            image_digest,
        )

    async def connect_worker(
        self,
        *,
        worker_id: str,
        credential: str,
        instance_id: str,
        protocol_version: str = PROTOCOL_VERSION,
        runtime_capability: str = RUNTIME_CAPABILITY,
        image_digest: str | None = None,
    ) -> tuple[SessionContext, bool]:
        if protocol_version != PROTOCOL_VERSION or runtime_capability != RUNTIME_CAPABILITY:
            raise RuntimeConflict("WORKER_PROTOCOL_INCOMPATIBLE")
        async with self.pool.acquire() as connection:
            async with connection.transaction():
                worker = await connection.fetchrow(
                    "SELECT * FROM infinity_runtime.workers WHERE worker_id = $1 FOR UPDATE",
                    worker_id,
                )
                if not worker or worker["status"] != "active" or not hmac.compare_digest(
                    worker["credential_hash"], hash_secret(credential)
                ):
                    raise RuntimeUnauthorized("WORKER_AUTH_INVALID")
                if worker["image_digest"] and worker["image_digest"] != image_digest:
                    raise RuntimeConflict("WORKER_IMAGE_INCOMPATIBLE")
                current = await connection.fetchrow(
                    """
                    SELECT * FROM infinity_runtime.worker_sessions
                    WHERE worker_id = $1
                    ORDER BY session_epoch DESC
                    LIMIT 1 FOR UPDATE
                    """,
                    worker_id,
                )
                database_now = await connection.fetchval("SELECT NOW()")
                lease_expires_at = database_now + timedelta(seconds=SESSION_TTL_SECONDS)
                if current and current["disconnected_at"] is None and current["lease_expires_at"] > database_now:
                    if current["instance_id"] != instance_id:
                        raise RuntimeConflict("WORKER_ALREADY_CONNECTED")
                    updated = await connection.fetchrow(
                        """
                        UPDATE infinity_runtime.worker_sessions
                        SET last_seen_at = $4, lease_expires_at = $5
                        WHERE session_id = $1 AND worker_id = $2 AND session_epoch = $3
                          AND instance_id = $6 AND disconnected_at IS NULL
                          AND lease_expires_at > $4
                        RETURNING session_id, session_epoch
                        """,
                        current["session_id"], worker_id, current["session_epoch"],
                        database_now, lease_expires_at, instance_id,
                    )
                    if not updated:
                        raise RuntimeConflict("WORKER_SESSION_STALE")
                    await connection.execute(
                        "UPDATE infinity_runtime.workers SET last_seen_at = $2, updated_at = $2 WHERE worker_id = $1",
                        worker_id,
                        database_now,
                    )
                    return SessionContext(worker_id, current["session_id"], current["session_epoch"], instance_id), False

                next_epoch = int(current["session_epoch"] if current else 0) + 1
                if current:
                    result = await connection.execute(
                        """
                        UPDATE infinity_runtime.worker_sessions
                        SET disconnected_at = COALESCE(disconnected_at, $4),
                            lease_expires_at = LEAST(lease_expires_at, $4)
                        WHERE session_id = $1 AND worker_id = $2 AND session_epoch = $3
                          AND (disconnected_at IS NOT NULL OR lease_expires_at <= $4)
                        """,
                        current["session_id"], worker_id, current["session_epoch"], database_now,
                    )
                    if result != "UPDATE 1":
                        raise RuntimeConflict("WORKER_SESSION_STALE")
                session_id = f"ws_{secrets.token_urlsafe(32)}"
                await connection.execute(
                    """
                    INSERT INTO infinity_runtime.worker_sessions
                        (session_id, worker_id, pool_id, namespace, instance_id,
                         protocol_version, runtime_capability, image_digest,
                         session_secret_hash, session_epoch, lease_expires_at)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                    """,
                    session_id, worker_id, POOL_ID, NAMESPACE, instance_id,
                    protocol_version, runtime_capability, image_digest,
                    hash_secret(session_id), next_epoch, lease_expires_at,
                )
                await connection.execute(
                    "UPDATE infinity_runtime.workers SET last_seen_at = $2, updated_at = $2 WHERE worker_id = $1",
                    worker_id,
                    database_now,
                )
                return SessionContext(worker_id, session_id, next_epoch, instance_id), True

    async def create_task(
        self,
        *,
        created_by: str,
        title: str,
        goal: str,
        execution_document: dict[str, Any],
        dataset_resource_id: uuid.UUID,
        method_resource_id: uuid.UUID | None = None,
    ) -> uuid.UUID:
        async with self.pool.acquire() as connection:
            async with connection.transaction():
                dataset_ok = await connection.fetchval(
                    """
                    SELECT EXISTS (
                        SELECT 1 FROM infinity_runtime.resources
                        WHERE resource_id = $1 AND owner_user_id = $2
                          AND kind = 'dataset' AND state = 'ready'
                    )
                    """,
                    dataset_resource_id,
                    created_by,
                )
                method_ok = method_resource_id is None or await connection.fetchval(
                    """
                    SELECT EXISTS (
                        SELECT 1 FROM infinity_runtime.resources
                        WHERE resource_id = $1 AND owner_user_id = $2
                          AND kind = 'method' AND state = 'ready'
                    )
                    """,
                    method_resource_id,
                    created_by,
                )
                if not dataset_ok or not method_ok:
                    raise RuntimeUnauthorized("TASK_RESOURCE_OWNERSHIP_INVALID")
                task_spec_id = uuid.uuid4()
                task_id = uuid.uuid4()
                await connection.execute(
                    """
                    INSERT INTO infinity_runtime.task_specs
                        (task_spec_id, created_by, title, goal, execution_document,
                         method_resource_id, dataset_resource_id)
                    VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
                    """,
                    task_spec_id, created_by, title, goal, json.dumps(execution_document),
                    method_resource_id, dataset_resource_id,
                )
                await connection.execute(
                    """
                    INSERT INTO infinity_runtime.tasks
                        (task_id, task_spec_id, created_by, title)
                    VALUES ($1, $2, $3, $4)
                    """,
                    task_id, task_spec_id, created_by, title,
                )
                return task_id

    async def list_queued_task_ids(self, session: SessionContext, limit: int = 25) -> list[uuid.UUID]:
        rows = await self.pool.fetch(
            """
            SELECT t.task_id
            FROM infinity_runtime.tasks t
            WHERE t.status = 'queued' AND t.execution_pool_id = $1
              AND t.cancel_requested_at IS NULL
              AND (t.next_attempt_at IS NULL OR t.next_attempt_at <= NOW())
              AND EXISTS (
                SELECT 1 FROM infinity_runtime.worker_sessions s
                WHERE s.session_id = $2 AND s.worker_id = $3
                  AND s.session_epoch = $4 AND s.instance_id = $5
                  AND s.disconnected_at IS NULL AND s.lease_expires_at > NOW()
              )
            ORDER BY t.priority DESC, t.created_at
            LIMIT $6
            """,
            session.pool_id, session.session_id, session.worker_id,
            session.session_epoch, session.instance_id, limit,
        )
        return [row["task_id"] for row in rows]

    async def claim_task(self, session: SessionContext, task_id: uuid.UUID) -> Claim:
        async with self.pool.acquire() as connection:
            async with connection.transaction():
                live = await connection.fetchval(
                    """
                    SELECT EXISTS (
                        SELECT 1 FROM infinity_runtime.worker_sessions
                        WHERE session_id = $1 AND worker_id = $2 AND session_epoch = $3
                          AND instance_id = $4 AND disconnected_at IS NULL
                          AND lease_expires_at > NOW()
                    )
                    """,
                    session.session_id, session.worker_id, session.session_epoch, session.instance_id,
                )
                if not live:
                    raise RuntimeConflict("WORKER_SESSION_STALE")
                task = await connection.fetchrow(
                    "SELECT * FROM infinity_runtime.tasks WHERE task_id = $1 FOR UPDATE",
                    task_id,
                )
                if not task:
                    raise RuntimeNotFound("TASK_NOT_FOUND")
                if (
                    task["status"] != "queued"
                    or task["execution_pool_id"] != session.pool_id
                    or task["cancel_requested_at"]
                    or (task["next_attempt_at"] is not None and task["next_attempt_at"] > await connection.fetchval("SELECT NOW()"))
                ):
                    raise RuntimeConflict("TASK_NOT_AVAILABLE")
                attempt_id = uuid.uuid4()
                lease_token = f"lease_{secrets.token_urlsafe(32)}"
                lease_hash = hash_secret(lease_token)
                fencing_epoch = int(task["lease_epoch"]) + 1
                attempt_number = int(task["attempt_count"]) + 1
                database_now = await connection.fetchval("SELECT NOW()")
                lease_expires_at = database_now + timedelta(seconds=ATTEMPT_TTL_SECONDS)
                await connection.execute(
                    """
                    INSERT INTO infinity_runtime.task_attempts
                        (attempt_id, task_id, worker_id, session_id, attempt_number,
                         fencing_epoch, lease_token_hash, lease_expires_at)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                    """,
                    attempt_id, task_id, session.worker_id, session.session_id,
                    attempt_number, fencing_epoch, lease_hash, lease_expires_at,
                )
                result = await connection.execute(
                    """
                    UPDATE infinity_runtime.tasks
                    SET status = 'claimed', attempt_count = attempt_count + 1,
                        active_attempt_id = $2, lease_worker_id = $3,
                        lease_epoch = $4, lease_token_hash = $5,
                        lease_expires_at = $6, updated_at = $7
                    WHERE task_id = $1 AND status = 'queued' AND lease_epoch = $8
                      AND execution_pool_id = $9 AND cancel_requested_at IS NULL
                      AND (next_attempt_at IS NULL OR next_attempt_at <= $13)
                      AND EXISTS (
                        SELECT 1 FROM infinity_runtime.worker_sessions s
                        WHERE s.session_id = $10 AND s.worker_id = $3
                          AND s.session_epoch = $11 AND s.instance_id = $12
                          AND s.disconnected_at IS NULL AND s.lease_expires_at > $7
                      )
                    """,
                    task_id, attempt_id, session.worker_id, fencing_epoch, lease_hash,
                    lease_expires_at, database_now, task["lease_epoch"], session.pool_id,
                    session.session_id, session.session_epoch, session.instance_id,
                    database_now,
                )
                if result != "UPDATE 1":
                    raise RuntimeConflict("TASK_CLAIM_CONFLICT")
                event_id = uuid.uuid4()
                outbox_id = uuid.uuid4()
                payload = json.dumps({
                    "task_id": str(task_id), "attempt_id": str(attempt_id),
                    "worker_id": session.worker_id, "fencing_epoch": fencing_epoch,
                })
                await connection.execute(
                    """
                    INSERT INTO infinity_runtime.task_events
                        (task_event_id, task_id, attempt_id, event_type, event_data, idempotency_key)
                    VALUES ($1, $2, $3, 'task_claimed', $4::jsonb, $5)
                    """,
                    event_id, task_id, attempt_id, payload, f"task-claimed:{attempt_id}",
                )
                await connection.execute(
                    """
                    INSERT INTO infinity_runtime.outbox_events
                        (event_id, idempotency_key, aggregate_id, event_type, payload_json)
                    VALUES ($1, $2, $3, 'task_claimed', $4::jsonb)
                    """,
                    outbox_id, f"task-claimed:{attempt_id}", task_id, payload,
                )
                return Claim(task_id, attempt_id, lease_token, fencing_epoch, attempt_number)

    async def renew_task(self, session: SessionContext, claim: Claim) -> None:
        async with self.pool.acquire() as connection:
            async with connection.transaction():
                database_now = await connection.fetchval("SELECT NOW()")
                lease_expires_at = database_now + timedelta(seconds=ATTEMPT_TTL_SECONDS)
                attempt_result = await connection.execute(
                    """
                    UPDATE infinity_runtime.task_attempts a
                    SET status = 'running', lease_expires_at = $6, updated_at = $7
                    WHERE a.attempt_id = $1 AND a.task_id = $2 AND a.worker_id = $3
                      AND a.session_id = $4 AND a.lease_token_hash = $5
                      AND a.fencing_epoch = $8 AND a.status IN ('claimed', 'running')
                      AND a.lease_expires_at > $7
                      AND EXISTS (
                        SELECT 1 FROM infinity_runtime.worker_sessions s
                        WHERE s.session_id = $4 AND s.worker_id = $3
                          AND s.session_epoch = $9 AND s.instance_id = $10
                          AND s.disconnected_at IS NULL AND s.lease_expires_at > $7
                      )
                    """,
                    claim.attempt_id, claim.task_id, session.worker_id, session.session_id,
                    hash_secret(claim.lease_token), lease_expires_at, database_now,
                    claim.fencing_epoch, session.session_epoch, session.instance_id,
                )
                task_result = await connection.execute(
                    """
                    UPDATE infinity_runtime.tasks
                    SET status = 'running', lease_expires_at = $6, updated_at = $7,
                        started_at = COALESCE(started_at, $7)
                    WHERE task_id = $1 AND active_attempt_id = $2 AND lease_worker_id = $3
                      AND lease_token_hash = $4 AND lease_epoch = $5
                      AND status IN ('claimed', 'running') AND lease_expires_at > $7
                      AND EXISTS (
                        SELECT 1 FROM infinity_runtime.worker_sessions s
                        WHERE s.session_id = $8 AND s.worker_id = $3
                          AND s.session_epoch = $9 AND s.instance_id = $10
                          AND s.disconnected_at IS NULL AND s.lease_expires_at > $7
                      )
                    """,
                    claim.task_id, claim.attempt_id, session.worker_id,
                    hash_secret(claim.lease_token), claim.fencing_epoch,
                    lease_expires_at, database_now, session.session_id,
                    session.session_epoch, session.instance_id,
                )
                if attempt_result != "UPDATE 1" or task_result != "UPDATE 1":
                    raise RuntimeConflict("ATTEMPT_FENCING_REJECTED")

    async def get_task_for_user(self, task_id: uuid.UUID, user_id: str) -> asyncpg.Record | None:
        return await self.pool.fetchrow(
            "SELECT * FROM infinity_runtime.tasks WHERE task_id = $1 AND created_by = $2",
            task_id,
            user_id,
        )

    async def retry_task_for_user(self, task_id: uuid.UUID, user_id: str) -> asyncpg.Record:
        """Queue one safe retry, including the single max-attempt override."""
        async with self.pool.acquire() as connection:
            async with connection.transaction():
                task = await connection.fetchrow(
                    "SELECT * FROM infinity_runtime.tasks WHERE task_id = $1 AND created_by = $2 FOR UPDATE",
                    task_id,
                    user_id,
                )
                if not task:
                    raise RuntimeNotFound("TASK_NOT_FOUND")
                if task["status"] not in {"failed", "timeout"}:
                    raise RuntimeConflict("TASK_NOT_RETRYABLE")
                attempt_count = int(task["attempt_count"])
                override_used = bool(task["retry_override_used"])
                if attempt_count >= int(task["max_attempts"]) and override_used:
                    raise RuntimeConflict("TASK_RETRY_LIMIT_REACHED")
                reason = "within_limit" if attempt_count < int(task["max_attempts"]) else "max_attempt_override"
                now = await connection.fetchval("SELECT NOW()")
                await connection.execute(
                    """
                    UPDATE infinity_runtime.tasks
                    SET status = 'queued', next_attempt_at = $2,
                        retry_override_used = retry_override_used OR $3,
                        retry_reason = $4, retry_requested_at = $2,
                        active_attempt_id = NULL, lease_worker_id = NULL,
                        lease_token_hash = NULL, lease_expires_at = NULL,
                        cancel_requested_at = NULL, error_code = NULL,
                        error_detail = NULL, finished_at = NULL, updated_at = $2
                    WHERE task_id = $1 AND status IN ('failed', 'timeout')
                    """,
                    task_id, now, reason == "max_attempt_override", reason,
                )
                payload = json.dumps({"task_id": str(task_id), "status": "queued", "reason": reason})
                await connection.execute(
                    """
                    INSERT INTO infinity_runtime.task_events
                        (task_event_id, task_id, event_type, event_data, idempotency_key)
                    VALUES ($1, $2, 'task_retried', $3::jsonb, $4)
                    ON CONFLICT (idempotency_key) DO NOTHING
                    """,
                    uuid.uuid4(), task_id, payload,
                    f"task-retry:{task_id}:{attempt_count + 1}",
                )
                await connection.execute(
                    """
                    INSERT INTO infinity_runtime.outbox_events
                        (event_id, idempotency_key, aggregate_id, event_type, payload_json)
                    VALUES ($1, $2, $3, 'task_queued', $4::jsonb)
                    ON CONFLICT (idempotency_key) DO NOTHING
                    """,
                    uuid.uuid4(), f"task-retry:{task_id}:{attempt_count + 1}", task_id, payload,
                )
                return await connection.fetchrow(
                    "SELECT * FROM infinity_runtime.tasks WHERE task_id = $1",
                    task_id,
                )

    async def recover_expired_leases(self, *, limit: int = 100) -> int:
        """Fence expired attempts and return eligible tasks to the queue."""
        recovered = 0
        async with self.pool.acquire() as connection:
            async with connection.transaction():
                rows = await connection.fetch(
                    """
                    SELECT * FROM infinity_runtime.tasks
                    WHERE status IN ('claimed', 'running')
                      AND lease_expires_at IS NOT NULL AND lease_expires_at <= NOW()
                    ORDER BY lease_expires_at, task_id
                    FOR UPDATE SKIP LOCKED
                    LIMIT $1
                    """,
                    max(1, min(int(limit), 500)),
                )
                for task in rows:
                    now = await connection.fetchval("SELECT NOW()")
                    attempt_status = await connection.execute(
                        """
                        UPDATE infinity_runtime.task_attempts
                        SET status = 'lost', failure_code = 'LEASE_EXPIRED',
                            failure_detail = 'Worker lease expired', finished_at = $2, updated_at = $2
                        WHERE attempt_id = $1 AND status IN ('claimed', 'running')
                        """,
                        task["active_attempt_id"], now,
                    )
                    if attempt_status != "UPDATE 1":
                        continue
                    count = int(task["attempt_count"])
                    max_attempts = int(task["max_attempts"])
                    override_used = bool(task["retry_override_used"])
                    if count < max_attempts:
                        status, reason = "queued", "lease_expired_recovery"
                    elif not override_used:
                        status, reason = "queued", "max_attempt_override"
                    else:
                        status, reason = "failed", "retry_limit_reached"
                    await connection.execute(
                        """
                        UPDATE infinity_runtime.tasks
                        SET status = $2, next_attempt_at = CASE WHEN $2 = 'queued' THEN $3 ELSE NULL END,
                            retry_override_used = retry_override_used OR ($4 = 'max_attempt_override'),
                            retry_reason = $4, active_attempt_id = NULL,
                            lease_worker_id = NULL, lease_token_hash = NULL,
                            lease_expires_at = NULL, error_code = CASE WHEN $2 = 'failed' THEN 'LEASE_EXPIRED' ELSE NULL END,
                            error_detail = CASE WHEN $2 = 'failed' THEN 'Worker lease expired after retry budget was exhausted' ELSE NULL END,
                            finished_at = CASE WHEN $2 = 'failed' THEN $3 ELSE NULL END, updated_at = $3
                        WHERE task_id = $1
                        """,
                        task["task_id"], status, now, reason,
                    )
                    payload = json.dumps({"task_id": str(task["task_id"]), "status": status, "reason": reason})
                    key = f"task-recovery:{task['task_id']}:{count}:{reason}"
                    await connection.execute(
                        """
                        INSERT INTO infinity_runtime.task_events
                            (task_event_id, task_id, attempt_id, event_type, event_data, idempotency_key)
                        VALUES ($1, $2, $3, 'task_lease_recovered', $4::jsonb, $5)
                        ON CONFLICT (idempotency_key) DO NOTHING
                        """,
                        uuid.uuid4(), task["task_id"], task["active_attempt_id"], payload, key,
                    )
                    await connection.execute(
                        """
                        INSERT INTO infinity_runtime.outbox_events
                            (event_id, idempotency_key, aggregate_id, event_type, payload_json)
                        VALUES ($1, $2, $3, 'task_queued', $4::jsonb)
                        ON CONFLICT (idempotency_key) DO NOTHING
                        """,
                        uuid.uuid4(), key, task["task_id"], payload,
                    )
                    recovered += 1
        return recovered
