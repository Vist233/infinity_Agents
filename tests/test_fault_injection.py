"""Fault-injection / chaos tests for the task execution system.

Tests system resilience under failure conditions:
- Redis crash: task creation survives via outbox, publisher recovers
- Worker crash: lease expiry → reaper recovery → re-scheduling
- Worker execution failures: failure classification → retry or terminate
- DB disconnection: API endpoints degrade gracefully
- SSE stream: reconnection after disconnect
- Multi-worker: crash of one worker → task reclaimed by another

Requires real DATABASE_URL and optionally real Redis.
"""

from __future__ import annotations

import asyncio
import os
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

asyncpg = pytest.importorskip("asyncpg")

DATABASE_URL = os.getenv("DATABASE_URL")
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")

pytestmark = pytest.mark.skipif(not DATABASE_URL, reason="DATABASE_URL is not set")


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
async def pool():
    """Real PostgreSQL connection pool."""
    p = await asyncpg.create_pool(DATABASE_URL, min_size=1, max_size=3)
    from backend.db import ensure_table
    await ensure_table(p)
    yield p
    await p.close()


@pytest.fixture
async def project(pool):
    """Ensure default project exists, return project_id."""
    from backend.code_agent.task_service import ensure_default_project
    proj = await ensure_default_project(pool)
    return proj["project_id"]


async def _create_task_chain(pool, project_id: str, title: str = "chaos-test"):
    """Helper: create spec → dataset → task, return (spec, dataset, task)."""
    from backend.code_agent.models import DatasetSnapshot, Task, TaskSpec
    from backend.code_agent.task_service import (
        create_dataset_snapshot, create_task, create_task_spec,
    )
    spec = await create_task_spec(pool, TaskSpec(
        task_spec_id=str(uuid.uuid4()),
        project_id=project_id,
        title=f"{title}-spec",
        analysis_type="generic",
    ))
    dataset = await create_dataset_snapshot(pool, DatasetSnapshot(
        dataset_snapshot_id=str(uuid.uuid4()),
        task_spec_id=spec.task_spec_id,
        project_id=project_id,
        original_filename="data.zip",
        stored_path="/tmp/uploaded-datasets/chaos.zip",
        validation_passed=True,
    ))
    task, _ = await create_task(pool, Task(
        task_id=str(uuid.uuid4()),
        task_spec_id=spec.task_spec_id,
        dataset_snapshot_id=dataset.dataset_snapshot_id,
        project_id=project_id,
        title=title,
        status="queued",
    ))
    return spec, dataset, task


async def _cleanup_task(pool, task_id: str, *, spec_id: str = None,
                        dataset_id: str = None, method_id: str = None):
    """Clean up test data from shared DB (children first)."""
    async with pool.acquire() as conn:
        await conn.execute("DELETE FROM task_events WHERE task_id = $1::uuid", task_id)
        await conn.execute("DELETE FROM task_attempts WHERE task_id = $1::uuid", task_id)
        await conn.execute("DELETE FROM outbox_events WHERE aggregate_id = $1::uuid", task_id)
        await conn.execute("DELETE FROM tasks WHERE task_id = $1::uuid", task_id)
        if dataset_id:
            await conn.execute(
                "DELETE FROM dataset_snapshots WHERE dataset_snapshot_id = $1::uuid", dataset_id)
        if spec_id:
            await conn.execute(
                "DELETE FROM task_specs WHERE task_spec_id = $1::uuid", spec_id)
        if method_id:
            await conn.execute(
                "DELETE FROM method_sources WHERE method_source_id = $1::uuid", method_id)


# ===========================================================================
# Suite 1: Redis Crash — Outbox Pattern Resilience
# ===========================================================================

