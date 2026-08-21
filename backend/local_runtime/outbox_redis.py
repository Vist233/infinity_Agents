"""Local Redis coordination: outbox publisher plus a hint stream reader.

PostgreSQL remains the only source of truth. Redis stores only rebuildable
wake-up hints (a capped stream); it never receives credentials, lease tokens,
input bytes or user content. Workers keep polling PostgreSQL when Redis is
down, and the publisher replays the durable outbox idempotently once Redis
recovers.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import secrets
import uuid
from typing import Any

import asyncpg
import redis.asyncio as aioredis


logger = logging.getLogger(__name__)

HINT_STREAM_KEY = "infinity:local:hints"
HINT_STREAM_MAXLEN = 1000
MAX_ATTEMPTS = 20
BACKOFF_CAP_SECONDS = 300
CLAIM_LEASE_SECONDS = 30


def redis_url_from_env() -> str | None:
    url = os.getenv("LOCAL_REDIS_URL", "").strip()
    return url or None


class LocalOutboxPublisher:
    """Claims pending outbox events and republishes them as Redis hints."""

    def __init__(self, pool: asyncpg.Pool, redis_url: str, *, batch_size: int = 50, poll_interval: float = 1.0) -> None:
        self.pool = pool
        self.redis_url = redis_url
        self.batch_size = batch_size
        self.poll_interval = poll_interval
        self.owner = secrets.token_urlsafe(12)
        self._redis: aioredis.Redis | None = None
        self._running = False
        self._task: asyncio.Task[None] | None = None

    async def redis(self) -> aioredis.Redis:
        if self._redis is None:
            self._redis = aioredis.from_url(self.redis_url, decode_responses=True)
        return self._redis

    async def close(self) -> None:
        if self._redis is not None:
            await self._redis.aclose()
            self._redis = None

    async def start(self) -> None:
        if self._running:
            return
        self._running = True
        self._task = asyncio.create_task(self._loop())

    async def stop(self) -> None:
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        await self.close()

    async def _loop(self) -> None:
        while self._running:
            try:
                await self.publish_batch()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # Redis outage: back off and retry
                logger.warning("Local outbox publish pass failed: %s", exc)
            await asyncio.sleep(self.poll_interval)

    async def claim_batch(self, limit: int | None = None) -> list[asyncpg.Record]:
        """Claim pending events whose retry time has arrived (skip locked)."""
        async with self.pool.acquire() as connection:
            async with connection.transaction():
                rows = await connection.fetch(
                    """
                    SELECT event_id
                    FROM infinity_runtime.outbox_events
                    WHERE status = 'pending' AND next_attempt_at <= NOW()
                    ORDER BY next_attempt_at, created_at
                    LIMIT $1
                    FOR UPDATE SKIP LOCKED
                    """,
                    limit or self.batch_size,
                )
                if not rows:
                    return []
                return await connection.fetch(
                    """
                    UPDATE infinity_runtime.outbox_events
                    SET status = 'publishing', publishing_owner = $2,
                        publishing_expires_at = NOW() + make_interval(secs => $3)
                    WHERE event_id = ANY($1::uuid[])
                    RETURNING event_id, idempotency_key, aggregate_id, event_type, payload_json, attempts
                    """,
                    [row["event_id"] for row in rows], self.owner, float(CLAIM_LEASE_SECONDS),
                )

    async def publish_batch(self) -> int:
        """Publish one claimed batch as hints; returns the number published."""
        events = await self.claim_batch()
        if not events:
            return 0
        client = await self.redis()
        published = 0
        for event in events:
            try:
                hint = {
                    "event_id": str(event["event_id"]),
                    "idempotency_key": event["idempotency_key"],
                    "pool_id": "public-default",
                    "task_id": str(event["aggregate_id"]),
                    "event_type": event["event_type"],
                }
                await client.xadd(HINT_STREAM_KEY, {"hint": json.dumps(hint)}, maxlen=HINT_STREAM_MAXLEN, approximate=True)
                await self._mark_published(event["event_id"])
                published += 1
            except Exception as exc:
                await self._release_with_backoff(event, str(exc))
        return published

    async def _mark_published(self, event_id: uuid.UUID) -> None:
        await self.pool.execute(
            """
            UPDATE infinity_runtime.outbox_events
            SET status = 'published', published_at = NOW(),
                publishing_owner = NULL, publishing_expires_at = NULL, last_error = NULL
            WHERE event_id = $1 AND publishing_owner = $2 AND status = 'publishing'
            """,
            event_id, self.owner,
        )

    async def _release_with_backoff(self, event: asyncpg.Record, error: str) -> None:
        backoff = min(2 ** int(event["attempts"]), BACKOFF_CAP_SECONDS)
        await self.pool.execute(
            """
            UPDATE infinity_runtime.outbox_events
            SET status = CASE WHEN attempts + 1 >= $3 THEN 'failed' ELSE 'pending' END,
                attempts = attempts + 1,
                next_attempt_at = NOW() + make_interval(secs => $4),
                publishing_owner = NULL, publishing_expires_at = NULL,
                last_error = $5
            WHERE event_id = $1 AND publishing_owner = $2 AND status = 'publishing'
            """,
            event["event_id"], self.owner, MAX_ATTEMPTS, float(backoff), error[:500],
        )

    async def recover_expired_claims(self) -> int:
        """Requeue events whose publishing lease expired (publisher crash)."""
        result = await self.pool.execute(
            """
            UPDATE infinity_runtime.outbox_events
            SET status = 'pending', publishing_owner = NULL, publishing_expires_at = NULL
            WHERE status = 'publishing' AND publishing_expires_at < NOW()
            """
        )
        return int(result.rsplit(" ", maxsplit=1)[-1])


async def read_hints(redis_url: str, *, cursor: str = "0-0", limit: int = 20) -> dict[str, Any]:
    """Read wake-up hints from the capped stream; never touches durable state."""
    client = aioredis.from_url(redis_url, decode_responses=True)
    try:
        minimum = "-" if cursor == "0-0" else f"({cursor}"
        entries = await client.xrange(HINT_STREAM_KEY, min=minimum, count=max(1, min(limit, 100)))
        items: list[dict[str, Any]] = []
        next_cursor = cursor
        for entry_id, fields in entries:
            try:
                hint = json.loads(fields.get("hint", "{}"))
            except ValueError:
                continue
            if isinstance(hint, dict):
                items.append(hint)
            next_cursor = entry_id
        return {"items": items, "next_cursor": next_cursor}
    finally:
        await client.aclose()


async def main() -> None:
    database_url = os.getenv("LOCAL_RUNTIME_DATABASE_URL", "").strip()
    redis_url = redis_url_from_env()
    if not database_url or not redis_url:
        raise SystemExit("LOCAL_RUNTIME_DATABASE_URL and LOCAL_REDIS_URL are required")
    from .migrations import apply_migrations

    logging.basicConfig(level=logging.INFO)
    await apply_migrations(database_url)
    pool = await asyncpg.create_pool(database_url, min_size=1, max_size=5)
    publisher = LocalOutboxPublisher(pool, redis_url)
    await publisher.recover_expired_claims()
    await publisher.start()
    try:
        while True:
            await asyncio.sleep(5)
    except (KeyboardInterrupt, asyncio.CancelledError):
        pass
    finally:
        await publisher.stop()
        await pool.close()


if __name__ == "__main__":
    asyncio.run(main())
