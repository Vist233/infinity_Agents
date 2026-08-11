"""Infinity Agent — Redis client for task queue and event streaming."""

from __future__ import annotations

import json
import logging
import os
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

# Redis key/stream constants. A namespace isolates acceptance runs while an
# empty value preserves the existing local-development key names.
_REDIS_NAMESPACE = os.getenv("REDIS_NAMESPACE", "").strip().strip(":")


def _scoped_key(key: str) -> str:
    return f"{_REDIS_NAMESPACE}:{key}" if _REDIS_NAMESPACE else key


STREAM_TASKS_EXECUTE = _scoped_key("stream:tasks:execute")
STREAM_TASK_EVENTS = _scoped_key("stream:task-events")
CONSUMER_GROUP = _scoped_key("task-workers-v1")

PROGRESS_KEY_PREFIX = _scoped_key("progress:")
WORKER_HEARTBEAT_PREFIX = _scoped_key("worker:")
RATE_LIMIT_PREFIX = _scoped_key("rate:user:")


class RedisClient:
    """Thin wrapper around redis-py for the task execution system."""

    def __init__(self, url: str) -> None:
        self._url = url
        self._client = None

    @property
    def namespace(self) -> str:
        """Return the process-scoped Redis key Namespace used by this client."""
        return _REDIS_NAMESPACE

    async def connect(self) -> None:
        """Initialize Redis connection."""
        from backend.security import validate_runtime_redis_url
        validate_runtime_redis_url(self._url)
        try:
            import redis.asyncio as aioredis
            self._client = aioredis.from_url(
                self._url,
                decode_responses=True,
                socket_connect_timeout=5,
                # XREADGROUP may block for block_ms=5000; keep the socket
                # timeout longer than the blocking window so an idle stream
                # is not logged as a failed consumer cycle.
                socket_timeout=max(10, int(os.getenv("REDIS_SOCKET_TIMEOUT", "15"))),
            )
            # Test connection
            await self._client.ping()
            # Never log the URL: acceptance URLs may contain a Redis password.
            logger.info("Connected to Redis")
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

    @staticmethod
    def _decode_task_messages(messages: Any) -> List[Dict[str, Any]]:
        """Normalize Redis stream tuples into the worker task shape."""
        results: List[Dict[str, Any]] = []
        for message_id, raw_data in messages or []:
            task_data: Dict[str, Any] = {}
            for key, value in (raw_data or {}).items():
                try:
                    task_data[key] = json.loads(value)
                except (json.JSONDecodeError, TypeError):
                    task_data[key] = value
            results.append({
                "message_id": message_id,
                "task_data": task_data,
                "raw_data": raw_data,
            })
        return results

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

        Compatibility wrapper for callers that only need the count. The worker
        uses ``claim_pending_tasks`` so the complete stream payload is passed
        back through the same task processing path before ACK.
        """
        return len(await self.claim_pending_tasks(consumer_name, min_idle_time_ms=min_idle_time_ms))

    async def claim_pending_tasks(
        self,
        consumer_name: str,
        min_idle_time_ms: int = 60000,
        count: int = 10,
    ) -> List[Dict[str, Any]]:
        """Claim stale pending task messages and return their full payloads.

        ``XAUTOCLAIM`` changes ownership but does not itself execute a task.
        Returning the claimed entries lets the Worker feed them through
        ``_process_next_task`` and ACK only after the normal DB claim/finish
        path has handled them. The XPENDING/XCLAIM branch keeps compatibility
        with Redis versions without XAUTOCLAIM.
        """
        if not self._client:
            return []
        try:
            # Try XAUTOCLAIM first (Redis 6.2+)
            try:
                result = await self._client.xautoclaim(
                    STREAM_TASKS_EXECUTE,
                    CONSUMER_GROUP,
                    consumer_name,
                    min_idle_time_ms=min_idle_time_ms,
                    start_id="0-0",
                    count=max(1, min(count, 100)),
                )
                if isinstance(result, (tuple, list)) and len(result) > 1:
                    # XAUTOCLAIM returns (next_start_id, messages, deleted_ids)
                    # rather than a flat message list. A valid empty result is
                    # authoritative; do not immediately rescan XPENDING.
                    return self._decode_task_messages(result[1])
            except Exception:
                # Fallback to XCLAIM if XAUTOCLAIM is not supported
                pass

            # Fallback: use XPENDING to get stale message IDs and XCLAIM them
            pending = await self._client.xpending_range(
                STREAM_TASKS_EXECUTE,
                CONSUMER_GROUP,
                min="-",
                max="+",
                count=max(1, min(count, 100)),
            )
            if not pending:
                return []
            message_ids = [entry["message_id"] for entry in pending if entry.get("message_id")]
            if not message_ids:
                return []
            claimed = await self._client.xclaim(
                STREAM_TASKS_EXECUTE,
                CONSUMER_GROUP,
                consumer_name,
                min_idle_time=min_idle_time_ms,
                message_ids=message_ids,
            )
            return self._decode_task_messages(claimed)
        except Exception as exc:
            logger.error("Failed to recover pending messages: %s", exc)
            return []

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
            results = []
            cursor = last_event_id or "0-0"
            scanned_cursor = cursor
            # The stream is shared by all tasks.  Redis Streams do not support
            # a field predicate in XREAD, so scan bounded batches and advance
            # the cursor past unrelated tasks as well.  Without this filter a
            # user subscribed to task A could receive task B's events.
            for _ in range(10):
                messages = await self._client.xread(
                    {STREAM_TASK_EVENTS: cursor},
                    count=max(1, min(count * 4, 200)),
                )
                if not messages:
                    break
                batch_count = 0
                for _stream_name, stream_messages in messages:
                    for message_id, raw_data in stream_messages:
                        batch_count += 1
                        scanned_cursor = message_id
                        event_data = {}
                        for k, v in raw_data.items():
                            try:
                                event_data[k] = json.loads(v)
                            except (json.JSONDecodeError, TypeError):
                                event_data[k] = v
                        if str(event_data.get("task_id", "")) != str(task_id):
                            continue
                        event_data["_message_id"] = message_id
                        results.append(event_data)
                        if len(results) >= count:
                            break
                    if len(results) >= count:
                        break
                if len(results) >= count or batch_count == 0:
                    break
                cursor = scanned_cursor
                # A second read is useful when the first batch consisted only
                # of another task's events.  XREAD without BLOCK returns
                # immediately when there is no newer message.
                if batch_count < max(1, min(count * 4, 200)):
                    break
            if scanned_cursor != (last_event_id or "0-0"):
                if results:
                    # Let the SSE endpoint acknowledge the whole scanned
                    # range while still emitting only matching task events.
                    results[-1]["_stream_cursor"] = scanned_cursor
                else:
                    # A cursor-only marker prevents an idle stream containing
                    # other tasks from being rescanned forever.
                    results.append({"_cursor_only": scanned_cursor})
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
            # KEYS is blocking and its cost grows with the entire Redis key
            # space.  Heartbeats are short-lived, but a busy shared Redis can
            # still contain many unrelated keys, so enumerate this prefix in
            # bounded SCAN batches and cap the result used by the health view.
            cursor = 0
            keys: List[str] = []
            while True:
                cursor, batch = await self._client.scan(
                    cursor=cursor,
                    match=f"{WORKER_HEARTBEAT_PREFIX}*",
                    count=100,
                )
                keys.extend(batch or [])
                if cursor == 0 or len(keys) >= 1000:
                    break
            return [k.replace(WORKER_HEARTBEAT_PREFIX, "", 1) for k in keys[:1000]]
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
        (is_allowed, remaining_count). Deployed-like environments return a
        negative remaining value when Redis is unavailable so callers can
        return a service-unavailable response instead of bypassing limits.
        """
        if not self._client:
            strict = os.getenv("APP_ENV", "development").lower() in {"acceptance", "production", "prod"}
            return (False, -1) if strict else (True, limit)
        try:
            key = f"{RATE_LIMIT_PREFIX}{user_id}:{action}"
            # Keep the counter increment and first-write TTL in one Redis
            # script. GET followed by SET/INCR allowed concurrent requests to
            # observe the same old value and exceed the configured limit.
            result = await self._client.eval(
                """
                local current = redis.call('INCR', KEYS[1])
                if current == 1 then
                    redis.call('EXPIRE', KEYS[1], ARGV[1])
                end
                local limit = tonumber(ARGV[2])
                local remaining = limit - current
                if remaining < 0 then remaining = 0 end
                if current > limit then return {0, remaining} end
                return {1, remaining}
                """,
                1,
                key,
                int(window_seconds),
                int(limit),
            )
            if isinstance(result, (list, tuple)) and len(result) >= 2:
                return bool(int(result[0])), int(result[1])

            # Lightweight fakes and older Redis-compatible implementations may
            # not expose EVAL. INCR is still atomic; expire immediately after
            # the first increment so the fallback preserves the fixed window.
            current = int(await self._client.incr(key))
            if current == 1 and hasattr(self._client, "expire"):
                await self._client.expire(key, window_seconds)
            return (current <= limit, max(0, limit - current))
        except Exception as exc:
            logger.error("Rate limit check failed: %s", exc)
            strict = os.getenv("APP_ENV", "development").lower() in {"acceptance", "production", "prod"}
            return (False, -1) if strict else (True, limit)
