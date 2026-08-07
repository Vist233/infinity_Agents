"""Infinity Agent — Worker consumer module.

Handles Redis Stream consumption and task dispatch.
"""

from __future__ import annotations

import asyncio
import logging
import re
from typing import Any

logger = logging.getLogger(__name__)

# Maximum length for error messages stored in DB
_MAX_ERROR_LENGTH = 500

# Patterns to redact from error messages
_SENSITIVE_PATTERNS = [
    re.compile(r"/[\w/]+\.py:\d+"),  # File paths with line numbers
    re.compile(r"File \"[^\"]+\""),  # File references
    re.compile(r"Traceback[^\n]*"),  # Traceback headers
    re.compile(r"(postgresql://|mysql://|mongodb://)[^\s]+"),  # DB connection strings
    re.compile(r"(password|passwd|secret|token|key)\s*[=:]\s*\S+", re.IGNORECASE),  # Credentials
]


def _sanitize_error(error: str) -> str:
    """Sanitize error message for safe storage in database."""
    result = str(error)
    for pattern in _SENSITIVE_PATTERNS:
        result = pattern.sub("[redacted]", result)
    if len(result) > _MAX_ERROR_LENGTH:
        result = result[:_MAX_ERROR_LENGTH] + "...(truncated)"
    return result


async def run_worker(
    worker_id: str,
    db_pool,
    redis_client,
    docker_image: str = "claude-code-env:v2",
    *,
    poll_interval: float = 1.0,
    lease_seconds: int = 60,
    heartbeat_interval: int = 15,
) -> None:
    """Run a single worker instance."""
    await redis_client.ensure_consumer_group("stream:tasks:execute", "task-workers-v1")
    logger.info("Worker %s started, waiting for tasks...", worker_id)

    heartbeat_task = asyncio.create_task(
        _heartbeat_loop(worker_id, redis_client, heartbeat_interval)
    )
    lease_task = asyncio.create_task(
        _lease_reaper_loop(worker_id, db_pool, lease_seconds)
    )

    try:
        while True:
            try:
                await _process_next_task(
                    worker_id, db_pool, redis_client, docker_image, lease_seconds
                )
            except asyncio.CancelledError:
                break
            except Exception as exc:
                logger.error("Worker %s error: %s", worker_id, exc)
                await asyncio.sleep(poll_interval)
    finally:
        heartbeat_task.cancel()
        lease_task.cancel()
        try:
            await heartbeat_task
        except asyncio.CancelledError:
            pass
        try:
            await lease_task
        except asyncio.CancelledError:
            pass
        logger.info("Worker %s stopped", worker_id)


async def _lease_reaper_loop(worker_id: str, db_pool, lease_seconds: int) -> None:
    """Renew own leases and reap expired leases from other workers."""
    from datetime import timedelta, timezone
    from datetime import datetime as dt
    from backend.code_agent.retry_policy import calculate_retry_delay
    from backend.code_agent.task_service import create_outbox_event

    while True:
        try:
            now = dt.now(timezone.utc)
            new_expiry = now + timedelta(seconds=lease_seconds)

            # Renew own leases
            async with db_pool.acquire() as conn:
                rows = await conn.fetch(
                    """
                    SELECT task_id, lease_token
                    FROM tasks
                    WHERE lease_owner = $1
                      AND status IN ('claimed', 'running')
                      AND lease_expires_at < NOW() + INTERVAL '15 seconds'
                    FOR UPDATE SKIP LOCKED
                    """,
                    worker_id,
                )
                for row in rows:
                    await conn.execute(
                        """
                        UPDATE tasks SET lease_expires_at = $3, updated_at = NOW()
                        WHERE task_id = $1::uuid AND lease_token = $2
                        """,
                        str(row["task_id"]), row["lease_token"], new_expiry,
                    )

            # Reap expired leases from dead workers
            async with db_pool.acquire() as conn:
                expired = await conn.fetch(
                    """
                    SELECT task_id, attempt_count
                    FROM tasks
                    WHERE status IN ('claimed', 'running')
                      AND lease_expires_at < NOW()
                    LIMIT 10
                    FOR UPDATE SKIP LOCKED
                    """
                )
                for row in expired:
                    if row["attempt_count"] < 3:
                        delay = calculate_retry_delay(row["attempt_count"])
                        next_attempt = now + delay
                        await conn.execute(
                            """
                            UPDATE tasks
                            SET status = 'queued', lease_owner = NULL, lease_token = NULL,
                                lease_expires_at = NULL, next_attempt_at = $2, updated_at = NOW()
                            WHERE task_id = $1::uuid
                            """,
                            str(row["task_id"]), next_attempt,
                        )
                        await create_outbox_event(
                            db_pool,
                            aggregate_type="task",
                            aggregate_id=str(row["task_id"]),
                            event_type="task_queued",
                            payload={"task_id": str(row["task_id"]), "status": "queued"},
                        )
                        logger.info("Reaper reclaimed task %s → queued (next_attempt_at=%s)", row["task_id"], next_attempt)
                    else:
                        await conn.execute(
                            """
                            UPDATE tasks
                            SET status = 'failed', lease_owner = NULL, lease_token = NULL,
                                lease_expires_at = NULL, updated_at = NOW()
                            WHERE task_id = $1::uuid
                            """,
                            str(row["task_id"]),
                        )
                        logger.info("Reaper reclaimed task %s → failed", row["task_id"])
        except Exception as exc:
            logger.warning("Lease reaper error: %s", exc)
        await asyncio.sleep(10)


