"""Real PostgreSQL checks for the locally ported product HTTP routes.

Set LOCAL_RUNTIME_TEST_DATABASE_URL to an isolated test database to run them.
"""

from __future__ import annotations

import os
import uuid

import asyncpg
import httpx
import pytest
from fastapi import FastAPI

from backend.local_runtime.migrations import apply_migrations
from backend.local_runtime.object_store import LocalObjectStore
from backend.local_runtime.product_api import create_product_router


TEST_DSN = os.getenv("LOCAL_RUNTIME_TEST_DATABASE_URL", "").strip()
pytestmark = pytest.mark.skipif(not TEST_DSN, reason="LOCAL_RUNTIME_TEST_DATABASE_URL is required")


@pytest.fixture
async def product_app(tmp_path):
    await apply_migrations(TEST_DSN)
    pool = await asyncpg.create_pool(TEST_DSN, min_size=1, max_size=2)
    app = FastAPI()
    app.include_router(create_product_router())
    app.state.db_pool = pool
    app.state.local_object_store = LocalObjectStore(tmp_path / "objects")
    try:
        yield app
    finally:
        await pool.close()


@pytest.mark.asyncio
async def test_collection_upload_is_durable_and_duplicate_is_idempotent(product_app):
    marker = uuid.uuid4().hex
    payload = f"sample,value\n{marker},3\n".encode()
    transport = httpx.ASGITransport(app=product_app)
    async with httpx.AsyncClient(transport=transport, base_url="http://local.test") as client:
        first = await client.post(
            "/api/discovery/data-collections",
            files={"file": ("../outside.csv", payload, "text/csv")},
        )
        assert first.status_code == 200, first.text
        created = first.json()
        assert created["duplicate"] is False
        collection_id = created["collection_id"]

        again = await client.post(
            "/api/discovery/data-collections",
            files={"file": ("outside.csv", payload, "text/csv")},
        )
        assert again.status_code == 200, again.text
        assert again.json()["duplicate"] is True
        assert again.json()["collection_id"] == collection_id

        detail = await client.get(f"/api/discovery/data-collections/{collection_id}")
        assert detail.status_code == 200, detail.text
        assert detail.json()["collection_id"] == collection_id

    row = await product_app.state.db_pool.fetchrow(
        "SELECT source_object_key, source_filename FROM infinity_runtime.data_collections WHERE collection_id = $1",
        uuid.UUID(collection_id),
    )
    assert row["source_filename"] == "outside.csv"
    assert row["source_object_key"].startswith(f"datasets/{collection_id}/source/")
    assert product_app.state.local_object_store.read_path(row["source_object_key"]).read_bytes() == payload


@pytest.mark.asyncio
async def test_unsupported_collection_file_is_rejected_before_storage(product_app):
    payload = f"not a dataset {uuid.uuid4().hex}".encode()
    transport = httpx.ASGITransport(app=product_app)
    async with httpx.AsyncClient(transport=transport, base_url="http://local.test") as client:
        response = await client.post(
            "/api/discovery/data-collections",
            files={"file": ("payload.exe", payload, "application/octet-stream")},
        )
    assert response.status_code == 422
    assert not list(product_app.state.local_object_store.root.rglob("*.exe"))