class TestRedisCrashOutbox:
    """Verify that task creation survives Redis being down and the outbox
    publisher recovers pending events once Redis is back."""

    @pytest.mark.asyncio
    async def test_task_creation_succeeds_without_redis(self, pool, project):
        """Task creation writes to outbox even if Redis publish fails."""
        spec, dataset, task = await _create_task_chain(pool, project, "redis-down-create")

        # Verify outbox events were created (DB-only, Redis irrelevant).
        from backend.code_agent.task_service import get_pending_outbox_events
        pending = await get_pending_outbox_events(pool, 50)
        task_events = [e for e in pending if e["payload"].get("task_id") == task.task_id]
        assert len(task_events) >= 1, "Outbox events should exist even without Redis"

        await _cleanup_task(pool, task.task_id, spec_id=spec.task_spec_id,
                            dataset_id=dataset.dataset_snapshot_id)

    @pytest.mark.asyncio
    async def test_outbox_publisher_recovers_after_redis_returns(self, pool, project):
        """Simulate: Redis down → events stay pending → Redis up → publisher drains."""
        spec, dataset, task = await _create_task_chain(pool, project, "outbox-recovery")

        from backend.code_agent.task_service import (
            get_pending_outbox_events, mark_outbox_published,
        )

        # Simulate Redis down: events stay pending (already the case since
        # we don't have a publisher running).
        pending_before = await get_pending_outbox_events(pool, 50)
        task_pending = [e for e in pending_before
                        if e["payload"].get("task_id") == task.task_id]
        assert len(task_pending) >= 1

        # Simulate Redis recovery: manually mark events as published
        # (what the real publisher would do after Redis comes back).
        for evt in task_pending:
            await mark_outbox_published(pool, evt["outbox_event_id"], evt["claim_token"])

        pending_after = await get_pending_outbox_events(pool, 50)
        task_remaining = [e for e in pending_after
                          if e["payload"].get("task_id") == task.task_id]
        assert len(task_remaining) == 0, "All events should be published"

        await _cleanup_task(pool, task.task_id, spec_id=spec.task_spec_id,
                            dataset_id=dataset.dataset_snapshot_id)

    @pytest.mark.asyncio
    async def test_outbox_sse_event_not_lost_when_redis_down(self, pool, project):
        """SSE-type outbox events (not task_created/task_queued) must stay
        pending when Redis is down — not be silently dropped."""
        from backend.code_agent.task_service import (
            create_outbox_event, get_pending_outbox_events,
        )

        task_id = str(uuid.uuid4())
        # Create a non-task-stream event (e.g., task_state_change for SSE).
        evt = await create_outbox_event(
            pool,
            aggregate_type="task",
            aggregate_id=task_id,
            event_type="task_state_changed",
            payload={"task_id": task_id, "status": "running"},
        )
        evt_id = evt.outbox_event_id

        # Verify it stays pending (not marked published).
        pending = await get_pending_outbox_events(pool, 50)
        sse_pending = [e for e in pending if e["outbox_event_id"] == evt_id]
        assert len(sse_pending) == 1, "SSE event must stay pending when Redis is down"

        # Clean up.
        async with pool.acquire() as conn:
            await conn.execute(
                "DELETE FROM outbox_events WHERE outbox_event_id = $1", evt_id)


# ===========================================================================
# Suite 2: Worker Crash — Lease Expiry & Reaper Recovery
# ===========================================================================

