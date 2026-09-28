"""Real PostgreSQL checks for the locally ported product HTTP routes.

Set LOCAL_RUNTIME_TEST_DATABASE_URL to an isolated test database to run them.
"""

from __future__ import annotations

import os
import hashlib
import json
import uuid

import asyncpg
import httpx
import pytest
from fastapi import FastAPI

from backend.local_runtime.migrations import apply_migrations
from backend.local_runtime.object_store import LocalObjectStore
from backend.local_runtime.product_api import create_product_router
from backend.discovery.paper_profile import compile_paper_profile


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
async def test_discovery_lists_include_profiles_for_ready_rows_only(product_app):
    pool = product_app.state.db_pool
    suffix = uuid.uuid4().hex
    paper_ids = [uuid.uuid4() for _ in range(3)]
    paper_resource_ids = [uuid.uuid4() for _ in range(3)]
    paper_session_ids = [uuid.uuid4() for _ in range(3)]
    collection_ids = [uuid.uuid4() for _ in range(3)]

    paper_text = (
        "Prediction of a reproducible scientific method\n"
        "Authors: Example Author\n\n"
        "Abstract\nWe evaluate a reproducible method for a tabular dataset.\n\n"
        "Introduction\nThis paper studies a research question.\n\n"
        "Methods\nWe perform Pearson correlation analysis and report the results.\n\n"
        "Results\nThe results support the method and include figures.\n\n"
        "References\nExample et al. (2026).\n"
        "Additional results support reproducibility and describe the reported analysis. " * 8
    )
    paper_profile = compile_paper_profile(
        [paper_text],
        str(paper_resource_ids[0]),
        input_sha256="a" * 64,
        generated_at="2026-09-28T00:00:00Z",
    )
    paper_profile_bytes = json.dumps(paper_profile, ensure_ascii=False, separators=(",", ":")).encode()
    collection_profile = {
        "profile_version": "dataset-profile-v1",
        "model_version": "inspector-v1",
        "provenance": {
            "collection_id": str(collection_ids[0]),
            "inspector_version": "inspector-v1",
            "generated_at": "2026-09-28T00:00:00Z",
        },
        "collection_id": str(collection_ids[0]),
        "domain_hint": "tabular",
        "files": [{
            "path": "features.csv",
            "format": "csv",
            "size_bytes": 51,
            "sha256": "d" * 64,
            "rows": 4,
            "columns": 3,
            "column_names": ["feature_a", "feature_b", "target"],
            "data_types": {"feature_a": "numeric", "feature_b": "numeric", "target": "numeric"},
            "missing_ratio": 0.0,
            "sample": [{"feature_a": 1, "feature_b": 2, "target": 3}],
        }],
        "capabilities": {"sample_count": 4, "feature_count": 2, "tabular.numeric_features": True},
        "semantic_fields": {"target": "target", "feature_names": ["feature_a", "feature_b"]},
        "display_tags": ["Tabular"],
    }
    collection_profile_bytes = json.dumps(collection_profile, ensure_ascii=False, separators=(",", ":")).encode()

    try:
        for index, (session_id, resource_id) in enumerate(zip(paper_session_ids, paper_resource_ids)):
            await pool.execute(
                "INSERT INTO infinity_runtime.chat_sessions (session_id, user_id, title) VALUES ($1, 'local-admin', $2)",
                session_id,
                f"Paper list test {suffix}-{index}",
            )
            await pool.execute(
                """
                INSERT INTO infinity_runtime.paper_resources
                    (resource_id, session_id, user_id, source_kind, source_ref, title,
                     status, source_sha256, pdf_size_bytes, pdf_sha256)
                VALUES ($1, $2, 'local-admin', 'user_upload', $3, $4, 'ready', $5, 1, $5)
                """,
                resource_id,
                session_id,
                f"list-test:{suffix}:{index}",
                f"List test paper {index}",
                chr(ord("a") + index) * 64,
            )
        await pool.execute(
            """
            INSERT INTO infinity_runtime.paper_catalog
                (paper_id, owner_user_id, source_resource_id, title, authors_json,
                 status, spam_status, profile_version, profile_json, profile_sha256)
            VALUES ($1, 'local-admin', $2, $3, $4::jsonb, 'profiled', 'scientific_paper',
                    $5, $6::jsonb, $7)
            """,
            paper_ids[0],
            paper_resource_ids[0],
            paper_profile["paper"]["title"],
            json.dumps(paper_profile["paper"]["authors"]),
            paper_profile["profile_version"],
            json.dumps(paper_profile, ensure_ascii=False),
            hashlib.sha256(paper_profile_bytes).hexdigest(),
        )
        await pool.execute(
            """
            INSERT INTO infinity_runtime.paper_catalog
                (paper_id, owner_user_id, source_resource_id, title, status, spam_status)
            VALUES ($1, 'local-admin', $2, 'Waiting paper', 'requested', 'pending')
            """,
            paper_ids[1], paper_resource_ids[1],
        )
        await pool.execute(
            """
            INSERT INTO infinity_runtime.paper_catalog
                (paper_id, owner_user_id, source_resource_id, title, status, spam_status)
            VALUES ($1, 'local-admin', $2, 'Failed paper', 'failed', 'review')
            """,
            paper_ids[2], paper_resource_ids[2],
        )

        for index, collection_id in enumerate(collection_ids):
            is_ready = index == 0
            await pool.execute(
                """
                INSERT INTO infinity_runtime.data_collections
                    (collection_id, owner_user_id, name, source_object_key, source_filename,
                     source_content_type, source_sha256, source_size_bytes, status,
                     profile_version, profile_json, profile_sha256)
                VALUES ($1, 'local-admin', $2, $3, 'features.csv', 'text/csv', $4, 51, $5,
                        $6, $7::jsonb, $8)
                """,
                collection_id,
                f"List test collection {index}",
                f"datasets/{collection_id}/source/features.csv",
                chr(ord("d") + index) * 64,
                "ready" if is_ready else "failed" if index == 2 else "uploaded",
                collection_profile["profile_version"] if is_ready else None,
                json.dumps(collection_profile) if is_ready else None,
                hashlib.sha256(collection_profile_bytes).hexdigest() if is_ready else None,
            )

        transport = httpx.ASGITransport(app=product_app)
        async with httpx.AsyncClient(transport=transport, base_url="http://local.test") as client:
            papers_response = await client.get("/api/discovery/papers")
            collections_response = await client.get("/api/discovery/data-collections")
        assert papers_response.status_code == 200, papers_response.text
        assert collections_response.status_code == 200, collections_response.text

        papers = {item["paper_id"]: item for item in papers_response.json()["papers"]}
        profiled = papers[str(paper_ids[0])]
        assert profiled["profile"]["profile_version"] == "paper-profile-v1"
        assert profiled["profile"]["paper"]["abstract"]
        assert len(profiled["profile"]["analysis_modules"]) >= 1
        assert papers[str(paper_ids[1])]["profile"] is None
        assert papers[str(paper_ids[2])]["profile"] is None

        collections = {item["collection_id"]: item for item in collections_response.json()["collections"]}
        ready = collections[str(collection_ids[0])]
        assert ready["profile"]["profile_version"] == "dataset-profile-v1"
        assert ready["profile"]["files"][0]["rows"] == 4
        assert ready["profile"]["files"][0]["columns"] == 3
        assert ready["profile"]["semantic_fields"]["target"] == "target"
        assert collections[str(collection_ids[1])]["profile"] is None
        assert collections[str(collection_ids[2])]["profile"] is None
    finally:
        for paper_id in paper_ids:
            await pool.execute("DELETE FROM infinity_runtime.paper_catalog WHERE paper_id = $1", paper_id)
        for resource_id in paper_resource_ids:
            await pool.execute("DELETE FROM infinity_runtime.paper_resources WHERE resource_id = $1", resource_id)
        for session_id in paper_session_ids:
            await pool.execute("DELETE FROM infinity_runtime.chat_sessions WHERE session_id = $1", session_id)
        for collection_id in collection_ids:
            await pool.execute("DELETE FROM infinity_runtime.data_collections WHERE collection_id = $1", collection_id)


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
