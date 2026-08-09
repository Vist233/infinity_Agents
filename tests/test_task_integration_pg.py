"""Real-PostgreSQL regression tests for the task execution chain.

Covers the bugs found in the design-vs-implementation audit:
- D1: projects table + default project (task creation used to fail on FK/uuid)
- D2: method_source_id flows through claim (dataset/method mounting inputs)
- D4: failed tasks are requeued with backoff instead of terminal "failed"
- D5: retry timestamps are UTC-consistent with the database clock

These tests require a reachable DATABASE_URL; they skip otherwise.
"""

from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

asyncpg = pytest.importorskip("asyncpg")

DATABASE_URL = os.getenv("DATABASE_URL")

pytestmark = pytest.mark.skipif(not DATABASE_URL, reason="DATABASE_URL is not set")


@pytest.fixture
async def pool():
    p = await asyncpg.create_pool(DATABASE_URL, min_size=1, max_size=2)
    from backend.db import ensure_table

    await ensure_table(p)
    yield p
    await p.close()


@pytest.mark.asyncio
async def test_default_project_is_idempotent(pool):
    """D1: the default project exists and ensure_default_project converges."""
    from backend.code_agent.task_service import DEFAULT_PROJECT_ID, ensure_default_project

    first = await ensure_default_project(pool)
    second = await ensure_default_project(pool)
    assert first["project_id"] == DEFAULT_PROJECT_ID
    assert second["project_id"] == first["project_id"]


@pytest.mark.asyncio
async def test_task_lifecycle_with_method_source(pool):
    """D1+D2: create spec/dataset/method source/task on a real DB, then claim."""
    from backend.code_agent.models import DatasetSnapshot, MethodSource, Task, TaskSpec
    from backend.code_agent.task_service import (
        create_dataset_snapshot,
        create_method_source,
        create_task,
        create_task_spec,
        ensure_default_project,
        try_claim_task,
    )

    project = await ensure_default_project(pool)
    project_id = project["project_id"]

    spec = await create_task_spec(pool, TaskSpec(
        task_spec_id=str(uuid.uuid4()),
        project_id=project_id,
        title="integration-spec",
        analysis_type="generic",
    ))

    dataset = await create_dataset_snapshot(pool, DatasetSnapshot(
        dataset_snapshot_id=str(uuid.uuid4()),
        task_spec_id=spec.task_spec_id,
        project_id=project_id,
        original_filename="data.zip",
        stored_path="/tmp/uploaded-datasets/integration-data.zip",
        validation_passed=True,
    ))

    method = await create_method_source(pool, MethodSource(
        method_source_id=str(uuid.uuid4()),
        project_id=project_id,
        task_spec_id=spec.task_spec_id,
        original_filename="workflow.html",
        stored_path="/tmp/uploaded-method-sources/integration-workflow.html",
        content_type="text/html",
    ))

    task, is_new = await create_task(pool, Task(
        task_id=str(uuid.uuid4()),
        task_spec_id=spec.task_spec_id,
        dataset_snapshot_id=dataset.dataset_snapshot_id,
        project_id=project_id,
        method_source_id=method.method_source_id,
        title="integration-task",
        status="queued",
    ))
    assert is_new

    claimed = await try_claim_task(pool, task.task_id, "worker-integration", lease_seconds=30)
    assert claimed is not None
    assert claimed["method_source_id"] == method.method_source_id
    assert claimed["dataset_snapshot_id"] == dataset.dataset_snapshot_id

    # Cleanup to keep the shared database tidy (children first).
    async with pool.acquire() as conn:
        await conn.execute("DELETE FROM task_events WHERE task_id = $1::uuid", task.task_id)
        await conn.execute("DELETE FROM task_attempts WHERE task_id = $1::uuid", task.task_id)
        await conn.execute("DELETE FROM outbox_events WHERE aggregate_id = $1::uuid", task.task_id)
        await conn.execute("DELETE FROM tasks WHERE task_id = $1::uuid", task.task_id)
        await conn.execute("DELETE FROM method_sources WHERE method_source_id = $1::uuid", method.method_source_id)
        await conn.execute("DELETE FROM dataset_snapshots WHERE dataset_snapshot_id = $1::uuid", dataset.dataset_snapshot_id)
        await conn.execute("DELETE FROM task_specs WHERE task_spec_id = $1::uuid", spec.task_spec_id)


