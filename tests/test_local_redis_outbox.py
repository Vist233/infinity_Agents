"""Local Redis outbox coordination tests against real PostgreSQL and Redis.

Requires LOCAL_RUNTIME_TEST_DATABASE_URL and LOCAL_RUNTIME_TEST_REDIS_URL;
the suite skips otherwise.
"""

from __future__ import annotations

import asyncio
import json
import os
import uuid

import asyncpg
import httpx
import pytest
import redis.asyncio as aioredis

from backend.local_runtime.migrations import apply_migrations
from backend.local_runtime.outbox_redis import (
    LocalOutboxPublisher,
    read_hints,
)
from backend.local_runtime.repository import LocalRuntimeRepository
from backend.local_runtime.worker_api import create_worker_v2_app


TEST_DSN = os.getenv("LOCAL_RUNTIME_TEST_DATABASE_URL", "").strip()
TEST_REDIS_URL = os.getenv("LOCAL_RUNTIME_TEST_REDIS_URL", "").strip()
pytestmark = pytest.mark.skipif(
    not (TEST_DSN and TEST_REDIS_URL),
    reason="LOCAL_RUNTIME_TEST_DATABASE_URL and LOCAL_RUNTIME_TEST_REDIS_URL are required",
)

CREDENTIAL = "local-l3-persistent-credential"
WORKER_ID = "worker-local-l3"


@pytest.fixture
async def runtime_pool():
    await apply_migrations(TEST_DSN)
    pool = await asyncpg.create_pool(TEST_DSN, min_size=1, max_size=8)
    async with pool.acquire() as connection:
        await connection.execute(
            """
            TRUNCATE infinity_runtime.outbox_events,
                     infinity_runtime.task_events,
                     infinity_runtime.artifact_upload_parts,
                     infinity_runtime.artifacts,
                     infinity_runtime.artifact_uploads,
                     infinity_runtime.task_attempts,
                     infinity_runtime.tasks,
                     infinity_runtime.task_specs,
                     infinity_runtime.worker_sessions,
                     infinity_runtime.workers,
                     infinity_runtime.resources
            CASCADE
            """
        )
    client = aioredis.from_url(TEST_REDIS_URL)
    await client.flushall()
    await client.aclose()
    try:
        yield pool
    finally:
        await pool.close()


async def seed_claimed_task(pool: asyncpg.Pool) -> uuid.UUID:
    repository = LocalRuntimeRepository(pool)
    await repository.issue_worker(worker_id=WORKER_ID, created_by="admin", credential=CREDENTIAL)
    resource_id = await pool.fetchval(
        """
        INSERT INTO infinity_runtime.resources
            (owner_user_id, kind, logical_name, object_key, file_size_bytes, checksum_sha256)
        VALUES ('alice', 'dataset', 'data.bin', $1, 1, $2)
        RETURNING resource_id
        """,
        f"inputs/{uuid.uuid4()}", "0" * 64,
    )
    task_id = await repository.create_task(
        created_by="alice", title="L3 task", goal="Coordinate", execution_document={},
        dataset_resource_id=resource_id,
    )
    session, _created = await repository.connect_worker(
        worker_id=WORKER_ID, credential=CREDENTIAL, instance_id="machine-a",
    )
    await repository.claim_task(session, task_id)
    return task_id


async def test_outbox_events_publish_as_hints(runtime_pool):
    task_id = await seed_claimed_task(runtime_pool)
    publisher = LocalOutboxPublisher(runtime_pool, TEST_REDIS_URL)
    try:
        published = await publisher.publish_batch()
        assert published == 1  # task_claimed event
        row = await runtime_pool.fetchrow(
            "SELECT status, published_at, attempts FROM infinity_runtime.outbox_events WHERE aggregate_id = $1",
            task_id,
        )
        assert row["status"] == "published" and row["published_at"] is not None

        payload = await read_hints(TEST_REDIS_URL)
        assert len(payload["items"]) == 1
        hint = payload["items"][0]
        assert hint["pool_id"] == "public-default"
        assert hint["task_id"] == str(task_id)
        assert hint["event_type"] == "task_claimed"
    finally:
        await publisher.close()


