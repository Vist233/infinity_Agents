from __future__ import annotations

import asyncio
import os
import uuid

import asyncpg
import pytest

from backend.local_runtime.migrations import apply_migrations
from backend.local_runtime.repository import (
    LocalRuntimeRepository,
    RuntimeConflict,
    RuntimeUnauthorized,
)


TEST_DSN = os.getenv("LOCAL_RUNTIME_TEST_DATABASE_URL", "").strip()
pytestmark = pytest.mark.skipif(not TEST_DSN, reason="LOCAL_RUNTIME_TEST_DATABASE_URL is required")


@pytest.fixture
async def runtime_pool():
    await apply_migrations(TEST_DSN)
    pool = await asyncpg.create_pool(TEST_DSN, min_size=1, max_size=8)
    async with pool.acquire() as connection:
        await connection.execute(
            """
            TRUNCATE infinity_runtime.outbox_events,
                     infinity_runtime.task_events,
                     infinity_runtime.artifact_upload_parts,
                     infinity_runtime.artifacts,
                     infinity_runtime.artifact_uploads,
                     infinity_runtime.task_attempts,
                     infinity_runtime.tasks,
                     infinity_runtime.task_specs,
                     infinity_runtime.worker_sessions,
                     infinity_runtime.workers,
                     infinity_runtime.resources
            CASCADE
            """
        )
    try:
        yield pool
    finally:
        await pool.close()


async def seed_resource(pool: asyncpg.Pool, owner: str, kind: str) -> uuid.UUID:
    return await pool.fetchval(
        """
        INSERT INTO infinity_runtime.resources
            (owner_user_id, kind, logical_name, object_key, file_size_bytes, checksum_sha256)
        VALUES ($1, $2, $3, $4, 1, $5)
        RETURNING resource_id
        """,
        owner, kind, f"{kind}.bin", f"inputs/{uuid.uuid4()}", "0" * 64,
    )


@pytest.mark.asyncio
async def test_empty_migration_is_repeatable_and_schema_is_canonical(runtime_pool):
    assert await apply_migrations(TEST_DSN) == []
    tables = await runtime_pool.fetch(
        """
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'infinity_runtime'
        """
    )
    names = {row["table_name"] for row in tables}
    assert {"tasks", "task_attempts", "workers", "worker_sessions", "task_events", "outbox_events", "artifacts", "artifact_uploads", "artifact_upload_parts"} <= names


@pytest.mark.asyncio
async def test_expired_reconnect_keeps_immutable_session_history(runtime_pool):
    repository = LocalRuntimeRepository(runtime_pool)
    await repository.issue_worker(worker_id="worker-b", created_by="admin", credential="persistent-secret")
    first, created = await repository.connect_worker(worker_id="worker-b", credential="persistent-secret", instance_id="machine-a")
    assert created is True
    await runtime_pool.execute(
        "UPDATE infinity_runtime.worker_sessions SET lease_expires_at = NOW() - INTERVAL '1 second' WHERE session_id = $1",
        first.session_id,
    )
    second, created = await repository.connect_worker(worker_id="worker-b", credential="persistent-secret", instance_id="machine-b")
    assert created is True
    assert second.session_id != first.session_id
    assert second.session_epoch == first.session_epoch + 1
    historical = await runtime_pool.fetchrow(
        "SELECT instance_id, session_epoch, disconnected_at FROM infinity_runtime.worker_sessions WHERE session_id = $1",
        first.session_id,
    )
    assert historical["instance_id"] == "machine-a"
    assert historical["session_epoch"] == first.session_epoch
    assert historical["disconnected_at"] is not None


@pytest.mark.asyncio
async def test_public_worker_claims_cross_user_task_once_and_browser_stays_isolated(runtime_pool):
    repository = LocalRuntimeRepository(runtime_pool)
    await repository.issue_worker(worker_id="worker-public", created_by="admin", credential="persistent-secret")
    session, _ = await repository.connect_worker(worker_id="worker-public", credential="persistent-secret", instance_id="machine-a")
    dataset = await seed_resource(runtime_pool, "alice", "dataset")
    task_id = await repository.create_task(
        created_by="alice", title="Alice task", goal="Run method", execution_document={"steps": ["run"]}, dataset_resource_id=dataset,
    )
    assert task_id in await repository.list_queued_task_ids(session)
    assert await repository.get_task_for_user(task_id, "alice") is not None
    assert await repository.get_task_for_user(task_id, "bob") is None

    results = await asyncio.gather(
        repository.claim_task(session, task_id),
        repository.claim_task(session, task_id),
        return_exceptions=True,
    )
    claims = [result for result in results if not isinstance(result, Exception)]
    conflicts = [result for result in results if isinstance(result, RuntimeConflict)]
    assert len(claims) == 1
    assert len(conflicts) == 1
    assert await runtime_pool.fetchval("SELECT COUNT(*) FROM infinity_runtime.task_attempts WHERE task_id = $1", task_id) == 1
    assert await runtime_pool.fetchval("SELECT COUNT(*) FROM infinity_runtime.task_events WHERE task_id = $1", task_id) == 1
    assert await runtime_pool.fetchval("SELECT COUNT(*) FROM infinity_runtime.outbox_events WHERE aggregate_id = $1", task_id) == 1


@pytest.mark.asyncio
async def test_user_cannot_create_task_with_another_users_dataset(runtime_pool):
    repository = LocalRuntimeRepository(runtime_pool)
    dataset = await seed_resource(runtime_pool, "alice", "dataset")
    with pytest.raises(RuntimeUnauthorized, match="TASK_RESOURCE_OWNERSHIP_INVALID"):
        await repository.create_task(
            created_by="bob", title="Stolen input", goal="Run",
            execution_document={}, dataset_resource_id=dataset,
        )
    assert await runtime_pool.fetchval("SELECT COUNT(*) FROM infinity_runtime.task_specs") == 0
    assert await runtime_pool.fetchval("SELECT COUNT(*) FROM infinity_runtime.tasks") == 0


@pytest.mark.asyncio
async def test_stale_session_cannot_renew_attempt(runtime_pool):
    repository = LocalRuntimeRepository(runtime_pool)
    await repository.issue_worker(worker_id="worker-public", created_by="admin", credential="persistent-secret")
    first, _ = await repository.connect_worker(worker_id="worker-public", credential="persistent-secret", instance_id="machine-a")
    dataset = await seed_resource(runtime_pool, "alice", "dataset")
    task_id = await repository.create_task(
        created_by="alice", title="Lease test", goal="Run", execution_document={}, dataset_resource_id=dataset,
    )
    claim = await repository.claim_task(first, task_id)
    await runtime_pool.execute(
        "UPDATE infinity_runtime.worker_sessions SET lease_expires_at = NOW() - INTERVAL '1 second' WHERE session_id = $1",
        first.session_id,
    )
    await repository.connect_worker(worker_id="worker-public", credential="persistent-secret", instance_id="machine-b")
    with pytest.raises(RuntimeConflict, match="ATTEMPT_FENCING_REJECTED"):
        await repository.renew_task(first, claim)