@pytest.mark.asyncio
async def test_failed_task_requeues_with_utc_backoff(pool):
    """D4+D5: requeue writes a UTC next_attempt_at and keeps the task queued."""
    from backend.code_agent.models import DatasetSnapshot, Task, TaskSpec
    from backend.code_agent.retry_policy import is_retryable, next_attempt_at
    from backend.code_agent.task_service import (
        create_dataset_snapshot,
        create_task,
        create_task_spec,
        ensure_default_project,
        get_task,
        requeue_task,
        try_claim_task,
    )

    # Failure classification: execution errors retry, verification failures don't.
    assert is_retryable("execution_error")
    assert is_retryable(None)
    assert not is_retryable("verification_failed")

    project = await ensure_default_project(pool)
    spec = await create_task_spec(pool, TaskSpec(
        task_spec_id=str(uuid.uuid4()),
        project_id=project["project_id"],
        title="retry-spec",
        analysis_type="generic",
    ))
    dataset = await create_dataset_snapshot(pool, DatasetSnapshot(
        dataset_snapshot_id=str(uuid.uuid4()),
        task_spec_id=spec.task_spec_id,
        project_id=project["project_id"],
        original_filename="data.zip",
        stored_path="/tmp/uploaded-datasets/retry-data.zip",
        validation_passed=True,
    ))
    task, _ = await create_task(pool, Task(
        task_id=str(uuid.uuid4()),
        task_spec_id=spec.task_spec_id,
        dataset_snapshot_id=dataset.dataset_snapshot_id,
        project_id=project["project_id"],
        title="retry-task",
        status="queued",
    ))

    delay = next_attempt_at(1)
    assert delay >= datetime.now(timezone.utc)
    assert delay <= datetime.now(timezone.utc) + timedelta(seconds=310)

    # Only the lease holder may requeue — claim first to obtain the token.
    claimed = await try_claim_task(pool, task.task_id, "worker-retry", lease_seconds=30)
    assert claimed is not None

    requeued = await requeue_task(
        pool,
        task_id=task.task_id,
        lease_token=claimed["lease_token"],
        next_attempt=delay,
        error_message="integration simulated failure",
    )
    assert requeued

    after = await get_task(pool, task.task_id)
    assert after["status"] == "queued"

    # The stored next_attempt_at must match the DB clock within the backoff
    # window — a naive-local timestamp would drift by the UTC offset (D5).
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT next_attempt_at, NOW() AS db_now FROM tasks WHERE task_id = $1::uuid",
            task.task_id,
        )
    drift = abs((row["next_attempt_at"] - row["db_now"]).total_seconds())
    assert drift <= 310, f"next_attempt_at drifts {drift}s from DB NOW()"

    async with pool.acquire() as conn:
        await conn.execute("DELETE FROM task_events WHERE task_id = $1::uuid", task.task_id)
        await conn.execute("DELETE FROM task_attempts WHERE task_id = $1::uuid", task.task_id)
        await conn.execute("DELETE FROM outbox_events WHERE aggregate_id = $1::uuid", task.task_id)
        await conn.execute("DELETE FROM tasks WHERE task_id = $1::uuid", task.task_id)
        await conn.execute("DELETE FROM dataset_snapshots WHERE dataset_snapshot_id = $1::uuid", dataset.dataset_snapshot_id)
        await conn.execute("DELETE FROM task_specs WHERE task_spec_id = $1::uuid", spec.task_spec_id)
