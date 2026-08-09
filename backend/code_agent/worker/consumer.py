"""Infinity Agent — Worker consumer module.

Handles Redis Stream consumption and task dispatch.
"""

from __future__ import annotations

import asyncio
import logging
import re
from typing import Any, Dict, Optional

from backend.code_agent.redis_client import CONSUMER_GROUP, STREAM_TASKS_EXECUTE

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
    worker_namespace: Optional[str] = None,
    worker_credential: Optional[str] = None,
) -> None:
    """Run a single worker instance."""
    stop_event = asyncio.Event()
    if worker_credential:
        from backend.worker_enrollment import authenticate_worker
        if not worker_namespace or not await authenticate_worker(db_pool, worker_id, worker_namespace, worker_credential):
            raise PermissionError("Worker enrollment is invalid or revoked")
    await redis_client.ensure_consumer_group(STREAM_TASKS_EXECUTE, CONSUMER_GROUP)
    logger.info("Worker %s started, waiting for tasks...", worker_id)

    heartbeat_task = asyncio.create_task(
        _heartbeat_loop(worker_id, redis_client, heartbeat_interval, db_pool, worker_namespace, worker_credential, stop_event)
    )
    lease_task = asyncio.create_task(
        _lease_reaper_loop(worker_id, db_pool, lease_seconds)
    )

    try:
        while not stop_event.is_set():
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
    from backend.code_agent.task_service import reap_expired_lease

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
                    SELECT task_id, lease_token
                    FROM tasks
                    WHERE status IN ('claimed', 'running')
                      AND lease_expires_at < NOW()
                    LIMIT 10
                    FOR UPDATE SKIP LOCKED
                    """
                )
                # The SELECT transaction only prevents this reaper from
                # competing with another reaper.  The helper re-checks the
                # lease and performs the actual state transition atomically.
                for row in expired:
                    recovered = await reap_expired_lease(
                        db_pool,
                        str(row["task_id"]),
                        row["lease_token"],
                        now=now,
                    )
                    if recovered:
                        logger.info(
                            "Reaper reclaimed task %s → %s",
                            row["task_id"],
                            recovered["status"],
                        )
        except Exception as exc:
            logger.warning("Lease reaper error: %s", exc)
        await asyncio.sleep(10)


async def _heartbeat_loop(worker_id: str, redis_client, interval: int, db_pool=None, namespace: Optional[str] = None, credential: Optional[str] = None, stop_event: Optional[asyncio.Event] = None) -> None:
    """Periodically update worker heartbeat."""
    while True:
        try:
            if credential:
                from backend.worker_enrollment import authenticate_worker
                if not namespace or not await authenticate_worker(db_pool, worker_id, namespace, credential):
                    logger.error("Worker %s enrollment was revoked; stopping heartbeat", worker_id)
                    if stop_event:
                        stop_event.set()
                    return
            await redis_client.set_worker_heartbeat(worker_id, ttl=interval + 10)
        except Exception:
            pass
        await asyncio.sleep(interval)


async def _fail_or_requeue(
    db_pool,
    worker_id: str,
    task_id: str,
    claimed: Dict[str, Any],
    *,
    failure_code: Optional[str],
    error_message: str,
) -> None:
    """Failure classification (design doc §35).

    Retryable failures are requeued with exponential backoff until
    max_attempts is reached; everything else terminates as 'failed'.
    """
    from backend.code_agent.retry_policy import is_retryable, next_attempt_at
    from backend.code_agent.task_service import requeue_task, update_task_status
    from backend.code_agent.models import TaskStatus

    if (
        is_retryable(failure_code)
        and claimed["attempt_index"] < claimed["max_attempts"]
    ):
        next_at = next_attempt_at(claimed["attempt_index"])
        requeued = await requeue_task(
            db_pool, task_id, claimed["lease_token"], next_at, error_message
        )
        if requeued:
            logger.info(
                "Worker %s requeued task %s for attempt %d at %s",
                worker_id, task_id, claimed["attempt_index"] + 1, next_at.isoformat(),
            )
            return
    await update_task_status(
        db_pool, task_id,
        TaskStatus.FAILED,
        lease_token=claimed["lease_token"],
        error_message=error_message,
    )


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
            updated = await update_task_status(
                db_pool, task_id,
                TaskStatus.CANCELLED,
                lease_token=claimed["lease_token"],
                error_message=result.get("error", "Task cancelled by user"),
            )
            if updated:
                logger.info("Worker %s cancelled task %s", worker_id, task_id)
            else:
                logger.warning("Worker %s lost lease before cancelling task %s", worker_id, task_id)
        elif result.get("success"):
            from backend.code_agent.models import TaskStatus
            updated = await update_task_status(
                db_pool, task_id,
                TaskStatus.SUCCEEDED,
                lease_token=claimed["lease_token"],
                result_artifact_id=result.get("artifact_id"),
            )
            if updated:
                logger.info("Worker %s succeeded task %s", worker_id, task_id)
            else:
                logger.warning("Worker %s lost lease before publishing success for task %s", worker_id, task_id)
        else:
            await _fail_or_requeue(
                db_pool, worker_id, task_id, claimed,
                failure_code=result.get("failure_code"),
                error_message=result.get("error", "Unknown error"),
            )
    except Exception as exc:
        logger.error("Worker %s error for task %s: %s", worker_id, task_id, exc)
        # Unexpected worker-side errors (Redis/DB hiccups etc.) are transient
        # infrastructure failures — classify them as retryable (design doc §35)
        # instead of terminating the task immediately.
        try:
            await _fail_or_requeue(
                db_pool, worker_id, task_id, claimed,
                failure_code="infrastructure_error",
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
    namespace = os.getenv("REDIS_NAMESPACE", "default")

    pool = await asyncpg.create_pool(database_url, min_size=1, max_size=5)
    redis_client = RedisClient(redis_url)
    await redis_client.connect()
    if not redis_client.is_connected:
        logger.warning("Redis unavailable; worker will rely on DB polling fallback")

    try:
        credential = os.getenv("WORKER_CREDENTIAL")
        if os.getenv("WORKER_ENROLLMENT_REQUIRED", "0").lower() in {"1", "true", "yes"}:
            from backend.worker_enrollment import complete_enrollment
            token = os.getenv("WORKER_ENROLLMENT_TOKEN")
            if token:
                credential = await complete_enrollment(pool, worker_id, namespace, token)
            if not credential:
                raise SystemExit("WORKER_CREDENTIAL or one-time WORKER_ENROLLMENT_TOKEN is required")
        await run_worker(
            worker_id, pool, redis_client, docker_image=docker_image,
            worker_namespace=namespace if credential else None,
            worker_credential=credential,
        )
    finally:
        await redis_client.disconnect()
        await pool.close()


if __name__ == "__main__":
    import sys

    worker_arg = sys.argv[1] if len(sys.argv) > 1 else "worker-default"
    asyncio.run(_main(worker_arg))