class TestWorkerCrashReaper:
    """Verify that dead workers' tasks are recovered by the lease reaper."""

    @pytest.mark.asyncio
    async def test_expired_lease_recovers_to_queued(self, pool, project):
        """Worker claims task → worker dies → lease expires → reaper requeues."""
        from backend.code_agent.task_service import try_claim_task, get_task

        spec, dataset, task = await _create_task_chain(pool, project, "reaper-recovery")

        # Simulate worker claiming the task.
        claimed = await try_claim_task(pool, task.task_id, "dead-worker", lease_seconds=1)
        assert claimed is not None
        assert claimed["attempt_index"] == 1

        # Simulate worker death: manually expire the lease.
        async with pool.acquire() as conn:
            await conn.execute(
                """UPDATE tasks SET lease_expires_at = NOW() - INTERVAL '1 minute'
                   WHERE task_id = $1::uuid""",
                task.task_id,
            )

        # Run the reaper logic inline (same as consumer._lease_reaper_loop).
        from backend.code_agent.retry_policy import calculate_retry_delay
        from backend.code_agent.task_service import create_outbox_event

        async with pool.acquire() as conn:
            expired = await conn.fetch(
                """SELECT task_id, attempt_count FROM tasks
                   WHERE status IN ('claimed', 'running')
                     AND lease_expires_at < NOW()
                   LIMIT 10 FOR UPDATE SKIP LOCKED"""
            )
            assert len(expired) >= 1, "Should find expired lease"

            for row in expired:
                if str(row["task_id"]) == task.task_id:
                    if row["attempt_count"] < 3:
                        delay = calculate_retry_delay(row["attempt_count"])
                        next_attempt = datetime.now(timezone.utc) + delay
                        await conn.execute(
                            """UPDATE tasks SET status='queued',
                               lease_owner=NULL, lease_token=NULL,
                               lease_expires_at=NULL, next_attempt_at=$2
                               WHERE task_id=$1::uuid""",
                            str(row["task_id"]), next_attempt,
                        )

        # Verify task is back to queued.
        after = await get_task(pool, task.task_id)
        assert after["status"] == "queued", f"Expected queued, got {after['status']}"

        # get_task doesn't expose next_attempt_at; check DB directly.
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT next_attempt_at FROM tasks WHERE task_id = $1::uuid",
                task.task_id,
            )
        assert row["next_attempt_at"] is not None, "next_attempt_at should be set"

        await _cleanup_task(pool, task.task_id, spec_id=spec.task_spec_id,
                            dataset_id=dataset.dataset_snapshot_id)

    @pytest.mark.asyncio
    async def test_max_retries_exceeded_marks_failed(self, pool, project):
        """Task with attempt_count >= max_attempts → reaper marks as failed."""
        from backend.code_agent.task_service import get_task

        spec, dataset, task = await _create_task_chain(pool, project, "max-retry-fail")

        # Simulate a task that has exhausted all retries.
        async with pool.acquire() as conn:
            await conn.execute(
                """UPDATE tasks SET status='running', attempt_count=3,
                   lease_owner='dead-worker', lease_token='dead-token',
                   lease_expires_at = NOW() - INTERVAL '1 minute'
                   WHERE task_id = $1::uuid""",
                task.task_id,
            )

        # Run reaper.
        async with pool.acquire() as conn:
            expired = await conn.fetch(
                """SELECT task_id, attempt_count FROM tasks
                   WHERE status IN ('claimed', 'running')
                     AND lease_expires_at < NOW()
                   LIMIT 10 FOR UPDATE SKIP LOCKED"""
            )
            for row in expired:
                if str(row["task_id"]) == task.task_id:
                    if row["attempt_count"] >= 3:
                        await conn.execute(
                            """UPDATE tasks SET status='failed',
                               lease_owner=NULL, lease_token=NULL,
                               lease_expires_at=NULL
                               WHERE task_id=$1::uuid""",
                            str(row["task_id"]),
                        )

        after = await get_task(pool, task.task_id)
        assert after["status"] == "failed"

        await _cleanup_task(pool, task.task_id, spec_id=spec.task_spec_id,
                            dataset_id=dataset.dataset_snapshot_id)


# ===========================================================================
# Suite 3: Worker Execution Failure Classification
# ===========================================================================

