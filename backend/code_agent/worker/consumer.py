"""Infinity Agent — Worker consumer module.

Handles Redis Stream consumption and task dispatch.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import time
from functools import wraps
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


def _with_worker_rls_context(func):
    """Bind the Worker identity for every DB checkout in its task tree."""
    from backend.db_rls import reset_rls_context, set_rls_worker

    @wraps(func)
    async def wrapped(worker_id: str, *args, **kwargs):
        token = set_rls_worker(
            worker_id,
            kwargs.get("worker_credential"),
            kwargs.get("worker_namespace"),
        )
        try:
            return await func(worker_id, *args, **kwargs)
        finally:
            reset_rls_context(token)

    return wrapped


def _sanitize_error(error: str) -> str:
    """Sanitize error message for safe storage in database."""
    result = str(error)
    for pattern in _SENSITIVE_PATTERNS:
        result = pattern.sub("[redacted]", result)
    if len(result) > _MAX_ERROR_LENGTH:
        result = result[:_MAX_ERROR_LENGTH] + "...(truncated)"
    return result


@_with_worker_rls_context
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
    control_plane_url: Optional[str] = None,
) -> None:
    """Run a single worker instance."""
    stop_event = asyncio.Event()
    lease_renew_task = None
    lease_task = None
    if worker_credential:
        from backend.worker_enrollment import authenticate_worker_identity
        if not worker_namespace or not str(worker_namespace).strip():
            raise PermissionError("Worker Namespace is required for persistent enrollment")
        identity = (
            await authenticate_worker_identity(db_pool, worker_id, worker_namespace, worker_credential)
            if worker_namespace else None
        )
        if identity is None:
            raise PermissionError("Worker enrollment is invalid or revoked")
        redis_namespace = str(getattr(redis_client, "namespace", "") or "").strip().strip(":")
        if not redis_namespace or redis_namespace != identity.namespace:
            raise PermissionError("Worker Redis Namespace does not match its enrollment")
        # The database enrollment is authoritative.  Do not continue using a
        # caller-provided Namespace after the handshake; all subsequent
        # heartbeat, claim, and input operations use the stored binding.
        worker_namespace = identity.namespace
        logger.info(
            "Worker %s authenticated with server-assigned trust level %s",
            worker_id,
            identity.trust_level,
        )
    await redis_client.ensure_consumer_group(STREAM_TASKS_EXECUTE, CONSUMER_GROUP)
    logger.info("Worker %s started, waiting for tasks...", worker_id)

    heartbeat_task = asyncio.create_task(
        _heartbeat_loop(worker_id, redis_client, heartbeat_interval, db_pool, worker_namespace, worker_credential, stop_event)
    )
    # Lease renewal is part of the data-plane Worker itself.  The dedicated
    # reaper only recovers leases owned by dead Workers; disabling that service
    # must never disable renewal for a healthy Worker running a long task.
    lease_renew_task = asyncio.create_task(
        _lease_renew_loop(worker_id, db_pool, lease_seconds, stop_event)
    )
    # Lease recovery is a dedicated service. Keep the old loop as an explicit
    # compatibility hook for focused unit tests/local experiments, but never
    # enable it by default or in a normal data-plane Worker.
    if os.getenv("ENABLE_LEASE_REAPER", "0").strip().lower() not in {"0", "false", "no", "off"}:
        lease_task = asyncio.create_task(
            _lease_reaper_loop(worker_id, db_pool, lease_seconds)
        )

    try:
        pending_recovery_at = 0.0
        pending_recovery_interval = max(5.0, min(float(lease_seconds), 30.0))
        while not stop_event.is_set():
            try:
                if not redis_client.is_connected:
                    # Redis is the durable dispatch boundary. There is no
                    # unauthenticated SQL enumeration fallback; reconnect
                    # instead and leave queued work untouched in the outbox.
                    await redis_client.connect()
                    if redis_client.is_connected:
                        await redis_client.ensure_consumer_group(STREAM_TASKS_EXECUTE, CONSUMER_GROUP)
                    else:
                        await asyncio.sleep(max(poll_interval, 5.0))
                        continue
                pending_messages = None
                claim_pending_tasks = getattr(redis_client, "claim_pending_tasks", None)
                now = time.monotonic()
                if callable(claim_pending_tasks) and now >= pending_recovery_at:
                    pending_messages = await claim_pending_tasks(
                        worker_id,
                        min_idle_time_ms=max(60000, int(lease_seconds * 1000)),
                        count=1,
                    )
                    pending_recovery_at = now + pending_recovery_interval
                    if pending_messages:
                        logger.info(
                            "Worker %s reclaimed %d stale pending task message(s)",
                            worker_id,
                            len(pending_messages),
                        )
                await _process_next_task(
                    worker_id, db_pool, redis_client, docker_image, lease_seconds,
                    worker_namespace=worker_namespace,
                    worker_credential=worker_credential,
                    control_plane_url=control_plane_url,
                    messages=pending_messages or None,
                )
            except asyncio.CancelledError:
                break
            except Exception as exc:
                logger.error("Worker %s error: %s", worker_id, exc)
                await asyncio.sleep(poll_interval)
    finally:
        heartbeat_task.cancel()
        if lease_renew_task is not None:
            lease_renew_task.cancel()
        if lease_task is not None:
            lease_task.cancel()
        try:
            await heartbeat_task
        except asyncio.CancelledError:
            pass
        if lease_renew_task is not None:
            try:
                await lease_renew_task
            except asyncio.CancelledError:
                pass
        if lease_task is not None:
            try:
                await lease_task
            except asyncio.CancelledError:
                pass
        logger.info("Worker %s stopped", worker_id)


async def _lease_renew_loop(
    worker_id: str,
    db_pool,
    lease_seconds: int,
    stop_event: Optional[asyncio.Event] = None,
) -> None:
    """Renew active leases owned by this Worker until it stops.

    This loop intentionally does not enumerate tasks or touch another
    Worker's rows.  The owner/active-attempt predicates are also enforced by
    the database RLS policy, so a stale Worker cannot extend a lease after it
    has expired or been transferred.
    """
    from datetime import datetime, timedelta, timezone

    stop_event = stop_event or asyncio.Event()
    interval = max(1.0, min(float(lease_seconds) / 3.0, 10.0))
    while not stop_event.is_set():
        try:
            new_expiry = datetime.now(timezone.utc) + timedelta(seconds=lease_seconds)
            async with db_pool.acquire() as conn:
                await conn.execute(
                    """
                    UPDATE tasks
                    SET lease_expires_at = $2, updated_at = NOW()
                    WHERE lease_owner = $1
                      AND status IN ('claimed', 'running')
                      AND lease_token IS NOT NULL
                      AND active_attempt_id IS NOT NULL
                      AND lease_expires_at > NOW()
                      AND EXISTS (
                          SELECT 1
                          FROM task_attempts a
                          WHERE a.task_attempt_id = tasks.active_attempt_id
                            AND a.task_id = tasks.task_id
                            AND a.worker_id = $1
                            AND a.status = 'running'
                      )
                    """,
                    worker_id,
                    new_expiry,
                )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            # A transient renewal failure is observable and will be handled by
            # the central Reaper if the Worker cannot recover before expiry.
            logger.warning("Worker %s lease renewal failed: %s", worker_id, exc)
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=interval)
        except asyncio.TimeoutError:
            pass


async def _lease_reaper_loop(worker_id: str, db_pool, lease_seconds: int) -> None:
    """Renew own leases and reap expired leases from other workers."""
    from datetime import timedelta, timezone
    from datetime import datetime as dt
    from backend.code_agent.task_service import reap_expired_lease
    from backend.db_rls import rls_reaper_context

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
                      AND EXISTS (
                          SELECT 1
                          FROM task_attempts a
                          WHERE a.task_attempt_id = tasks.active_attempt_id
                            AND a.task_id = tasks.task_id
                            AND a.worker_id = $1
                            AND a.status = 'running'
                      )
                    FOR UPDATE SKIP LOCKED
                    """,
                    worker_id,
                )
                for row in rows:
                    await conn.execute(
                        """
                    UPDATE tasks SET lease_expires_at = $3, updated_at = NOW()
                        WHERE task_id = $1::uuid AND lease_token = $2
                          AND lease_expires_at > NOW()
                        """,
                        str(row["task_id"]), row["lease_token"], new_expiry,
                    )

            # Reap expired leases from dead workers under a separate, narrow
            # service role. A Worker identity must never see or mutate another
            # Worker's expired task just because it runs the reaper loop.
            with rls_reaper_context():
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
    terminal_status = TaskStatus.TIMEOUT if failure_code == "timeout" else TaskStatus.FAILED
    await update_task_status(
        db_pool, task_id,
        terminal_status,
        lease_token=claimed["lease_token"],
        error_message=error_message,
    )


