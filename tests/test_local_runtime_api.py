"""End-to-end Worker v2 API tests against a real PostgreSQL instance.

Set LOCAL_RUNTIME_TEST_DATABASE_URL to enable; the suite skips otherwise.
"""

from __future__ import annotations

import hashlib
import os
import uuid

import asyncpg
import httpx
import pytest

from backend.local_runtime.migrations import apply_migrations
from backend.local_runtime.worker_api import create_worker_v2_app


TEST_DSN = os.getenv("LOCAL_RUNTIME_TEST_DATABASE_URL", "").strip()
pytestmark = pytest.mark.skipif(not TEST_DSN, reason="LOCAL_RUNTIME_TEST_DATABASE_URL is required")

CREDENTIAL = "local-e2e-persistent-credential"
WORKER_ID = "worker-local-e2e"

PROTOCOL_HEADERS = {
    "x-worker-protocol-version": "2",
    "x-worker-runtime-capability": "goal-driven-claude-code",
}


@pytest.fixture
async def runtime_app(tmp_path):
    await apply_migrations(TEST_DSN)
    connection = await asyncpg.connect(TEST_DSN)
    try:
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
    finally:
        await connection.close()
    app = create_worker_v2_app(TEST_DSN, str(tmp_path / "objects"))
    async with app.router.lifespan_context(app):
        yield app


@pytest.fixture
def client(runtime_app):
    transport = httpx.ASGITransport(app=runtime_app)
    return httpx.AsyncClient(transport=transport, base_url="http://local-runtime.test")


async def connect_worker(client, *, instance_id: str = "machine-a") -> dict:
    response = await client.post(
        "/api/worker/v2/connect",
        headers={"authorization": f"Bearer {CREDENTIAL}", **PROTOCOL_HEADERS},
        json={
            "worker_id": WORKER_ID,
            "instance_id": instance_id,
            "protocol_version": "2",
            "runtime_capability": "goal-driven-claude-code",
        },
    )
    assert response.status_code in {200, 201}, response.text
    return response.json()


def session_headers(session: dict, *, instance_id: str = "machine-a") -> dict:
    return {
        "authorization": f"Bearer {CREDENTIAL}",
        "x-worker-id": WORKER_ID,
        "x-worker-instance-id": instance_id,
        "x-worker-session-id": session["session_id"],
        "x-worker-session-epoch": str(session["session_epoch"]),
        **PROTOCOL_HEADERS,
    }


async def seed_task(runtime_app) -> tuple[uuid.UUID, bytes, str]:
    repository = runtime_app.state.runtime_repository
    store = runtime_app.state.runtime_store
    await repository.issue_worker(worker_id=WORKER_ID, created_by="admin", credential=CREDENTIAL)
    dataset = b"dataset-payload" * 64
    size, sha256 = store.write_bytes("inputs/dataset/seed/data.bin", dataset)
    resource_id = await repository.pool.fetchval(
        """
        INSERT INTO infinity_runtime.resources
            (owner_user_id, kind, logical_name, object_key, file_size_bytes, checksum_sha256)
        VALUES ('alice', 'dataset', 'data.bin', 'inputs/dataset/seed/data.bin', $1, $2)
        RETURNING resource_id
        """,
        size, sha256,
    )
    task_id = await repository.create_task(
        created_by="alice",
        title="Local e2e task",
        goal="Run the local pipeline",
        execution_document={"steps": ["analyze"]},
        dataset_resource_id=resource_id,
    )
    return task_id, dataset, sha256