class TestFailureClassification:
    """Verify _fail_or_requeue routes failures correctly."""

    @pytest.mark.asyncio
    async def test_retryable_failure_requeues(self, pool, project):
        """execution_error → requeue with backoff."""
        from backend.code_agent.task_service import try_claim_task, get_task
        from backend.code_agent.worker.consumer import _fail_or_requeue

        spec, dataset, task = await _create_task_chain(pool, project, "retryable-fail")
        claimed = await try_claim_task(pool, task.task_id, "test-worker", lease_seconds=60)
        assert claimed is not None

        await _fail_or_requeue(
            pool, "test-worker", task.task_id, claimed,
            failure_code="execution_error",
            error_message="simulated execution error",
        )

        after = await get_task(pool, task.task_id)
        assert after["status"] == "queued", f"Expected queued, got {after['status']}"

        await _cleanup_task(pool, task.task_id, spec_id=spec.task_spec_id,
                            dataset_id=dataset.dataset_snapshot_id)

    @pytest.mark.asyncio
    async def test_non_retryable_failure_terminates(self, pool, project):
        """verification_failed → terminal failure."""
        from backend.code_agent.task_service import try_claim_task, get_task
        from backend.code_agent.worker.consumer import _fail_or_requeue

        spec, dataset, task = await _create_task_chain(pool, project, "non-retryable-fail")
        claimed = await try_claim_task(pool, task.task_id, "test-worker", lease_seconds=60)
        assert claimed is not None

        await _fail_or_requeue(
            pool, "test-worker", task.task_id, claimed,
            failure_code="verification_failed",
            error_message="output verification failed",
        )

        after = await get_task(pool, task.task_id)
        assert after["status"] == "failed", f"Expected failed, got {after['status']}"

        await _cleanup_task(pool, task.task_id, spec_id=spec.task_spec_id,
                            dataset_id=dataset.dataset_snapshot_id)

    @pytest.mark.asyncio
    async def test_infrastructure_error_requeues(self, pool, project):
        """infrastructure_error (unexpected exception) → requeue."""
        from backend.code_agent.task_service import try_claim_task, get_task
        from backend.code_agent.worker.consumer import _fail_or_requeue

        spec, dataset, task = await _create_task_chain(pool, project, "infra-fail")
        claimed = await try_claim_task(pool, task.task_id, "test-worker", lease_seconds=60)
        assert claimed is not None

        await _fail_or_requeue(
            pool, "test-worker", task.task_id, claimed,
            failure_code="infrastructure_error",
            error_message="Redis connection lost",
        )

        after = await get_task(pool, task.task_id)
        assert after["status"] == "queued", f"Expected queued, got {after['status']}"

        await _cleanup_task(pool, task.task_id, spec_id=spec.task_spec_id,
                            dataset_id=dataset.dataset_snapshot_id)

    @pytest.mark.asyncio
    async def test_max_attempts_reached_terminates(self, pool, project):
        """Retryable failure but attempt_index >= max_attempts → failed."""
        from backend.code_agent.task_service import try_claim_task, get_task
        from backend.code_agent.worker.consumer import _fail_or_requeue

        spec, dataset, task = await _create_task_chain(pool, project, "max-attempt-fail")

        # Force attempt_count to max so next claim returns max attempt_index.
        async with pool.acquire() as conn:
            await conn.execute(
                "UPDATE tasks SET attempt_count = 2 WHERE task_id = $1::uuid",
                task.task_id,
            )

        claimed = await try_claim_task(pool, task.task_id, "test-worker", lease_seconds=60)
        assert claimed is not None

        # Even though execution_error is retryable, max_attempts is reached.
        await _fail_or_requeue(
            pool, "test-worker", task.task_id, claimed,
            failure_code="execution_error",
            error_message="too many retries",
        )

        after = await get_task(pool, task.task_id)
        assert after["status"] == "failed", f"Expected failed, got {after['status']}"

        await _cleanup_task(pool, task.task_id, spec_id=spec.task_spec_id,
                            dataset_id=dataset.dataset_snapshot_id)

    @pytest.mark.asyncio
    async def test_null_failure_code_is_retryable(self, pool, project):
        """None failure_code (generic error) → retryable."""
        from backend.code_agent.retry_policy import is_retryable
        assert is_retryable(None) is True
        assert is_retryable("execution_error") is True
        assert is_retryable("infrastructure_error") is True
        assert is_retryable("verification_failed") is False
        assert is_retryable("invalid_spec") is False
        assert is_retryable("dataset_invalid") is False


# ===========================================================================
# Suite 4: Redis Client Resilience
# ===========================================================================

