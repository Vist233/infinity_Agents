"""Infinity Agent — Outbox Publisher.

Periodically reads pending outbox events from PostgreSQL and publishes them
to Redis Stream for Workers to consume.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Optional

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
        await self._redis.connect()
        await self._redis.ensure_consumer_group(STREAM_TASKS_EXECUTE := "stream:tasks:execute", "task-workers-v1")
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
        """Publish a batch of pending events. Returns count published."""
        from backend.code_agent.task_service import get_pending_outbox_events, mark_outbox_published, mark_outbox_failed

        events = await get_pending_outbox_events(self._pool, self._batch_size)
        published = 0

        for event in events:
            try:
                if event["event_type"] == "task_created":
                    # Publish to task execution stream
                    message_id = await self._redis.publish_task({
                        "task_id": event["payload"].get("task_id"),
                        "event_type": event["event_type"],
                        "payload": event["payload"],
                    })
                    if message_id:
                        await mark_outbox_published(self._pool, event["outbox_event_id"])
                        published += 1
                    else:
                        # Redis unavailable, skip for now
                        logger.warning("Redis unavailable, skipping outbox event %d", event["outbox_event_id"])
                else:
                    # Publish to event stream for SSE
                    task_id = event["payload"].get("task_id")
                    if task_id:
                        await self._redis.publish_task_event(task_id, {
                            "event_type": event["event_type"],
                            "data": event["payload"],
                        })
                    await mark_outbox_published(self._pool, event["outbox_event_id"])
                    published += 1
            except Exception as exc:
                logger.error("Failed to publish outbox event %d: %s", event["outbox_event_id"], exc)
                await mark_outbox_failed(self._pool, event["outbox_event_id"], str(exc))

        if published > 0:
            logger.debug("Published %d outbox events", published)

        return published
