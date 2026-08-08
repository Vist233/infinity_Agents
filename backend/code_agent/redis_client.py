"""Infinity Agent — Redis client for task queue and event streaming."""

from __future__ import annotations

import json
import logging
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

# Redis key/stream constants
STREAM_TASKS_EXECUTE = "stream:tasks:execute"
STREAM_TASK_EVENTS = "stream:task-events"
CONSUMER_GROUP = "task-workers-v1"

PROGRESS_KEY_PREFIX = "progress:"
WORKER_HEARTBEAT_PREFIX = "worker:"
RATE_LIMIT_PREFIX = "rate:user:"


class RedisClient:
    """Thin wrapper around redis-py for the task execution system."""

    def __init__(self, url: str) -> None:
        self._url = url
        self._client = None

    async def connect(self) -> None:
        """Initialize Redis connection."""
        try:
            import redis.asyncio as aioredis
            self._client = aioredis.from_url(
                self._url,
                decode_responses=True,
                socket_connect_timeout=5,
                socket_timeout=5,
            )
            # Test connection
            await self._client.ping()
            logger.info("Connected to Redis at %s", self._url)
        except ImportError:
            logger.warning("redis-py not installed, Redis features disabled")
            self._client = None
        except Exception as exc:
            logger.warning("Redis connection failed: %s", exc)
            self._client = None

    async def disconnect(self) -> None:
        """Close Redis connection."""
        if self._client:
            await self._client.aclose()
            self._client = None

    @property
    def is_connected(self) -> bool:
        return self._client is not None

    # ========================================================================
    # Stream Operations
    # ========================================================================

    async def ensure_consumer_group(self, stream_key: str, group_name: str) -> None:
        """Create a consumer group if it doesn't exist."""
        if not self._client:
            return
        try:
            await self._client.xgroup_create(
                stream_key, group_name, id="0", mkstream=True
            )
            logger.info("Created consumer group %s on %s", group_name, stream_key)
        except Exception as exc:
            # Group already exists
            if "BUSYGROUP" not in str(exc):
                logger.warning("Failed to create consumer group: %s", exc)

    async def publish_task(self, task_data: Dict[str, Any]) -> Optional[str]:
        """Publish a task to the execution stream.

        Returns the message ID or None if Redis is unavailable.
        """
        if not self._client:
            return None
        try:
            message_id = await self._client.xadd(
                STREAM_TASKS_EXECUTE,
                {k: json.dumps(v) if not isinstance(v, str) else v for k, v in task_data.items()},
            )
            logger.debug("Published task to stream: %s", message_id)
            return message_id
        except Exception as exc:
            logger.error("Failed to publish task to Redis: %s", exc)
            return None

    async def consume_tasks(
        self,
        consumer_name: str,
        count: int = 1,
        block_ms: int = 5000,
    ) -> List[Dict[str, Any]]:
        """Consume tasks from the execution stream.

        Returns list of {message_id, task_data, raw_data} or empty list.
        """
        if not self._client:
            return []
        try:
            messages = await self._client.xreadgroup(
                groupname=CONSUMER_GROUP,
                consumername=consumer_name,
                streams={STREAM_TASKS_EXECUTE: ">"},
                count=count,
                block=block_ms,
            )
            results = []
            for stream_name, stream_messages in messages:
                for message_id, raw_data in stream_messages:
                    task_data = {}
                    for k, v in raw_data.items():
                        try:
                            task_data[k] = json.loads(v)
                        except (json.JSONDecodeError, TypeError):
                            task_data[k] = v
                    results.append({
                        "message_id": message_id,
                        "task_data": task_data,
                        "raw_data": raw_data,
                    })
            return results
        except Exception as exc:
            logger.error("Failed to consume tasks from Redis: %s", exc)
            return []

    async def ack_message(self, message_id: str) -> bool:
        """Acknowledge a message from the execution stream."""
        if not self._client:
            return False
        try:
            await self._client.xack(STREAM_TASKS_EXECUTE, CONSUMER_GROUP, message_id)
            return True
        except Exception as exc:
            logger.error("Failed to ACK message %s: %s", message_id, exc)
            return False

    async def nack_message(self, message_id: str) -> bool:
        """Negative acknowledge a message (will be retried)."""
        if not self._client:
            return False
        try:
            # XCLAIM the message back to pending with a new ID
            await self._client.xclaim(
                STREAM_TASKS_EXECUTE,
                CONSUMER_GROUP,
                consumer_name="retry",
                min_idle_time=0,
                message_ids=[message_id],
            )
            return True
        except Exception as exc:
            logger.error("Failed to NACK message %s: %s", message_id, exc)
            return False

    async def recover_pending_messages(self, consumer_name: str, min_idle_time_ms: int = 60000) -> int:
        """Recover pending messages that have been idle longer than min_idle_time_ms.

        Uses XAUTOCLAIM (or XCLAIM with IDLE) to move stale pending messages
        back to the consumer's pending entry list so they can be reprocessed.
        Returns the number of recovered messages.
        """
        if not self._client:
            return 0
        try:
            # Try XAUTOCLAIM first (Redis 6.2+)
            try:
                result = await self._client.xautoclaim(
                    STREAM_TASKS_EXECUTE,
                    CONSUMER_GROUP,
                    consumer_name,
                    min_idle_time_ms=min_idle_time_ms,
                    start_id="0-0",
                )
                if result and len(result) > 0:
                    return len(result)
            except Exception:
                # Fallback to XCLAIM if XAUTOCLAIM is not supported
                pass

            # Fallback: use XPENDING to get stale message IDs and XCLAIM them
            pending = await self._client.xpending_range(
                STREAM_TASKS_EXECUTE,
                CONSUMER_GROUP,
                min=min_idle_time_ms,
                max="+",
                count=100,
            )
            if not pending:
                return 0
            message_ids = [entry["message_id"] for entry in pending]
            if not message_ids:
                return 0
            claimed = await self._client.xclaim(
                STREAM_TASKS_EXECUTE,
                CONSUMER_GROUP,
                consumer_name,
                min_idle_time=min_idle_time_ms,
                message_ids=message_ids,
            )
            return len(claimed) if claimed else 0
        except Exception as exc:
            logger.error("Failed to recover pending messages: %s", exc)
            return 0

    # ========================================================================
    # Event Streaming (for SSE)
    # ========================================================================

    async def publish_task_event(self, task_id: str, event: Dict[str, Any]) -> Optional[str]:
        """Publish a task event for SSE consumption."""
        if not self._client:
            return None
        try:
            event_payload = {"task_id": task_id, **event}
            message_id = await self._client.xadd(
                STREAM_TASK_EVENTS,
                {k: json.dumps(v) if not isinstance(v, str) else v for k, v in event_payload.items()},
            )
            return message_id
        except Exception as exc:
            logger.error("Failed to publish task event: %s", exc)
            return None

    async def read_task_events(
        self,
        task_id: str,
        last_event_id: Optional[str] = None,
        count: int = 50,
    ) -> List[Dict[str, Any]]:
        """Read task events for SSE (supports resume from last_event_id)."""
        if not self._client:
            return []
        try:
            if last_event_id:
                messages = await self._client.xread(
                    {STREAM_TASK_EVENTS: last_event_id},
                    count=count,
                )
            else:
                # Read from the beginning for initial load
                messages = await self._client.xread(
                    {STREAM_TASK_EVENTS: "0"},
                    count=count,
                )
            results = []
            for stream_name, stream_messages in messages:
                for message_id, raw_data in stream_messages:
                    event_data = {}
                    for k, v in raw_data.items():
                        try:
                            event_data[k] = json.loads(v)
                        except (json.JSONDecodeError, TypeError):
                            event_data[k] = v
                    event_data["_message_id"] = message_id
                    results.append(event_data)
            return results
        except Exception as exc:
            logger.error("Failed to read task events: %s", exc)
            return []

    # ========================================================================
    # Progress Cache
    # ========================================================================

    async def set_progress(self, task_id: str, progress: Dict[str, Any], ttl: int = 60) -> bool:
        """Cache task progress for fast reads."""
        if not self._client:
            return False
        try:
            key = f"{PROGRESS_KEY_PREFIX}{task_id}"
            await self._client.set(key, json.dumps(progress), ex=ttl)
            return True
        except Exception as exc:
            logger.error("Failed to set progress: %s", exc)
            return False

    async def get_progress(self, task_id: str) -> Optional[Dict[str, Any]]:
        """Get cached task progress."""
        if not self._client:
            return None
        try:
            key = f"{PROGRESS_KEY_PREFIX}{task_id}"
            data = await self._client.get(key)
            if data:
                return json.loads(data)
            return None
        except Exception as exc:
            logger.error("Failed to get progress: %s", exc)
            return None

    # ========================================================================
    # Worker Heartbeat
    # ========================================================================

    async def set_worker_heartbeat(self, worker_id: str, ttl: int = 30) -> bool:
        """Set worker heartbeat key with TTL."""
        if not self._client:
            return False
        try:
            key = f"{WORKER_HEARTBEAT_PREFIX}{worker_id}"
            await self._client.set(key, "alive", ex=ttl)
            return True
        except Exception as exc:
            logger.error("Failed to set heartbeat: %s", exc)
            return False

    async def get_worker_heartbeat(self, worker_id: str) -> Optional[str]:
        """Get worker heartbeat value."""
        if not self._client:
            return None
        try:
            key = f"{WORKER_HEARTBEAT_PREFIX}{worker_id}"
            return await self._client.get(key)
        except Exception as exc:
            logger.error("Failed to get heartbeat: %s", exc)
            return None

    async def get_alive_workers(self) -> List[str]:
        """Get list of workers with active heartbeats."""
        if not self._client:
            return []
        try:
            keys = await self._client.keys(f"{WORKER_HEARTBEAT_PREFIX}*")
            return [k.replace(WORKER_HEARTBEAT_PREFIX, "") for k in keys]
        except Exception as exc:
            logger.error("Failed to get alive workers: %s", exc)
            return []

    # ========================================================================
    # Rate Limiting
    # ========================================================================

    async def check_rate_limit(
        self, user_id: str, limit: int, window_seconds: int, action: str = "create_task"
    ) -> tuple[bool, int]:
        """Check if user is within rate limit.

        Fixed-window counter keyed by (user_id, action). Returns
        (is_allowed, remaining_count). Fails open when Redis is unavailable.
        """
        if not self._client:
            return True, limit
        try:
            key = f"{RATE_LIMIT_PREFIX}{user_id}:{action}"
            current = await self._client.get(key)
            if current is None:
                await self._client.set(key, 1, ex=window_seconds)
                return True, limit - 1
            count = int(current)
            if count >= limit:
                return False, 0
            await self._client.incr(key)
            return True, limit - count - 1
        except Exception as exc:
            logger.error("Rate limit check failed: %s", exc)
            return True, limit