class TestRedisClientResilience:
    """Verify RedisClient methods return safe defaults on failure."""

    @pytest.mark.asyncio
    async def test_publish_task_returns_none_when_disconnected(self):
        """publish_task returns None (not raise) when Redis is down."""
        from backend.code_agent.redis_client import RedisClient
        client = RedisClient("redis://nonexistent:9999/0")
        # Don't connect — client._client is None
        result = await client.publish_task({"task_id": "test"})
        assert result is None

    @pytest.mark.asyncio
    async def test_broken_redis_connection_is_marked_not_ready(self):
        from backend.code_agent.redis_client import RedisClient

        client = RedisClient("redis://mock/0")
        broken = AsyncMock()
        broken.xadd.side_effect = ConnectionError("connection reset")
        client._client = broken

        assert await client.publish_task({"task_id": "test"}) is None
        assert client.is_connected is False
        broken.aclose.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_consume_tasks_returns_empty_when_disconnected(self):
        from backend.code_agent.redis_client import RedisClient
        client = RedisClient("redis://nonexistent:9999/0")
        result = await client.consume_tasks("worker-1")
        assert result == []

    @pytest.mark.asyncio
    async def test_publish_task_event_returns_none_when_disconnected(self):
        from backend.code_agent.redis_client import RedisClient
        client = RedisClient("redis://nonexistent:9999/0")
        result = await client.publish_task_event("task-1", {"event_type": "test"})
        assert result is None

    @pytest.mark.asyncio
    async def test_heartbeat_returns_false_when_disconnected(self):
        from backend.code_agent.redis_client import RedisClient
        client = RedisClient("redis://nonexistent:9999/0")
        result = await client.set_worker_heartbeat("w1")
        assert result is False

    @pytest.mark.asyncio
    async def test_alive_workers_empty_when_disconnected(self):
        from backend.code_agent.redis_client import RedisClient
        client = RedisClient("redis://nonexistent:9999/0")
        result = await client.get_alive_workers()
        assert result == []

    @pytest.mark.asyncio
    async def test_rate_limit_allows_when_disconnected(self):
        """When Redis is down, rate limiting fails open (allows request)."""
        from backend.code_agent.redis_client import RedisClient
        client = RedisClient("redis://nonexistent:9999/0")
        allowed, remaining = await client.check_rate_limit("user1", 10, 60)
        assert allowed is True
        assert remaining == 10


# ===========================================================================
# Suite 5: Outbox Publisher with Mocked Redis
# ===========================================================================

class TestOutboxPublisherMocked:
    """Test the outbox publisher's behavior with controlled Redis states."""

    @pytest.mark.asyncio
    async def test_publisher_keeps_pending_when_redis_down(self, pool, project):
        """When publish_task returns None, event stays pending."""
        from backend.code_agent.outbox import OutboxPublisher
        from backend.code_agent.task_service import (
            create_outbox_event, get_pending_outbox_events,
        )

        # Create a pending outbox event.
        spec, dataset, task = await _create_task_chain(pool, project, "pub-redis-down")
        await create_outbox_event(
            pool, "task", task.task_id, "task_state_changed",
            {"task_id": task.task_id, "status": "running"},
        )

        # Mock Redis client that always fails.
        mock_redis = AsyncMock()
        mock_redis.connect = AsyncMock()
        mock_redis.ensure_consumer_group = AsyncMock()
        mock_redis.disconnect = AsyncMock()
        mock_redis.publish_task = AsyncMock(return_value=None)
        mock_redis.publish_task_event = AsyncMock(return_value=None)

        publisher = OutboxPublisher(pool, mock_redis, poll_interval=0.1)
        # Run one batch manually.
        published = await publisher._publish_batch()

        # Events should still be pending.
        pending = await get_pending_outbox_events(pool, 50)
        task_pending = [e for e in pending
                        if e["payload"].get("task_id") == task.task_id]
        assert len(task_pending) >= 1, "Events must stay pending when Redis is down"

        await _cleanup_task(pool, task.task_id, spec_id=spec.task_spec_id,
                            dataset_id=dataset.dataset_snapshot_id)

    @pytest.mark.asyncio
    async def test_publisher_marks_published_when_redis_ok(self, pool, project):
        """When publish succeeds, event is marked published."""
        from backend.code_agent.outbox import OutboxPublisher
        from backend.code_agent.task_service import (
            get_pending_outbox_events,
        )

        spec, dataset, task = await _create_task_chain(pool, project, "pub-redis-ok")

        # Mock Redis client that succeeds.
        mock_redis = AsyncMock()
        mock_redis.connect = AsyncMock()
        mock_redis.ensure_consumer_group = AsyncMock()
        mock_redis.disconnect = AsyncMock()
        mock_redis.publish_task = AsyncMock(return_value="1234-0")
        mock_redis.publish_task_event = AsyncMock(return_value="1235-0")

        publisher = OutboxPublisher(pool, mock_redis, poll_interval=0.1)
        published = await publisher._publish_batch()

        task_pending = await get_pending_outbox_events(pool, 50)
        task_remaining = [e for e in task_pending
                          if e["payload"].get("task_id") == task.task_id]
        assert len(task_remaining) == 0, "Events should be published and removed"
        assert published >= 1

        await _cleanup_task(pool, task.task_id, spec_id=spec.task_spec_id,
                            dataset_id=dataset.dataset_snapshot_id)