async def _process_next_task(
    worker_id: str,
    db_pool,
    redis_client,
    docker_image: str,
    lease_seconds: int,
    *,
    worker_namespace: Optional[str] = None,
    worker_credential: Optional[str] = None,
    control_plane_url: Optional[str] = None,
    messages: Optional[list[Dict[str, Any]]] = None,
) -> None:
    """Consume and process a single task from Redis Stream."""
    from backend.code_agent.worker.executor import execute_task
    from backend.code_agent.task_service import try_claim_task, update_task_status, get_task, TaskStatus

    if messages is None:
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

    # A Redis redelivery can arrive after another Worker already finalized the
    # task.  Avoid entering the claim transaction for an obviously terminal
    # or missing row; the database CAS remains the final race-safe guard.
    existing_task = await get_task(db_pool, task_id)
    if existing_task is None:
        # RLS deliberately hides tasks owned by another user.  Treating that
        # indistinguishably from a deleted task and ACKing here would lose the
        # message before an authorized Worker can reclaim it.  The control
        # plane/reaper can handle genuinely orphaned stream entries; a data
        # plane Worker must fail closed and leave this entry pending.
        logger.info(
            "Worker %s cannot read task %s; leaving message pending",
            worker_id,
            task_id,
        )
        return
    if existing_task.get("status") != "queued":
        await redis_client.ack_message(message_id)
        return

    claimed = await try_claim_task(
        db_pool,
        task_id,
        worker_id,
        lease_seconds,
        worker_namespace=worker_namespace,
    )
    if not claimed:
        # A queued task may be visible in a shared Redis stream before the
        # database-side owner/trust check rejects this Worker. Never ACK that
        # message: another authorized Worker must be able to reclaim it after
        # the pending-entry idle timeout.
        logger.info("Worker %s could not claim task %s; leaving message pending", worker_id, task_id)
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
            worker_namespace=worker_namespace,
            worker_credential=worker_credential,
            control_plane_url=control_plane_url,
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
    from backend.security import validate_runtime_database_url
    validate_runtime_database_url(database_url)
    redis_url = os.getenv("REDIS_URL", "redis://localhost:6379/0")
    docker_image = os.getenv("CODE_AGENT_DOCKER_IMAGE", "claude-code-env:v2")
    namespace = os.getenv("REDIS_NAMESPACE", "").strip().strip(":")
    control_plane_url = os.getenv("WORKER_CONTROL_PLANE_URL") or os.getenv("CONTROL_PLANE_URL")

    raw_pool = await asyncpg.create_pool(database_url, min_size=1, max_size=5)
    from backend.db_rls import rls_enabled_from_env, wrap_runtime_pool
    pool = wrap_runtime_pool(raw_pool) if rls_enabled_from_env() else raw_pool
    redis_client = RedisClient(redis_url)
    await redis_client.connect()
    if not redis_client.is_connected:
        logger.warning("Redis unavailable; Worker will retry the central Redis connection")

    try:
        credential = os.getenv("WORKER_CREDENTIAL")
        if os.getenv("WORKER_ENROLLMENT_REQUIRED", "0").lower() in {"1", "true", "yes"}:
            if not credential:
                raise SystemExit("WORKER_CREDENTIAL is required")
        if credential and not namespace:
            raise SystemExit("REDIS_NAMESPACE is required for a credentialed Worker")
        # The Worker keeps its authenticated DB/Redis objects in memory and
        # passes only explicit Claude settings to the child process. Remove
        # control-plane secrets from this process environment too, otherwise
        # a root process could recover them through /proc/1/environ.
        for secret_name in (
            "DATABASE_URL",
            "REDIS_URL",
            "WORKER_CREDENTIAL",
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_AUTH_TOKEN",
            "ANTHROPIC_BASE_URL",
            "ANTHROPIC_MODEL",
            "CODING_PROVIDER_API_KEY",
            "TASK_API_TOKEN",
            "SESSION_COOKIE_SECRET",
            "SECRET_STORE_KEK",
            "OIDC_CLIENT_SECRET",
        ):
            os.environ.pop(secret_name, None)
        await run_worker(
            worker_id, pool, redis_client, docker_image=docker_image,
            worker_namespace=namespace if credential else None,
            worker_credential=credential,
            control_plane_url=control_plane_url,
        )
    finally:
        await redis_client.disconnect()
        await pool.close()


if __name__ == "__main__":
    import sys

    worker_arg = sys.argv[1] if len(sys.argv) > 1 else "worker-default"
    asyncio.run(_main(worker_arg))
