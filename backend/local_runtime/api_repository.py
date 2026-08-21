"""L2 repository extensions: Worker v2 API queries over the canonical schema.

These methods implement the PostgreSQL half of the local Worker v2 control
and data plane (session touch, poll, attempt authentication, spec/input
lookup, artifact finalize and terminal task transitions). L1 files stay
untouched; the API layer binds against `LocalRuntimeApiRepository`.
"""

from __future__ import annotations

import json
import uuid
from typing import Any

import asyncpg

from .repository import (
    ATTEMPT_TTL_SECONDS,
    SESSION_TTL_SECONDS,
    LocalRuntimeRepository,
    RuntimeConflict,
    SessionContext,
    hash_secret,
)

from datetime import timedelta


SESSION_LIVE_CLAUSE = """
    EXISTS (
        SELECT 1 FROM infinity_runtime.worker_sessions s
        WHERE s.session_id = {sid} AND s.worker_id = {wid}
          AND s.session_epoch = {epoch} AND s.instance_id = {iid}
          AND s.disconnected_at IS NULL AND s.lease_expires_at > {now}
    )
"""


class LocalRuntimeApiRepository(LocalRuntimeRepository):
    async def load_active_worker(self, worker_id: str, credential: str) -> asyncpg.Record | None:
        row = await self.pool.fetchrow(
            "SELECT * FROM infinity_runtime.workers WHERE worker_id = $1 AND status = 'active'",
            worker_id,
        )
        if not row or row["credential_hash"] != hash_secret(credential):
            return None
        return row

    async def get_live_session(self, session_id: str, worker_id: str) -> asyncpg.Record | None:
        return await self.pool.fetchrow(
            """
            SELECT * FROM infinity_runtime.worker_sessions
            WHERE session_id = $1 AND worker_id = $2
              AND disconnected_at IS NULL AND lease_expires_at > NOW()
            """,
            session_id,
            worker_id,
        )

    async def touch_session(self, session: SessionContext) -> bool:
        async with self.pool.acquire() as connection:
            async with connection.transaction():
                database_now = await connection.fetchval("SELECT NOW()")
                lease_expires_at = database_now + timedelta(seconds=SESSION_TTL_SECONDS)
                session_result = await connection.execute(
                    """
                    UPDATE infinity_runtime.worker_sessions
                    SET last_seen_at = $5, lease_expires_at = $6
                    WHERE session_id = $1 AND worker_id = $2 AND session_epoch = $3
                      AND instance_id = $4 AND disconnected_at IS NULL AND lease_expires_at > $5
                    """,
                    session.session_id, session.worker_id, session.session_epoch,
                    session.instance_id, database_now, lease_expires_at,
                )
                worker_result = await connection.execute(
                    """
                    UPDATE infinity_runtime.workers
                    SET last_seen_at = $2, updated_at = $2
                    WHERE worker_id = $1 AND status = 'active'
                    """,
                    session.worker_id,
                    database_now,
                )
                return session_result == "UPDATE 1" and worker_result == "UPDATE 1"

    async def poll_queued_tasks(self, session: SessionContext, limit: int = 1) -> list[asyncpg.Record]:
        return await self.pool.fetch(
            """
            SELECT t.task_id, t.task_spec_id, t.title, t.attempt_count, t.max_attempts,
                   s.dataset_resource_id, s.method_resource_id
            FROM infinity_runtime.tasks t
            JOIN infinity_runtime.task_specs s ON s.task_spec_id = t.task_spec_id
            WHERE t.status = 'queued' AND t.execution_pool_id = $1
              AND t.cancel_requested_at IS NULL
              AND EXISTS (
                SELECT 1 FROM infinity_runtime.worker_sessions s2
                WHERE s2.session_id = $2 AND s2.worker_id = $3
                  AND s2.session_epoch = $4 AND s2.instance_id = $5
                  AND s2.disconnected_at IS NULL AND s2.lease_expires_at > NOW()
              )
            ORDER BY t.priority DESC, t.created_at, t.task_id
            LIMIT $6
            """,
            session.pool_id, session.session_id, session.worker_id,
            session.session_epoch, session.instance_id, limit,
        )

    async def renew_attempt(self, session: SessionContext, claim: Any) -> None:
        """Extend the attempt lease; the claim already carries the hashed lease token."""
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
                    claim.lease_token_hash, lease_expires_at, database_now,
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
                    claim.lease_token_hash, claim.fencing_epoch,
                    lease_expires_at, database_now, session.session_id,
                    session.session_epoch, session.instance_id,
                )
                if attempt_result != "UPDATE 1" or task_result != "UPDATE 1":
                    raise RuntimeConflict("ATTEMPT_FENCING_REJECTED")

    async def authenticate_attempt(
        self,
        session: SessionContext,
        task_id: uuid.UUID,
        attempt_id: uuid.UUID,
        lease_token: str,
        *,
        allow_succeeded: bool = False,
    ) -> asyncpg.Record:
        statuses = "('claimed', 'running', 'succeeded')" if allow_succeeded else "('claimed', 'running')"
        row = await self.pool.fetchrow(
            f"""
            SELECT a.attempt_id, a.task_id, a.worker_id, a.session_id,
                   a.fencing_epoch, a.lease_expires_at, a.status
            FROM infinity_runtime.task_attempts a
            JOIN infinity_runtime.worker_sessions s ON s.session_id = a.session_id
            WHERE a.attempt_id = $1 AND a.task_id = $2 AND a.worker_id = $3
              AND a.session_id = $4 AND a.lease_token_hash = $5
              AND a.status IN {statuses} AND a.lease_expires_at > NOW()
              AND s.worker_id = $3 AND s.session_epoch = $6 AND s.instance_id = $7
              AND s.disconnected_at IS NULL AND s.lease_expires_at > NOW()
            """,
            attempt_id, task_id, session.worker_id, session.session_id,
            hash_secret(lease_token), session.session_epoch, session.instance_id,
        )
        if not row:
            raise RuntimeConflict("ATTEMPT_FENCING_REJECTED")
        return row

    async def get_spec_for_attempt(
        self,
        session: SessionContext,
        task_id: uuid.UUID,
        attempt: asyncpg.Record,
    ) -> dict[str, Any] | None:
        return await self.pool.fetchrow(
            f"""
            SELECT t.cancel_requested_at,
                   s.title, s.goal, s.execution_document,
                   ds.logical_name AS dataset_name, ds.file_size_bytes AS dataset_size,
                   ds.checksum_sha256 AS dataset_sha256, ds.state AS dataset_state,
                   m.logical_name AS method_name, m.file_size_bytes AS method_size,
                   m.checksum_sha256 AS method_sha256, m.state AS method_state
            FROM infinity_runtime.tasks t
            JOIN infinity_runtime.task_specs s ON s.task_spec_id = t.task_spec_id
            JOIN infinity_runtime.resources ds ON ds.resource_id = s.dataset_resource_id
            LEFT JOIN infinity_runtime.resources m ON m.resource_id = s.method_resource_id
            WHERE t.task_id = $1 AND t.active_attempt_id = $2
              AND t.lease_worker_id = $3 AND t.lease_epoch = $4
              AND {SESSION_LIVE_CLAUSE.format(sid='$5', wid='$3', epoch='$6', iid='$7', now='NOW()')}
            """,
            task_id, attempt["attempt_id"], session.worker_id, attempt["fencing_epoch"],
            session.session_id, session.session_epoch, session.instance_id,
        )

    async def get_input_for_attempt(
        self,
        session: SessionContext,
        task_id: uuid.UUID,
        attempt: asyncpg.Record,
        kind: str,
    ) -> asyncpg.Record | None:
        join_clause = (
            "JOIN infinity_runtime.resources r ON r.resource_id = s.dataset_resource_id"
            if kind == "dataset"
            else "JOIN infinity_runtime.resources r ON r.resource_id = s.method_resource_id"
        )
        return await self.pool.fetchrow(
            f"""
            SELECT r.object_key, r.logical_name, r.content_type,
                   r.file_size_bytes, r.checksum_sha256, r.state
            FROM infinity_runtime.tasks t
            JOIN infinity_runtime.task_specs s ON s.task_spec_id = t.task_spec_id
            {join_clause}
            WHERE t.task_id = $1 AND t.active_attempt_id = $2
              AND t.lease_worker_id = $3 AND t.lease_epoch = $4
              AND {SESSION_LIVE_CLAUSE.format(sid='$5', wid='$3', epoch='$6', iid='$7', now='NOW()')}
            """,
            task_id, attempt["attempt_id"], session.worker_id, attempt["fencing_epoch"],
            session.session_id, session.session_epoch, session.instance_id,
        )

    async def start_artifact_upload(
        self,
        session: SessionContext,
        task_id: uuid.UUID,
        attempt: asyncpg.Record,
        lease_token_hash: str,
        *,
        upload_id: uuid.UUID,
        artifact_id: uuid.UUID,
        object_key: str,
        name: str,
        kind: str,
        content_type: str,
        expected_size_bytes: int,
        expected_sha256: str,
        manifest: dict[str, Any],
        part_size_bytes: int,
        part_count: int,
    ) -> None:
        async with self.pool.acquire() as connection:
            async with connection.transaction():
                await connection.execute(
                    f"""
                    INSERT INTO infinity_runtime.artifact_uploads
                        (upload_id, artifact_id, task_id, attempt_id, worker_id,
                         object_key, name, kind, content_type, expected_size_bytes,
                         expected_sha256, part_size_bytes, part_count, manifest_json)
                    SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb
                    WHERE {SESSION_LIVE_CLAUSE.format(sid='$15', wid='$5', epoch='$16', iid='$17', now='NOW()')}
                      AND EXISTS (
                        SELECT 1 FROM infinity_runtime.task_attempts a
                        WHERE a.attempt_id = $4 AND a.task_id = $3 AND a.worker_id = $5
                          AND a.session_id = $15 AND a.lease_token_hash = $18
                          AND a.status IN ('claimed', 'running') AND a.lease_expires_at > NOW()
                      )
                    """,
                    upload_id, artifact_id, task_id, attempt["attempt_id"], session.worker_id,
                    object_key, name, kind, content_type, expected_size_bytes,
                    expected_sha256, part_size_bytes, part_count, json.dumps(manifest),
                    session.session_id, session.session_epoch, session.instance_id, lease_token_hash,
                )
                inserted = await connection.fetchval(
                    "SELECT COUNT(*) FROM infinity_runtime.artifact_uploads WHERE upload_id = $1",
                    upload_id,
                )
                if inserted != 1:
                    raise RuntimeConflict("ATTEMPT_FENCING_REJECTED")

    async def save_artifact_part(
        self,
        session: SessionContext,
        upload: asyncpg.Record,
        attempt: asyncpg.Record,
        lease_token_hash: str,
        *,
        part_number: int,
        part_object_key: str,
        size_bytes: int,
        checksum_sha256: str,
    ) -> None:
        async with self.pool.acquire() as connection:
            async with connection.transaction():
                result = await connection.execute(
                    f"""
                    INSERT INTO infinity_runtime.artifact_upload_parts
                        (upload_id, part_number, object_key, file_size_bytes, checksum_sha256)
                    SELECT $1, $2, $3, $4, $5
                    WHERE EXISTS (
                        SELECT 1 FROM infinity_runtime.artifact_uploads u
                        WHERE u.upload_id = $1 AND u.status = 'open' AND u.finalize_owner IS NULL
                    )
                    AND {SESSION_LIVE_CLAUSE.format(sid='$6', wid='$7', epoch='$8', iid='$9', now='NOW()')}
                    AND EXISTS (
                        SELECT 1 FROM infinity_runtime.task_attempts a
                        WHERE a.attempt_id = $10 AND a.task_id = $11 AND a.worker_id = $7
                          AND a.session_id = $6 AND a.lease_token_hash = $12
                          AND a.status IN ('claimed', 'running') AND a.lease_expires_at > NOW()
                    )
                    ON CONFLICT (upload_id, part_number) DO UPDATE
                    SET object_key = EXCLUDED.object_key,
                        file_size_bytes = EXCLUDED.file_size_bytes,
                        checksum_sha256 = EXCLUDED.checksum_sha256,
                        created_at = NOW()
                    """,
                    upload["upload_id"], part_number, part_object_key, size_bytes, checksum_sha256,
                    session.session_id, session.worker_id, session.session_epoch,
                    session.instance_id, attempt["attempt_id"], upload["task_id"], lease_token_hash,
                )
                if result not in {"INSERT 0 1", "UPDATE 1"}:
                    raise RuntimeConflict("ATTEMPT_FENCING_REJECTED")

    async def claim_finalize(
        self,
        session: SessionContext,
        upload: asyncpg.Record,
        attempt: asyncpg.Record,
        lease_token_hash: str,
        finalize_owner: str,
    ) -> bool:
        result = await self.pool.execute(
            f"""
            UPDATE infinity_runtime.artifact_uploads
            SET status = 'finalizing', finalize_owner = $2, finalize_started_at = NOW(),
                updated_at = NOW()
            WHERE upload_id = $1 AND worker_id = $3 AND status = 'open'
              AND finalize_owner IS NULL
              AND {SESSION_LIVE_CLAUSE.format(sid='$4', wid='$3', epoch='$5', iid='$6', now='NOW()')}
              AND EXISTS (
                SELECT 1 FROM infinity_runtime.task_attempts a
                WHERE a.attempt_id = $7 AND a.task_id = $8 AND a.worker_id = $3
                  AND a.session_id = $4 AND a.lease_token_hash = $9
                  AND a.status IN ('claimed', 'running') AND a.lease_expires_at > NOW()
              )
            """,
            upload["upload_id"], finalize_owner, session.worker_id,
            session.session_id, session.session_epoch, session.instance_id,
            attempt["attempt_id"], upload["task_id"], lease_token_hash,
        )
        return result == "UPDATE 1"

    async def publish_artifact(
        self,
        session: SessionContext,
        upload: asyncpg.Record,
        attempt: asyncpg.Record,
        lease_token_hash: str,
        *,
        measured_size: int,
        measured_sha256: str,
    ) -> None:
        artifact_id = upload["artifact_id"]
        async with self.pool.acquire() as connection:
            async with connection.transaction():
                database_now = await connection.fetchval("SELECT NOW()")
                await connection.execute(
                    """
                    INSERT INTO infinity_runtime.artifacts
                        (artifact_id, upload_id, task_id, attempt_id, object_key, name,
                         kind, content_type, file_size_bytes, checksum_sha256, manifest_json)
                    SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb
                    WHERE EXISTS (
                        SELECT 1 FROM infinity_runtime.artifact_uploads
                        WHERE upload_id = $2 AND status = 'finalizing' AND finalize_owner IS NOT NULL
                    )
                    ON CONFLICT (artifact_id) DO NOTHING
                    """,
                    artifact_id, upload["upload_id"], upload["task_id"], attempt["attempt_id"],
                    upload["object_key"], upload["name"], upload["kind"], upload["content_type"],
                    measured_size, measured_sha256,
                    upload["manifest_json"] if isinstance(upload["manifest_json"], str)
                    else json.dumps(upload["manifest_json"]),
                )
                task_result = await connection.execute(
                    f"""
                    UPDATE infinity_runtime.tasks
                    SET status = 'succeeded', result_artifact_id = $2,
                        lease_expires_at = $3, updated_at = $3, finished_at = $3,
                        error_code = NULL, error_detail = NULL
                    WHERE task_id = $1 AND active_attempt_id = $4
                      AND lease_worker_id = $5 AND lease_epoch = $6
                      AND lease_token_hash = $7 AND status IN ('claimed', 'running', 'succeeded')
                      AND cancel_requested_at IS NULL
                      AND EXISTS (
                        SELECT 1 FROM infinity_runtime.artifacts
                        WHERE artifact_id = $2 AND upload_id = $11 AND status = 'published'
                      )
                      AND {SESSION_LIVE_CLAUSE.format(sid='$8', wid='$5', epoch='$9', iid='$10', now='$3')}
                    """,
                    upload["task_id"], artifact_id, database_now, attempt["attempt_id"],
                    session.worker_id, attempt["fencing_epoch"], lease_token_hash,
                    session.session_id, session.session_epoch, session.instance_id,
                    upload["upload_id"],
                )
                if task_result != "UPDATE 1":
                    raise RuntimeConflict("ATTEMPT_FENCING_REJECTED")
                upload_result = await connection.execute(
                    """
                    UPDATE infinity_runtime.artifact_uploads
                    SET status = 'completed', completed_at = COALESCE(completed_at, $2),
                        finalize_owner = NULL, finalize_started_at = NULL, updated_at = $2
                    WHERE upload_id = $1 AND task_id = $3 AND attempt_id = $4
                      AND worker_id = $5 AND artifact_id = $6
                      AND ((status = 'finalizing') OR status = 'completed')
                      AND EXISTS (
                        SELECT 1 FROM infinity_runtime.tasks
                        WHERE task_id = $3 AND status = 'succeeded' AND result_artifact_id = $6
                      )
                    """,
                    upload["upload_id"], database_now, upload["task_id"],
                    attempt["attempt_id"], session.worker_id, artifact_id,
                )
                if upload_result != "UPDATE 1":
                    raise RuntimeConflict("ATTEMPT_FENCING_REJECTED")
                attempt_result = await connection.execute(
                    """
                    UPDATE infinity_runtime.task_attempts
                    SET status = 'succeeded', updated_at = $6, finished_at = $6
                    WHERE attempt_id = $1 AND task_id = $2 AND worker_id = $3
                      AND session_id = $4 AND lease_token_hash = $5
                      AND status IN ('claimed', 'running', 'succeeded')
                      AND EXISTS (
                        SELECT 1 FROM infinity_runtime.artifacts
                        WHERE upload_id = $7 AND artifact_id = $8 AND status = 'published'
                      )
                    """,
                    attempt["attempt_id"], upload["task_id"], session.worker_id,
                    session.session_id, lease_token_hash, database_now,
                    upload["upload_id"], artifact_id,
                )
                if attempt_result != "UPDATE 1":
                    raise RuntimeConflict("ATTEMPT_FENCING_REJECTED")
                payload = json.dumps({
                    "task_id": str(upload["task_id"]),
                    "attempt_id": str(attempt["attempt_id"]),
                    "artifact_id": str(artifact_id),
                    "status": "succeeded",
                })
                await connection.execute(
                    """
                    INSERT INTO infinity_runtime.task_events
                        (task_event_id, task_id, attempt_id, event_type, event_data, idempotency_key)
                    VALUES ($1, $2, $3, 'task_succeeded', $4::jsonb, $5)
                    ON CONFLICT (idempotency_key) DO NOTHING
                    """,
                    uuid.uuid4(), upload["task_id"], attempt["attempt_id"],
                    payload, f"task-succeeded:{attempt['attempt_id']}",
                )
                await connection.execute(
                    """
                    INSERT INTO infinity_runtime.outbox_events
                        (event_id, idempotency_key, aggregate_id, event_type, payload_json)
                    VALUES ($1, $2, $3, 'task_succeeded', $4::jsonb)
                    ON CONFLICT (idempotency_key) DO NOTHING
                    """,
                    uuid.uuid4(), f"task-succeeded:{attempt['attempt_id']}",
                    upload["task_id"], payload,
                )

    async def abort_artifact_upload(self, upload_id: uuid.UUID, *, reason: str) -> None:
        await self.pool.execute(
            """
            UPDATE infinity_runtime.artifact_uploads
            SET status = 'aborted', finalize_owner = NULL, finalize_started_at = NULL,
                updated_at = NOW()
            WHERE upload_id = $1 AND status IN ('open', 'finalizing')
            """,
            upload_id,
        )

    async def release_finalize(self, upload_id: uuid.UUID, finalize_owner: str) -> None:
        await self.pool.execute(
            """
            UPDATE infinity_runtime.artifact_uploads
            SET status = 'open', finalize_owner = NULL, finalize_started_at = NULL,
                updated_at = NOW()
            WHERE upload_id = $1 AND finalize_owner = $2 AND status = 'finalizing'
            """,
            upload_id,
            finalize_owner,
        )

    async def get_artifact_upload(
        self, upload_id: uuid.UUID, worker_id: str
    ) -> asyncpg.Record | None:
        return await self.pool.fetchrow(
            "SELECT * FROM infinity_runtime.artifact_uploads WHERE upload_id = $1 AND worker_id = $2",
            upload_id,
            worker_id,
        )

    async def get_upload_parts(self, upload_id: uuid.UUID) -> list[asyncpg.Record]:
        return await self.pool.fetch(
            """
            SELECT part_number, object_key, file_size_bytes, checksum_sha256
            FROM infinity_runtime.artifact_upload_parts
            WHERE upload_id = $1
            ORDER BY part_number ASC
            """,
            upload_id,
        )

    async def get_published_artifact_for_upload(self, upload_id: uuid.UUID) -> asyncpg.Record | None:
        return await self.pool.fetchrow(
            """
            SELECT a.artifact_id, a.name, a.file_size_bytes, a.checksum_sha256,
                   u.status AS upload_status
            FROM infinity_runtime.artifacts a
            JOIN infinity_runtime.artifact_uploads u ON u.upload_id = a.upload_id
            WHERE a.upload_id = $1
            """,
            upload_id,
        )

    async def reset_stale_finalizing(self, older_than_seconds: int = 300) -> int:
        result = await self.pool.execute(
            """
            UPDATE infinity_runtime.artifact_uploads
            SET status = 'open', finalize_owner = NULL, finalize_started_at = NULL,
                updated_at = NOW()
            WHERE status = 'finalizing'
              AND finalize_started_at < NOW() - make_interval(secs => $1)
            """,
            float(older_than_seconds),
        )
        return int(result.rsplit(" ", maxsplit=1)[-1])

    async def finish_task(
        self,
        session: SessionContext,
        task_id: uuid.UUID,
        attempt: asyncpg.Record,
        lease_token_hash: str,
        *,
        target: str,
        error_code: str,
        error_message: str,
    ) -> None:
        if target not in {"failed", "cancelled"}:
            raise RuntimeConflict("TASK_TERMINAL_INVALID")
        async with self.pool.acquire() as connection:
            async with connection.transaction():
                database_now = await connection.fetchval("SELECT NOW()")
                attempt_result = await connection.execute(
                    f"""
                    UPDATE infinity_runtime.task_attempts
                    SET status = $7, failure_code = $5, failure_detail = $6,
                        updated_at = $8, finished_at = $8
                    WHERE attempt_id = $1 AND task_id = $2 AND worker_id = $3
                      AND session_id = $4 AND lease_token_hash = $9
                      AND status IN ('claimed', 'running') AND lease_expires_at > $8
                      AND {SESSION_LIVE_CLAUSE.format(sid='$4', wid='$3', epoch='$10', iid='$11', now='$8')}
                    """,
                    attempt["attempt_id"], task_id, session.worker_id, session.session_id,
                    error_code, error_message, target, database_now, lease_token_hash,
                    session.session_epoch, session.instance_id,
                )
                task_result = await connection.execute(
                    f"""
                    UPDATE infinity_runtime.tasks
                    SET status = $5, error_code = $6, error_detail = $7,
                        lease_expires_at = $8, updated_at = $8, finished_at = $8
                    WHERE task_id = $1 AND active_attempt_id = $2 AND lease_worker_id = $3
                      AND lease_epoch = $4 AND lease_token_hash = $9
                      AND status IN ('claimed', 'running')
                      AND {SESSION_LIVE_CLAUSE.format(sid='$10', wid='$3', epoch='$11', iid='$12', now='$8')}
                    """,
                    task_id, attempt["attempt_id"], session.worker_id,
                    attempt["fencing_epoch"], target, error_code, error_message,
                    database_now, lease_token_hash, session.session_id,
                    session.session_epoch, session.instance_id,
                )
                if attempt_result != "UPDATE 1" or task_result != "UPDATE 1":
                    raise RuntimeConflict("ATTEMPT_FENCING_REJECTED")
                payload = json.dumps({
                    "task_id": str(task_id),
                    "attempt_id": str(attempt["attempt_id"]),
                    "status": target,
                    "error_code": error_code,
                })
                event_type = "task_cancelled" if target == "cancelled" else "task_failed"
                await connection.execute(
                    """
                    INSERT INTO infinity_runtime.task_events
                        (task_event_id, task_id, attempt_id, event_type, event_data, idempotency_key)
                    VALUES ($1, $2, $3, $4, $5::jsonb, $6)
                    ON CONFLICT (idempotency_key) DO NOTHING
                    """,
                    uuid.uuid4(), task_id, attempt["attempt_id"], event_type,
                    payload, f"{target}:{attempt['attempt_id']}",
                )
                await connection.execute(
                    """
                    INSERT INTO infinity_runtime.outbox_events
                        (event_id, idempotency_key, aggregate_id, event_type, payload_json)
                    VALUES ($1, $2, $3, $4, $5::jsonb)
                    ON CONFLICT (idempotency_key) DO NOTHING
                    """,
                    uuid.uuid4(), f"{target}:{attempt['attempt_id']}", task_id, event_type, payload,
                )