async def test_full_task_lifecycle(client, runtime_app):
    task_id, dataset, _dataset_sha = await seed_task(runtime_app)
    session = await connect_worker(client)
    headers = session_headers(session)

    heartbeat = await client.post("/api/worker/v2/heartbeat", headers=headers, json={})
    assert heartbeat.status_code == 200
    assert heartbeat.json()["status"] == "ready"

    poll = await client.post("/api/worker/v2/poll", headers=headers, json={})
    assert poll.status_code == 200
    tasks = poll.json()["tasks"]
    assert len(tasks) == 1 and tasks[0]["task_id"] == str(task_id)

    accept = await client.post(f"/api/worker/v2/tasks/{task_id}/accept", headers=headers, json={})
    assert accept.status_code == 201, accept.text
    claim = accept.json()
    attempt_headers = {
        **headers,
        "x-worker-attempt-id": claim["attempt_id"],
        "x-worker-lease-token": claim["lease_token"],
    }

    renew = await client.post(f"/api/worker/v2/tasks/{task_id}/renew", headers=attempt_headers, json={})
    assert renew.status_code == 200, renew.text
    assert renew.json()["status"] == "running"

    spec = await client.get(f"/api/worker/v2/tasks/{task_id}/spec", headers=attempt_headers)
    assert spec.status_code == 200, spec.text
    spec_payload = spec.json()
    assert spec_payload["task_spec"]["goal"] == "Run the local pipeline"
    assert spec_payload["task_spec"]["execution_document"] == {"steps": ["analyze"]}
    assert spec_payload["inputs"]["dataset"]["logical_name"] == "data.bin"

    downloaded = await client.get(f"/api/worker/v2/tasks/{task_id}/inputs/dataset", headers=attempt_headers)
    assert downloaded.status_code == 200
    assert downloaded.content == dataset
    assert downloaded.headers["x-infinity-sha256"] == hashlib.sha256(dataset).hexdigest()

    artifact = (b"zip-artifact-content" * 50) * 17000  # > MAX_PART_BYTES forces multiple parts
    artifact_sha = hashlib.sha256(artifact).hexdigest()
    start = await client.post(
        f"/api/worker/v2/tasks/{task_id}/artifacts/start",
        headers=attempt_headers,
        json={
            "name": "result.zip",
            "kind": "result",
            "content_type": "application/zip",
            "expected_size_bytes": len(artifact),
            "expected_sha256": artifact_sha,
            "manifest": {"version": 1},
        },
    )
    assert start.status_code == 201, start.text
    upload = start.json()
    part_size = upload["part_size_bytes"]
    assert part_size > 0 and upload["upload_id"]

    parts = []
    for index in range(0, len(artifact), part_size):
        part_number = index // part_size + 1
        chunk = artifact[index:index + part_size]
        part_response = await client.put(
            f"/api/worker/v2/artifacts/{upload['upload_id']}/parts/{part_number}",
            headers={**attempt_headers, "content-type": "application/octet-stream"},
            content=chunk,
        )
        assert part_response.status_code == 200, part_response.text
        part_payload = part_response.json()
        assert part_payload["sha256"] == hashlib.sha256(chunk).hexdigest()
        parts.append({"part_number": part_number, "etag": part_payload["etag"]})
    assert len(parts) >= 2  # the lifecycle must exercise real multipart upload

    complete = await client.post(
        f"/api/worker/v2/artifacts/{upload['upload_id']}/complete",
        headers=attempt_headers,
        json={"parts": parts},
    )
    assert complete.status_code == 201, complete.text
    completed = complete.json()
    assert completed["status"] == "published"
    assert completed["checksum_sha256"] == artifact_sha

    pool = runtime_app.state.runtime_pool
    assert await pool.fetchval("SELECT status FROM infinity_runtime.tasks WHERE task_id = $1", task_id) == "succeeded"
    stored_key = await pool.fetchval(
        "SELECT object_key FROM infinity_runtime.artifacts WHERE artifact_id = $1",
        uuid.UUID(completed["artifact_id"]),
    )
    assert runtime_app.state.runtime_store.read_path(stored_key).read_bytes() == artifact
    assert await pool.fetchval(
        "SELECT COUNT(*) FROM infinity_runtime.outbox_events WHERE aggregate_id = $1 AND event_type = 'task_succeeded'",
        task_id,
    ) == 1


async def test_superseded_session_is_rejected(client, runtime_app):
    await seed_task(runtime_app)
    old_session = await connect_worker(client, instance_id="machine-a")

    blocked = await connect_worker_raw(client, instance_id="machine-b")
    assert blocked.status_code == 409
    assert blocked.json()["error"]["code"] == "WORKER_ALREADY_CONNECTED"

    pool = runtime_app.state.runtime_pool
    await pool.execute(
        """
        UPDATE infinity_runtime.worker_sessions
        SET lease_expires_at = NOW() - INTERVAL '1 second'
        WHERE session_id = $1
        """,
        old_session["session_id"],
    )
    new_session = await connect_worker(client, instance_id="machine-b")
    assert new_session["session_epoch"] == old_session["session_epoch"] + 1

    stale = await client.post(
        "/api/worker/v2/heartbeat",
        headers=session_headers(old_session),
        json={},
    )
    assert stale.status_code == 401
    assert stale.json()["error"]["code"] == "WORKER_SESSION_INVALID"

    fresh = await client.post(
        "/api/worker/v2/heartbeat",
        headers=session_headers(new_session, instance_id="machine-b"),
        json={},
    )
    assert fresh.status_code == 200