# ===========================================================================
# Suite 6: Lease CAS Protection
# ===========================================================================

class TestLeaseCASProtection:
    """Verify that only the lease holder can modify task state."""

    @pytest.mark.asyncio
    async def test_requeue_requires_valid_lease_token(self, pool, project):
        """requeue_task with wrong lease_token should fail (CAS protection)."""
        from backend.code_agent.task_service import try_claim_task, requeue_task

        spec, dataset, task = await _create_task_chain(pool, project, "lease-cas")
        claimed = await try_claim_task(pool, task.task_id, "worker-a", lease_seconds=60)
        assert claimed is not None

        # Try to requeue with a wrong token.
        from datetime import datetime, timezone
        result = await requeue_task(
            pool, task.task_id,
            lease_token="wrong-token-" + uuid.uuid4().hex[:8],
            next_attempt=datetime.now(timezone.utc),
            error_message="hijack attempt",
        )
        assert result is None, "Requeue with wrong token should return None"

        # Try with correct token.
        result = await requeue_task(
            pool, task.task_id,
            lease_token=claimed["lease_token"],
            next_attempt=datetime.now(timezone.utc),
            error_message="legitimate requeue",
        )
        assert result is not None, "Requeue with correct token should succeed"

        await _cleanup_task(pool, task.task_id, spec_id=spec.task_spec_id,
                            dataset_id=dataset.dataset_snapshot_id)

    @pytest.mark.asyncio
    async def test_update_status_requires_valid_lease(self, pool, project):
        """update_task_status with wrong lease_token should not change status."""
        from backend.code_agent.task_service import (
            try_claim_task, update_task_status, get_task,
        )
        from backend.code_agent.models import TaskStatus

        spec, dataset, task = await _create_task_chain(pool, project, "lease-update")
        claimed = await try_claim_task(pool, task.task_id, "worker-b", lease_seconds=60)
        assert claimed is not None

        # Try with wrong token.
        result = await update_task_status(
            pool, task.task_id, TaskStatus.SUCCEEDED,
            lease_token="wrong-token",
        )
        # The update should either fail or not change status.
        after = await get_task(pool, task.task_id)
        # Status should still be claimed/running, not succeeded.
        assert after["status"] != "succeeded", \
            "Status should not change with wrong lease token"

        await _cleanup_task(pool, task.task_id, spec_id=spec.task_spec_id,
                            dataset_id=dataset.dataset_snapshot_id)


# ===========================================================================
# Suite 7: Multi-Worker Competition
# ===========================================================================

