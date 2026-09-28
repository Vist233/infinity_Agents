"""End-to-end Worker v2 API tests against a real PostgreSQL instance.

Set LOCAL_RUNTIME_TEST_DATABASE_URL to enable; the suite skips otherwise.
"""

from __future__ import annotations

import asyncio
import hashlib
import io
import os
import uuid
import zipfile
from io import BytesIO
from pathlib import Path

import asyncpg
import httpx
import pytest

from backend.code_agent.worker import consumer_v2, executor_v2
from backend.code_agent.worker.control_plane import WorkerV2Client
from backend.auth import Principal
from backend.db import ensure_table
from backend.local_runtime.api_repository import LocalRuntimeApiRepository
from backend.local_runtime.migrations import apply_migrations
from backend.local_runtime.object_store import LocalObjectStore
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


async def test_task_center_direct_submission_is_canonical_and_worker_visible(client, runtime_app, tmp_path, monkeypatch):
    """The browser's legacy preparation rows must produce a real Worker task."""
    await ensure_table(runtime_app.state.runtime_pool)
    pool = runtime_app.state.runtime_pool
    project_id = uuid.uuid4()
    task_spec_id = uuid.uuid4()
    method_source_id = uuid.uuid4()
    dataset_resource_id = uuid.uuid4()
    dataset_snapshot_id = uuid.uuid4()
    title = "Direct local numbers"
    method_bytes = b"# Add the values in numbers.csv\n"
    dataset_buffer = io.BytesIO()
    with zipfile.ZipFile(dataset_buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("numbers.csv", "value\n1\n2\n3\n")
    dataset_bytes = dataset_buffer.getvalue()
    method_root = tmp_path / "method-sources"
    resource_root = tmp_path / "resources"
    object_root = tmp_path / "objects"
    method_path = method_root / "documents" / f"{method_source_id}-method.md"
    dataset_path = resource_root / "datasets" / str(dataset_resource_id)
    method_path.parent.mkdir(parents=True)
    dataset_path.parent.mkdir(parents=True)
    method_path.write_bytes(method_bytes)
    dataset_path.write_bytes(dataset_bytes)
    method_hash = hashlib.sha256(method_bytes).hexdigest()
    dataset_hash = hashlib.sha256(dataset_bytes).hexdigest()

    await pool.execute(
        "INSERT INTO projects (project_id, name, created_by, owner_user_id) VALUES ($1, $2, 'alice', 'alice')",
        project_id,
        title,
    )
    await pool.execute(
        "INSERT INTO project_members (project_id, user_id, role) VALUES ($1, 'alice', 'owner')",
        project_id,
    )
    await pool.execute(
        """
        INSERT INTO task_specs
            (task_spec_id, project_id, title, domain, analysis_type, research_question,
             spec_json, schema_version, status, created_by, frozen_at)
        VALUES ($1, $2, $3, 'bioinformatics', 'generic', 'Add the numbers',
                '{"steps":["sum"]}'::jsonb, '1.0', 'active', 'alice', NOW())
        """,
        task_spec_id,
        project_id,
        title,
    )
    await pool.execute(
        """
        INSERT INTO method_sources
            (method_source_id, project_id, task_spec_id, original_filename, stored_path,
             content_type, file_size_bytes, file_hash_sha256)
        VALUES ($1, $2, NULL, 'method.md', $3, 'text/markdown', $4, $5)
        """,
        method_source_id,
        project_id,
        str(method_path),
        len(method_bytes),
        method_hash,
    )
    await pool.execute(
        """
        INSERT INTO project_resources
            (resource_id, project_id, owner_user_id, kind, logical_name, storage_key,
             content_type, file_size_bytes, checksum_sha256, egress_policy, status)
        VALUES ($1, $2, 'alice', 'dataset', 'numbers.zip', $3, 'application/zip', $4, $5,
                'local_only', 'ready')
        """,
        dataset_resource_id,
        project_id,
        f"datasets/{dataset_resource_id}",
        len(dataset_bytes),
        dataset_hash,
    )
    await pool.execute(
        """
        INSERT INTO dataset_snapshots
            (dataset_snapshot_id, task_spec_id, project_id, original_filename, stored_path,
             file_size_bytes, file_hash_sha256, validation_result, validation_passed, version)
        VALUES ($1, $2, $3, 'numbers.zip', $4, $5, $6,
                '{"passed":true,"format":"zip"}'::jsonb, TRUE, 1)
        """,
        dataset_snapshot_id,
        task_spec_id,
        project_id,
        str(dataset_path),
        len(dataset_bytes),
        dataset_hash,
    )

    monkeypatch.setenv("METHOD_SOURCE_UPLOAD_ROOT", str(method_root))
    monkeypatch.setenv("RESOURCE_STORAGE_ROOT", str(resource_root))
    import backend.app as backend_app_module

    backend_app_module.app.state.db_pool = pool
    backend_app_module.app.state.local_object_store = LocalObjectStore(object_root)
    backend_app_module.app.state.local_runtime_repository = LocalRuntimeApiRepository(pool)
    backend_app_module.app.dependency_overrides[backend_app_module._require_task_api_key] = lambda: Principal(user_id="alice")
    direct_client = httpx.AsyncClient(
        transport=httpx.ASGITransport(app=backend_app_module.app),
        base_url="http://local-api.test",
    )
    payload = {
        "project_id": str(project_id),
        "task_spec_id": str(task_spec_id),
        "dataset_snapshot_id": str(dataset_snapshot_id),
        "title": title,
        "method_source_id": str(method_source_id),
        "idempotency_key": "browser-direct-canonical-test",
        "chat_confirmation_id": False,
        "submission_source": "task_center",
        "agent_confirmation": False,
    }
    try:
        created = await direct_client.post("/api/tasks/direct", json=payload)
        assert created.status_code == 200, created.text
        created_body = created.json()
        assert created_body["runtime"] == "infinity_runtime"
        assert created_body["duplicate"] is False
        task_id = uuid.UUID(created_body["task_id"])

        replay = await direct_client.post("/api/tasks/direct", json=payload)
        assert replay.status_code == 200, replay.text
        assert replay.json()["task_id"] == str(task_id)
        assert replay.json()["duplicate"] is True

        invalid = await direct_client.post(
            "/api/tasks/direct",
            json={**payload, "dataset_snapshot_id": str(uuid.uuid4()), "idempotency_key": "invalid-direct-input"},
        )
        assert invalid.status_code == 404, invalid.text
    finally:
        await direct_client.aclose()
        backend_app_module.app.dependency_overrides.pop(backend_app_module._require_task_api_key, None)

    canonical = await pool.fetchrow(
        "SELECT task_spec_id, created_by, title, status FROM infinity_runtime.tasks WHERE task_id = $1",
        task_id,
    )
    assert canonical and canonical["created_by"] == "alice" and canonical["status"] == "queued"
    assert await pool.fetchval("SELECT COUNT(*) FROM infinity_runtime.tasks") == 1
    resource_rows = await pool.fetch(
        """
        SELECT kind, file_size_bytes, checksum_sha256, state
        FROM infinity_runtime.resources r
        JOIN infinity_runtime.task_specs s
          ON r.resource_id IN (s.method_resource_id, s.dataset_resource_id)
        WHERE s.task_spec_id = $1
        ORDER BY kind
        """,
        canonical["task_spec_id"],
    )
    assert [(row["kind"], row["state"]) for row in resource_rows] == [("dataset", "ready"), ("method", "ready")]

    repository = runtime_app.state.runtime_repository
    await repository.issue_worker(worker_id=WORKER_ID, created_by="alice", credential=CREDENTIAL)
    session = await connect_worker(client, instance_id="direct-browser")
    headers = session_headers(session, instance_id="direct-browser")
    poll = await client.post("/api/worker/v2/poll", headers=headers, json={})
    assert poll.status_code == 200, poll.text
    assert [item["task_id"] for item in poll.json()["tasks"]] == [str(task_id)]
    accepted = await client.post(f"/api/worker/v2/tasks/{task_id}/accept", headers=headers, json={})
    assert accepted.status_code == 201, accepted.text
    claim = accepted.json()
    attempt_headers = {
        **headers,
        "x-worker-attempt-id": claim["attempt_id"],
        "x-worker-lease-token": claim["lease_token"],
    }
    spec = await client.get(f"/api/worker/v2/tasks/{task_id}/spec", headers=attempt_headers)
    assert spec.status_code == 200, spec.text
    assert spec.json()["inputs"]["method"]["logical_name"] == "method.md"
    assert spec.json()["inputs"]["dataset"]["logical_name"] == "numbers.zip"
    method_download = await client.get(f"/api/worker/v2/tasks/{task_id}/inputs/method", headers=attempt_headers)
    dataset_download = await client.get(f"/api/worker/v2/tasks/{task_id}/inputs/dataset", headers=attempt_headers)
    assert method_download.status_code == 200 and method_download.content == method_bytes
    assert dataset_download.status_code == 200 and dataset_download.content == dataset_bytes


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


async def test_real_worker_control_loop_completes_a_local_task_without_claude(
    runtime_app, monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
):
    """Run the actual poll/claim/download/upload loop against real PostgreSQL and the API app."""

    task_id, dataset, _dataset_sha = await seed_task(runtime_app)
    work_root = tmp_path / "worker-work"
    monkeypatch.setenv("APP_ENV", "test")
    monkeypatch.setenv("WORKER_CONTROL_PLANE_URL", "http://127.0.0.1")
    monkeypatch.setenv("WORKER_CREDENTIAL", CREDENTIAL)
    monkeypatch.setenv("WORKER_INSTANCE_ID", "local-integration")
    monkeypatch.setenv("WORKER_WORK_ROOT", str(work_root))

    observed: dict[str, bytes] = {}

    async def fake_claude_runtime(**kwargs):
        input_path = Path(str(kwargs["case_dir"])) / "data.bin"
        observed["downloaded_input"] = input_path.read_bytes()
        output_dir = Path(str(kwargs["output_dir"]))
        (output_dir / "result.txt").write_text("local worker integration result\n", encoding="utf-8")
        yield {"type": "done", "output": "stub runtime"}

    monkeypatch.setattr(executor_v2, "run_claude_task", fake_claude_runtime)

    transport = httpx.ASGITransport(app=runtime_app)
    api_client = httpx.AsyncClient(
        transport=transport,
        base_url="http://127.0.0.1",
        follow_redirects=False,
    )

    class StopAfterOneTaskClient(WorkerV2Client):
        def __init__(self, **kwargs):
            super().__init__(**kwargs, http_client=api_client)
            self.poll_count = 0

        async def poll(self):
            self.poll_count += 1
            if self.poll_count > 1:
                raise asyncio.CancelledError()
            return await super().poll()

        async def close(self):
            await super().close()
            await api_client.aclose()

    monkeypatch.setattr(consumer_v2, "WorkerV2Client", StopAfterOneTaskClient)

    with pytest.raises(asyncio.CancelledError):
        await consumer_v2.run_worker(WORKER_ID)

    assert observed["downloaded_input"] == dataset
    pool = runtime_app.state.runtime_pool
    task = await pool.fetchrow(
        "SELECT status, active_attempt_id FROM infinity_runtime.tasks WHERE task_id = $1",
        task_id,
    )
    assert task["status"] == "succeeded"
    artifact = await pool.fetchrow(
        "SELECT object_key, file_size_bytes FROM infinity_runtime.artifacts WHERE task_id = $1",
        task_id,
    )
    assert artifact is not None
    archive = runtime_app.state.runtime_store.read_path(artifact["object_key"]).read_bytes()
    assert len(archive) == artifact["file_size_bytes"]
    with zipfile.ZipFile(BytesIO(archive)) as result_zip:
        assert result_zip.read("result.txt") == b"local worker integration result\n"
    attempt = await pool.fetchrow(
        "SELECT status FROM infinity_runtime.task_attempts WHERE attempt_id = $1",
        task["active_attempt_id"],
    )
    assert attempt["status"] == "succeeded"
    assert list(work_root.iterdir()) == []


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
