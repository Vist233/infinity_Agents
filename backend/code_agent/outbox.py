"""Infinity Agent — Outbox Publisher.

Periodically reads pending outbox events from PostgreSQL and publishes them
to Redis Stream for Workers to consume.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Optional

from backend.code_agent.redis_client import CONSUMER_GROUP, STREAM_TASKS_EXECUTE

logger = logging.getLogger(__name__)


class OutboxPublisher:
    """Polls pending outbox events and publishes to Redis Stream."""

    def __init__(
        self,
        db_pool,
        redis_client,
        poll_interval: float = 1.0,
        batch_size: int = 50,
    ) -> None:
        self._pool = db_pool
        self._redis = redis_client
        self._poll_interval = poll_interval
        self._batch_size = batch_size
        self._running = False
        self._task: Optional[asyncio.Task] = None

    async def start(self) -> None:
        """Start the publisher loop."""
        if self._running:
            return
        self._running = True
        if not self._redis.is_connected:
            await self._redis.connect()
        await self._redis.ensure_consumer_group(STREAM_TASKS_EXECUTE, CONSUMER_GROUP)
        self._task = asyncio.create_task(self._publish_loop())
        logger.info("Outbox Publisher started")

    async def stop(self) -> None:
        """Stop the publisher loop."""
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        await self._redis.disconnect()
        logger.info("Outbox Publisher stopped")

    async def _publish_loop(self) -> None:
        """Main publish loop."""
        while self._running:
            try:
                await self._publish_batch()
            except asyncio.CancelledError:
                break
            except Exception as exc:
                logger.error("Outbox publish error: %s", exc)
            await asyncio.sleep(self._poll_interval)

    async def _publish_batch(self) -> int:
        """Publish one batch under the dedicated outbox RLS context."""
        from backend.db_rls import rls_service_context

        with rls_service_context("outbox"):
            return await self._publish_batch_unscoped()

    async def _publish_batch_unscoped(self) -> int:
        """Publish a batch of pending events. Returns count published."""
        from backend.code_agent.task_service import (
            get_pending_outbox_events,
            mark_outbox_published,
            mark_outbox_failed,
            release_outbox_event,
        )

        events = await get_pending_outbox_events(self._pool, self._batch_size)
        published = 0

        for event in events:
            try:
                if event["event_type"] in ("task_created", "task_queued"):
                    # Publish to task execution stream (covers both first-run
                    # and requeued retries).
                    message_id = await self._redis.publish_task({
                        "task_id": event["payload"].get("task_id"),
                        "event_type": event["event_type"],
                        "payload": event["payload"],
                    })
                    if message_id:
                        await mark_outbox_published(self._pool, event["outbox_event_id"], event["claim_token"])
                        published += 1
                    else:
                        # Redis unavailable, skip for now
                        logger.warning("Redis unavailable, skipping outbox event %d", event["outbox_event_id"])
                        await release_outbox_event(self._pool, event["outbox_event_id"], event["claim_token"], "Redis unavailable")
                else:
                    # Publish to event stream for SSE.
                    task_id = event["payload"].get("task_id")
                    message_id = None
                    if task_id:
                        payload = event["payload"]
                        message_id = await self._redis.publish_task_event(task_id, {
                            "event_type": event["event_type"],
                            "data": payload,
                            # Carry the durable PostgreSQL event ID alongside
                            # the Redis cursor so an SSE reconnect can bridge
                            # to DB polling if Redis is temporarily down.
                            "task_event_id": payload.get("task_event_id"),
                        })
                    if message_id is None:
                        # Redis unavailable — keep pending so the next pass
                        # retries (mirrors the task-stream branch).
                        logger.warning("Redis unavailable, skipping SSE outbox event %d", event["outbox_event_id"])
                        await release_outbox_event(self._pool, event["outbox_event_id"], event["claim_token"], "Redis unavailable")
                        continue
                    await mark_outbox_published(self._pool, event["outbox_event_id"], event["claim_token"])
                    published += 1
            except Exception as exc:
                logger.error("Failed to publish outbox event %d: %s", event["outbox_event_id"], exc)
                await mark_outbox_failed(self._pool, event["outbox_event_id"], event["claim_token"], str(exc))

        if published > 0:
            logger.debug("Published %d outbox events", published)

        return published


async def _main() -> None:
    """CLI entry: run the Outbox Publisher as a standalone process."""
    import os

    import asyncpg

    from backend.code_agent.redis_client import RedisClient

    logging.basicConfig(level=logging.INFO)

    database_url = os.getenv("DATABASE_URL")
    if not database_url:
        raise SystemExit("DATABASE_URL is required")
    redis_url = os.getenv("REDIS_URL", "redis://localhost:6379/0")
    from backend.security import validate_runtime_database_url
    validate_runtime_database_url(database_url)

    raw_pool = await asyncpg.create_pool(database_url, min_size=1, max_size=5)
    from backend.db_rls import rls_enabled_from_env, wrap_runtime_pool
    pool = wrap_runtime_pool(raw_pool) if rls_enabled_from_env() else raw_pool
    redis_client = RedisClient(redis_url)
    publisher = OutboxPublisher(pool, redis_client, poll_interval=1.0)
    await publisher.start()
    try:
        while True:
            await asyncio.sleep(1)
    except (KeyboardInterrupt, asyncio.CancelledError):
        pass
    finally:
        await publisher.stop()
        await pool.close()


if __name__ == "__main__":
    asyncio.run(_main())