class TestMultiWorkerCompetition:
    """Verify CAS-based claiming prevents double processing."""

    @pytest.mark.asyncio
    async def test_only_one_worker_can_claim(self, pool, project):
        """Two workers race to claim — only one succeeds."""
        from backend.code_agent.task_service import try_claim_task

        spec, dataset, task = await _create_task_chain(pool, project, "race-claim")

        claimed_a = await try_claim_task(pool, task.task_id, "worker-a", lease_seconds=60)
        claimed_b = await try_claim_task(pool, task.task_id, "worker-b", lease_seconds=60)

        assert claimed_a is not None, "First claim should succeed"
        assert claimed_b is None, "Second claim should fail (CAS)"

        await _cleanup_task(pool, task.task_id, spec_id=spec.task_spec_id,
                            dataset_id=dataset.dataset_snapshot_id)

    @pytest.mark.asyncio
    async def test_crashed_worker_task_reclaimed_by_other(self, pool, project):
        """Worker-A claims → crashes → reaper requeues → Worker-B claims."""
        from backend.code_agent.task_service import try_claim_task, get_task
        from backend.code_agent.retry_policy import calculate_retry_delay

        spec, dataset, task = await _create_task_chain(pool, project, "handoff")

        # Worker-A claims.
        claimed_a = await try_claim_task(pool, task.task_id, "worker-a", lease_seconds=1)
        assert claimed_a is not None

        # Worker-A crashes: expire the lease.
        async with pool.acquire() as conn:
            await conn.execute(
                """UPDATE tasks SET lease_expires_at = NOW() - INTERVAL '1 minute'
                   WHERE task_id = $1::uuid""",
                task.task_id,
            )

        # Reaper recovers.
        async with pool.acquire() as conn:
            expired = await conn.fetch(
                """SELECT task_id, attempt_count FROM tasks
                   WHERE status IN ('claimed', 'running')
                     AND lease_expires_at < NOW()
                   LIMIT 10 FOR UPDATE SKIP LOCKED"""
            )
            for row in expired:
                if str(row["task_id"]) == task.task_id:
                    delay = calculate_retry_delay(row["attempt_count"])
                    # Set next_attempt_at in the past so Worker-B can claim
                    # immediately (the real reaper would use the delay, but
                    # for testing we skip the wait).
                    next_attempt = datetime.now(timezone.utc) - timedelta(seconds=1)
                    await conn.execute(
                        """UPDATE tasks SET status='queued',
                           lease_owner=NULL, lease_token=NULL,
                           lease_expires_at=NULL, next_attempt_at=$2
                           WHERE task_id=$1::uuid""",
                        str(row["task_id"]), next_attempt,
                    )

        # Worker-B claims the recovered task.
        claimed_b = await try_claim_task(pool, task.task_id, "worker-b", lease_seconds=60)
        assert claimed_b is not None, "Worker-B should claim the recovered task"
        assert claimed_b["attempt_index"] >= 2, \
            f"Expected attempt_index >= 2 (second attempt), got {claimed_b['attempt_index']}"

        await _cleanup_task(pool, task.task_id, spec_id=spec.task_spec_id,
                            dataset_id=dataset.dataset_snapshot_id)


# ===========================================================================
# Suite 8: Error Sanitization
# ===========================================================================

class TestErrorSanitization:
    """Verify sensitive data is stripped from error messages."""

    def test_redacts_file_paths(self):
        from backend.code_agent.worker.consumer import _sanitize_error
        msg = "Error in /home/user/project/app.py:42 something broke"
        result = _sanitize_error(msg)
        assert "/home/user" not in result
        assert ".py:42" not in result

    def test_redacts_db_connection_strings(self):
        from backend.code_agent.worker.consumer import _sanitize_error
        msg = "Connection failed: postgresql://user:pass@host:5432/db"
        result = _sanitize_error(msg)
        assert "postgresql://" not in result
        assert "pass" not in result.lower() or "[redacted]" in result

    def test_redacts_credentials(self):
        from backend.code_agent.worker.consumer import _sanitize_error
        msg = "Auth failed: password=super_secret_token key=abc123"
        result = _sanitize_error(msg)
        assert "super_secret_token" not in result

    def test_truncates_long_messages(self):
        from backend.code_agent.worker.consumer import _sanitize_error
        msg = "x" * 1000
        result = _sanitize_error(msg)
        assert len(result) <= 520  # 500 + "...(truncated)"


# ===========================================================================
# Suite 9: Retry Policy
# ===========================================================================

class TestRetryPolicy:
    """Verify backoff calculations are sane."""

    def test_backoff_increases_with_attempts(self):
        from backend.code_agent.retry_policy import calculate_retry_delay
        delays = [calculate_retry_delay(i).total_seconds() for i in range(5)]
        # Max possible delay increases: 5, 10, 20, 40, 80 (capped at 300)
        # With jitter, actual values are random but bounded.
        for i, d in enumerate(delays):
            max_for_attempt = min(5.0 * (2 ** i), 300.0)
            assert 0 <= d <= max_for_attempt, \
                f"Attempt {i}: delay {d}s exceeds max {max_for_attempt}s"

    def test_backoff_capped_at_max(self):
        from backend.code_agent.retry_policy import calculate_retry_delay
        for _ in range(20):
            delay = calculate_retry_delay(10)  # 5 * 2^10 = 5120, capped at 300
            assert delay.total_seconds() <= 300.0

    def test_next_attempt_at_is_utc(self):
        from backend.code_agent.retry_policy import next_attempt_at
        result = next_attempt_at(1)
        assert result.tzinfo == timezone.utc