async def connect_worker_raw(client, *, instance_id: str) -> httpx.Response:
    return await client.post(
        "/api/worker/v2/connect",
        headers={"authorization": f"Bearer {CREDENTIAL}", **PROTOCOL_HEADERS},
        json={
            "worker_id": WORKER_ID,
            "instance_id": instance_id,
            "protocol_version": "2",
            "runtime_capability": "goal-driven-claude-code",
        },
    )


async def test_artifact_checksum_mismatch_is_rejected(client, runtime_app):
    task_id, _dataset, _sha = await seed_task(runtime_app)
    session = await connect_worker(client)
    accept = await client.post(
        f"/api/worker/v2/tasks/{task_id}/accept",
        headers=session_headers(session),
        json={},
    )
    claim = accept.json()
    attempt_headers = {
        **session_headers(session),
        "x-worker-attempt-id": claim["attempt_id"],
        "x-worker-lease-token": claim["lease_token"],
    }

    artifact = b"corrupted-artifact"
    start = await client.post(
        f"/api/worker/v2/tasks/{task_id}/artifacts/start",
        headers=attempt_headers,
        json={
            "name": "result.zip",
            "kind": "result",
            "content_type": "application/zip",
            "expected_size_bytes": len(artifact),
            "expected_sha256": "f" * 64,
            "manifest": {},
        },
    )
    assert start.status_code == 201, start.text
    upload_id = start.json()["upload_id"]
    part = await client.put(
        f"/api/worker/v2/artifacts/{upload_id}/parts/1",
        headers={**attempt_headers, "content-type": "application/octet-stream"},
        content=artifact,
    )
    assert part.status_code == 200
    complete = await client.post(
        f"/api/worker/v2/artifacts/{upload_id}/complete",
        headers=attempt_headers,
        json={"parts": [{"part_number": 1, "etag": part.json()["etag"]}]},
    )
    assert complete.status_code == 409
    assert complete.json()["error"]["code"] == "ARTIFACT_VALIDATION_FAILED"
    pool = runtime_app.state.runtime_pool
    assert await pool.fetchval("SELECT status FROM infinity_runtime.tasks WHERE task_id = $1", task_id) == "claimed"
    assert await pool.fetchval(
        "SELECT status FROM infinity_runtime.artifact_uploads WHERE upload_id = $1", uuid.UUID(upload_id),
    ) == "aborted"


async def test_connect_rejects_forbidden_infrastructure_fields(client, runtime_app):
    await seed_task(runtime_app)
    response = await client.post(
        "/api/worker/v2/connect",
        headers={"authorization": f"Bearer {CREDENTIAL}", **PROTOCOL_HEADERS},
        json={
            "worker_id": WORKER_ID,
            "instance_id": "machine-a",
            "protocol_version": "2",
            "runtime_capability": "goal-driven-claude-code",
            "namespace": "attacker",
        },
    )
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "WORKER_METADATA_FORBIDDEN"


async def test_object_key_traversal_cannot_escape_store(client, runtime_app):
    from backend.local_runtime.object_store import ObjectStoreError

    store = runtime_app.state.runtime_store
    with pytest.raises(ObjectStoreError):
        store.read_path("../../etc/passwd")


async def test_restart_recovers_stale_finalize(runtime_app, tmp_path):
    task_id, _dataset, _sha = await seed_task(runtime_app)
    repository = runtime_app.state.runtime_repository
    session_ctx, _created = await repository.connect_worker(
        worker_id=WORKER_ID, credential=CREDENTIAL, instance_id="machine-a",
    )
    claim = await repository.claim_task(session_ctx, task_id)
    upload_id = uuid.uuid4()
    await repository.pool.execute(
        """
        INSERT INTO infinity_runtime.artifact_uploads
            (upload_id, artifact_id, task_id, attempt_id, worker_id, object_key,
             name, expected_size_bytes, expected_sha256, part_size_bytes, part_count,
             status, finalize_owner, finalize_started_at)
        VALUES ($1, $2, $3, $4, $5, $6, 'result.zip', 10, $7, 16, 1,
                'finalizing', 'dead-owner', NOW() - INTERVAL '1 hour')
        """,
        upload_id, uuid.uuid4(), task_id, claim.attempt_id, WORKER_ID,
        f"task-artifacts/{task_id}/stale.zip", "0" * 64,
    )

    from backend.local_runtime.worker_api import create_worker_v2_app

    recovered_app = create_worker_v2_app(TEST_DSN, str(tmp_path / "objects-restart"))
    async with recovered_app.router.lifespan_context(recovered_app):
        status = await recovered_app.state.runtime_pool.fetchval(
            "SELECT status FROM infinity_runtime.artifact_uploads WHERE upload_id = $1", upload_id,
        )
    assert status == "open"