async def test_redis_outage_keeps_events_and_recovers(runtime_pool):
    task_id = await seed_claimed_task(runtime_pool)
    dead_url = "redis://127.0.0.1:1/0"  # nothing listens here
    broken = LocalOutboxPublisher(runtime_pool, dead_url)
    try:
        published = await broken.publish_batch()
        assert published == 0
        row = await runtime_pool.fetchrow(
            """
            SELECT status, attempts, next_attempt_at, last_error
            FROM infinity_runtime.outbox_events WHERE aggregate_id = $1
            """,
            task_id,
        )
        assert row["status"] == "pending"  # durable row survives the outage
        assert row["attempts"] == 1 and row["last_error"]
        # No double attempt can appear: exactly one attempt row exists.
        assert await runtime_pool.fetchval(
            "SELECT COUNT(*) FROM infinity_runtime.task_attempts WHERE task_id = $1", task_id,
        ) == 1
    finally:
        await broken.close()

    await runtime_pool.execute(
        "UPDATE infinity_runtime.outbox_events SET next_attempt_at = NOW() WHERE aggregate_id = $1", task_id,
    )
    recovered = LocalOutboxPublisher(runtime_pool, TEST_REDIS_URL)
    try:
        published = await recovered.publish_batch()
        assert published == 1  # idempotent replay after recovery
        assert await runtime_pool.fetchval(
            "SELECT status FROM infinity_runtime.outbox_events WHERE aggregate_id = $1", task_id,
        ) == "published"
        assert await runtime_pool.fetchval(
            "SELECT COUNT(*) FROM infinity_runtime.task_attempts WHERE task_id = $1", task_id,
        ) == 1  # replay publishes hints only; it never creates attempts
    finally:
        await recovered.close()


async def test_redis_flush_loses_nothing_durable(runtime_pool):
    task_id = await seed_claimed_task(runtime_pool)
    publisher = LocalOutboxPublisher(runtime_pool, TEST_REDIS_URL)
    try:
        assert await publisher.publish_batch() == 1
        client = aioredis.from_url(TEST_REDIS_URL)
        await client.flushall()  # Redis is disposable: hints are rebuildable
        await client.aclose()
        payload = await read_hints(TEST_REDIS_URL)
        assert payload["items"] == []
        # Durable state is untouched by the flush.
        assert await runtime_pool.fetchval(
            "SELECT status FROM infinity_runtime.tasks WHERE task_id = $1", task_id,
        ) == "claimed"
        assert await runtime_pool.fetchval(
            "SELECT COUNT(*) FROM infinity_runtime.task_attempts WHERE task_id = $1", task_id,
        ) == 1
    finally:
        await publisher.close()


async def test_redis_never_stores_secrets_or_inputs(runtime_pool):
    await seed_claimed_task(runtime_pool)
    publisher = LocalOutboxPublisher(runtime_pool, TEST_REDIS_URL)
    try:
        await publisher.publish_batch()
        client = aioredis.from_url(TEST_REDIS_URL, decode_responses=True)
        keys = []
        cursor = 0
        while True:
            cursor, batch = await client.scan(cursor=cursor, match="*")
            keys.extend(batch)
            if cursor == 0:
                break
        dump = json.dumps([key for key in keys])
        for key in keys:
            kind = await client.type(key)
            if kind == "stream":
                entries = await client.xrange(key)
                dump += json.dumps([[entry_id, fields] for entry_id, fields in entries])
            elif kind == "string":
                dump += str(await client.get(key))
        await client.aclose()
        for forbidden in (CREDENTIAL, "lease_", "password", "Bearer"):
            assert forbidden not in dump
        assert "task_claimed" in dump
    finally:
        await publisher.close()


async def test_stale_publishing_claim_is_requeued(runtime_pool):
    task_id = await seed_claimed_task(runtime_pool)
    await runtime_pool.execute(
        """
        UPDATE infinity_runtime.outbox_events
        SET status = 'publishing', publishing_owner = 'dead-publisher',
            publishing_expires_at = NOW() - INTERVAL '1 minute'
        WHERE aggregate_id = $1
        """,
        task_id,
    )
    publisher = LocalOutboxPublisher(runtime_pool, TEST_REDIS_URL)
    try:
        recovered = await publisher.recover_expired_claims()
        assert recovered == 1
        assert await publisher.publish_batch() == 1
    finally:
        await publisher.close()


async def test_hints_endpoint_degrades_without_redis(runtime_pool, tmp_path):
    app = create_worker_v2_app(TEST_DSN, str(tmp_path / "objects"))
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://local-runtime.test") as client:
            response = await client.get("/v1/hints")
            assert response.status_code == 200
            assert response.json() == {"items": [], "next_cursor": "0-0"}


async def test_hints_endpoint_serves_published_events(runtime_pool, tmp_path):
    task_id = await seed_claimed_task(runtime_pool)
    app = create_worker_v2_app(TEST_DSN, str(tmp_path / "objects"), redis_url=TEST_REDIS_URL)
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://local-runtime.test") as client:
            deadline = 30
            items: list[dict] = []
            for _ in range(deadline):
                response = await client.get("/v1/hints")
                assert response.status_code == 200
                items = response.json()["items"]
                if items:
                    break
                await asyncio.sleep(0.2)
            assert any(item.get("task_id") == str(task_id) for item in items)