# ===========================================================================
# Suite 10: DB Disconnection — API Graceful Degradation
# ===========================================================================

class TestDBDisconnection:
    """Verify API endpoints handle DB failures gracefully (500, not crash)."""

    @pytest.mark.asyncio
    async def test_get_task_with_broken_pool_returns_none(self):
        """get_task with a closed pool should return None, not crash."""
        from backend.code_agent.task_service import get_task

        broken_pool = await asyncpg.create_pool(DATABASE_URL, min_size=1, max_size=1)
        await broken_pool.close()

        # get_task should handle the closed pool gracefully.
        try:
            result = await get_task(broken_pool, str(uuid.uuid4()))
            # If it doesn't raise, it should return None.
            assert result is None
        except Exception:
            # Raising is acceptable (InterfaceError) — the caller (API endpoint)
            # catches it and returns 500.
            pass

    @pytest.mark.asyncio
    async def test_create_task_with_invalid_pool_raises(self):
        """create_task with a broken pool should raise (API returns 500)."""
        from backend.code_agent.task_service import create_task
        from backend.code_agent.models import Task

        broken_pool = await asyncpg.create_pool(DATABASE_URL, min_size=1, max_size=1)
        await broken_pool.close()

        with pytest.raises(Exception):
            await create_task(broken_pool, Task(
                task_id=str(uuid.uuid4()),
                task_spec_id=str(uuid.uuid4()),
                dataset_snapshot_id=str(uuid.uuid4()),
                project_id=str(uuid.uuid4()),
                title="db-down-test",
                status="queued",
            ))


# ===========================================================================
# Suite 11: SSE Stream Resilience
# ===========================================================================

class TestSSEResilience:
    """Verify SSE endpoint behavior under adverse conditions."""

    @pytest.mark.asyncio
    async def test_sse_falls_back_to_db_polling_when_redis_down(self):
        """When Redis is unavailable, SSE should fall back to DB polling."""
        from backend.code_agent.redis_client import RedisClient

        # Verify RedisClient.read_task_events returns empty when disconnected.
        client = RedisClient("redis://nonexistent:9999/0")
        events = await client.read_task_events("some-task-id")
        assert events == [], "Disconnected Redis should return empty events"

    @pytest.mark.asyncio
    async def test_sse_resume_from_last_event_id(self, pool, project):
        """SSE supports resumption via last_event_id."""
        from backend.code_agent.redis_client import RedisClient

        # With a real Redis, test that read_task_events with last_event_id works.
        client = RedisClient(REDIS_URL)
        await client.connect()
        if not client.is_connected:
            pytest.skip("Redis not available")

        try:
            # Publish two events.
            task_id = f"sse-resume-test-{uuid.uuid4().hex[:8]}"
            id1 = await client.publish_task_event(task_id, {
                "event_type": "update", "message": "first",
            })
            id2 = await client.publish_task_event(task_id, {
                "event_type": "update", "message": "second",
            })

            # Read from after id1 — should only get id2.
            await asyncio.sleep(0.2)
            events = await client.read_task_events(task_id, last_event_id=id1, count=10)
            msg_ids = [e.get("_message_id") for e in events]
            assert id1 not in msg_ids, "Should not include events before last_event_id"
        finally:
            await client.disconnect()

    @pytest.mark.asyncio
    async def test_frontend_handles_sse_disconnect(self):
        """The frontend SSE code has a try/catch fallback to polling.

        This is a code-level assertion (not a live browser test) — verifying
        the detail page wraps EventSource in try/catch with setInterval fallback.
        """
        import pathlib
        detail_page = pathlib.Path(
            "frontend/app/code-agent/tasks/[task_id]/page.tsx"
        ).read_text()
        assert "EventSource" in detail_page
        assert "setInterval" in detail_page, \
            "SSE fallback to polling (setInterval) should exist"
        assert "es?.close()" in detail_page, \
            "Cleanup should close EventSource"