async def _heartbeat_loop(worker_id: str, redis_client, interval: int) -> None:
    """Periodically update worker heartbeat."""
    while True:
        try:
            await redis_client.set_worker_heartbeat(worker_id, ttl=interval + 10)
        except Exception:
            pass
        await asyncio.sleep(interval)


async def _process_next_task(
    worker_id: str,
    db_pool,
    redis_client,
    docker_image: str,
    lease_seconds: int,
) -> None:
    """Consume and process a single task from Redis Stream."""
    from backend.code_agent.worker.executor import execute_task
    from backend.code_agent.task_service import try_claim_task, update_task_status, get_task, TaskStatus

    messages = await redis_client.consume_tasks(worker_id, count=1, block_ms=5000)
    if not messages:
        return

    msg = messages[0]
    message_id = msg["message_id"]
    task_data = msg["task_data"]
    task_id = task_data.get("task_id")

    if not task_id:
        await redis_client.ack_message(message_id)
        return

    logger.info("Worker %s received task %s", worker_id, task_id)

    claimed = await try_claim_task(db_pool, task_id, worker_id, lease_seconds)
    if not claimed:
        await redis_client.ack_message(message_id)
        return

    logger.info("Worker %s claimed task %s (attempt %d)", worker_id, task_id, claimed["attempt_index"])

    cancel_event = asyncio.Event()

    async def _poll_for_cancellation():
        while not cancel_event.is_set():
            await asyncio.sleep(1.0)
            task = await get_task(db_pool, task_id)
            if task and task.get("cancel_requested_at"):
                logger.info("Worker %s detected cancellation request for task %s", worker_id, task_id)
                cancel_event.set()
                return

    poll_task = asyncio.create_task(_poll_for_cancellation())

    try:
        result = await execute_task(
            task_id=task_id,
            attempt_id=claimed["attempt_id"],
            task_spec_id=claimed["task_spec_id"],
            dataset_snapshot_id=claimed["dataset_snapshot_id"],
            worker_id=worker_id,
            lease_token=claimed["lease_token"],
            docker_image=docker_image,
            db_pool=db_pool,
            redis_client=redis_client,
            method_source_id=claimed.get("method_source_id"),
            cancel_event=cancel_event,
        )

        if result.get("cancelled"):
            await update_task_status(
                db_pool, task_id,
                TaskStatus.CANCELLED,
                lease_token=claimed["lease_token"],
                error_message=result.get("error", "Task cancelled by user"),
            )
            logger.info("Worker %s cancelled task %s", worker_id, task_id)
        elif result.get("success"):
            await update_task_status(
                db_pool, task_id,
                "succeeded",
                lease_token=claimed["lease_token"],
                result_artifact_id=result.get("artifact_id"),
            )
            logger.info("Worker %s succeeded task %s", worker_id, task_id)
        else:
            # Failure classification (design doc §35): retryable failures are
            # requeued with exponential backoff until max_attempts is reached.
            from backend.code_agent.retry_policy import is_retryable, next_attempt_at
            from backend.code_agent.task_service import requeue_task

            failure_code = result.get("failure_code")
            error_message = result.get("error", "Unknown error")
            retried = False
            if (
                is_retryable(failure_code)
                and claimed["attempt_index"] < claimed["max_attempts"]
            ):
                next_at = next_attempt_at(claimed["attempt_index"])
                requeued = await requeue_task(
                    db_pool, task_id, claimed["lease_token"], next_at, error_message
                )
                if requeued:
                    retried = True
                    logger.info(
                        "Worker %s requeued task %s for attempt %d at %s",
                        worker_id, task_id, claimed["attempt_index"] + 1, next_at.isoformat(),
                    )
            if not retried:
                await update_task_status(
                    db_pool, task_id,
                    "failed",
                    lease_token=claimed["lease_token"],
                    error_message=error_message,
                )
    except Exception as exc:
        logger.error("Worker %s error for task %s: %s", worker_id, task_id, exc)
        try:
            await update_task_status(
                db_pool, task_id,
                "failed",
                lease_token=claimed["lease_token"],
                error_message=_sanitize_error(str(exc)),
            )
        except Exception:
            pass
    finally:
        poll_task.cancel()
        try:
            await poll_task
        except asyncio.CancelledError:
            pass
        await redis_client.ack_message(message_id)


async def _main(worker_id: str) -> None:
    """CLI entry: connect to PostgreSQL + Redis and run the worker loop."""
    import os

    import asyncpg

    from backend.code_agent.redis_client import RedisClient

    logging.basicConfig(level=logging.INFO)

    database_url = os.getenv("DATABASE_URL")
    if not database_url:
        raise SystemExit("DATABASE_URL is required")
    redis_url = os.getenv("REDIS_URL", "redis://localhost:6379/0")
    docker_image = os.getenv("CODE_AGENT_DOCKER_IMAGE", "claude-code-env:v2")

    pool = await asyncpg.create_pool(database_url, min_size=1, max_size=5)
    redis_client = RedisClient(redis_url)
    await redis_client.connect()
    if not redis_client.is_connected:
        logger.warning("Redis unavailable; worker will rely on DB polling fallback")

    try:
        await run_worker(worker_id, pool, redis_client, docker_image=docker_image)
    finally:
        await redis_client.disconnect()
        await pool.close()


if __name__ == "__main__":
    import sys

    worker_arg = sys.argv[1] if len(sys.argv) > 1 else "worker-default"
    asyncio.run(_main(worker_arg))
