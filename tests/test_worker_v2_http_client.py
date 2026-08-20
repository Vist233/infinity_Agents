from __future__ import annotations

import hashlib
import json
from pathlib import Path

import httpx
import pytest

from backend.code_agent.worker.control_plane import ClaimedTask, WorkerV2Client


@pytest.mark.asyncio
async def test_worker_v2_client_uses_server_bound_headers_and_streams_r2_contract(tmp_path: Path) -> None:
    payload = b"frozen execution document\n"
    archive = tmp_path / "result.zip"
    archive.write_bytes(b"abcdef")
    archive_hash = hashlib.sha256(archive.read_bytes()).hexdigest()
    observed: dict[str, object] = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        observed.setdefault("paths", []).append(request.url.path)  # type: ignore[union-attr]
        assert request.headers.get("authorization") == "Bearer persistent-worker-credential"
        assert request.headers.get("x-worker-id") == "public-worker"
        assert request.headers.get("x-worker-protocol-version") == "2"
        assert request.headers.get("x-worker-runtime-capability") == "goal-driven-claude-code"
        assert "x-worker-namespace" not in request.headers
        if request.url.path.endswith("/connect"):
            body = json.loads((await request.aread()).decode())
            assert "namespace" not in body
            assert body["worker_id"] == "public-worker"
            return httpx.Response(201, json={
                "worker_id": "public-worker",
                "pool_id": "public-default",
                "namespace": "infinity-public",
                "session_id": "session-1",
                "session_epoch": 1,
                "lease_expires_at": 200,
            }, request=request)
        if request.url.path.endswith("/poll"):
            return httpx.Response(200, json={"tasks": [{
                "task_id": "task-1",
                "task_spec_id": "spec-1",
                "dataset_snapshot_id": "dataset-1",
                "method_source_id": "method-1",
                "title": "Case 2",
            }], "next_poll_seconds": 1}, request=request)
        if request.url.path.endswith("/accept"):
            return httpx.Response(201, json={
                "attempt_id": "attempt-1",
                "lease_token": "lease-1",
                "fencing_epoch": 1,
                "lease_expires_at": 200,
            }, request=request)
        if request.url.path.endswith("/spec"):
            return httpx.Response(200, json={
                "task_spec": {"title": "Case 2", "goal": "Run the fixed method", "analysis_type": "biopython"},
                "inputs": {"method": {"logical_name": "method.md", "file_size_bytes": len(payload), "sha256": hashlib.sha256(payload).hexdigest()}, "dataset": None},
                "cancel_requested": False,
            }, request=request)
        if request.url.path.endswith("/inputs/method"):
            return httpx.Response(200, headers={"content-length": str(len(payload))}, content=payload, request=request)
        if request.url.path.endswith("/artifacts/start"):
            body = json.loads((await request.aread()).decode())
            assert body["expected_sha256"] == archive_hash
            assert "redis_url" not in body
            return httpx.Response(201, json={"upload_id": "upload-1", "part_size_bytes": 3}, request=request)
        if "/artifacts/upload-1/parts/" in request.url.path:
            part = await request.aread()
            part_number = request.url.path.rsplit("/", 1)[-1]
            return httpx.Response(200, json={"etag": f"etag-{part_number}", "sha256": hashlib.sha256(part).hexdigest(), "size_bytes": len(part)}, request=request)
        if request.url.path.endswith("/artifacts/upload-1/complete"):
            body = json.loads((await request.aread()).decode())
            assert body == {"parts": [{"part_number": 1, "etag": "etag-1"}, {"part_number": 2, "etag": "etag-2"}]}
            return httpx.Response(201, json={"artifact_id": "artifact-1", "checksum_sha256": archive_hash, "file_size_bytes": 6}, request=request)
        raise AssertionError(f"unexpected path {request.url.path}")

    transport = httpx.MockTransport(handler)
    http_client = httpx.AsyncClient(transport=transport, follow_redirects=False)
    client = WorkerV2Client(
        base_url="https://localhost",
        worker_id="public-worker",
        credential="persistent-worker-credential",
        instance_id="windows-public-worker",
        http_client=http_client,
    )
    claim = await client.connect()
    assert claim.pool_id == "public-default"
    tasks, _ = await client.poll()
    claimed = await client.accept(tasks[0])
    destination = tmp_path / "method.md"
    await client.download_input(claimed, "method", destination, {"file_size_bytes": len(payload), "sha256": hashlib.sha256(payload).hexdigest()})
    started = await client.start_artifact(claimed, name="result.zip", kind="result_archive", content_type="application/zip", size=6, sha256=archive_hash, manifest={})
    await client.upload_artifact_part(claimed, started["upload_id"], 1, archive, 0, 3)
    await client.upload_artifact_part(claimed, started["upload_id"], 2, archive, 3, 3)
    completed = await client.complete_artifact(claimed, started["upload_id"], [{"part_number": 1, "etag": "etag-1"}, {"part_number": 2, "etag": "etag-2"}])
    await client.close()

    assert destination.read_bytes() == payload
    assert completed["artifact_id"] == "artifact-1"
    assert "/api/worker/v2/connect" in observed["paths"]  # type: ignore[operator]


@pytest.mark.asyncio
async def test_artifact_part_upload_can_be_cancelled_between_stream_chunks(tmp_path: Path) -> None:
    archive = tmp_path / "large.zip"
    archive.write_bytes(b"x" * (3 * 1024 * 1024))
    checks = 0

    def cancel_after_first_chunk() -> None:
        nonlocal checks
        checks += 1
        if checks >= 2:
            raise RuntimeError("cancelled during upload")

    async def handler(request: httpx.Request) -> httpx.Response:
        await request.aread()
        raise AssertionError("cancelled upload must not complete the request")

    client = WorkerV2Client(
        base_url="https://localhost",
        worker_id="public-worker",
        credential="persistent-worker-credential",
        instance_id="windows-public-worker",
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )
    client.session = type("Session", (), {
        "session_id": "session-1", "session_epoch": 1,
        "pool_id": "public-default", "namespace": "infinity-public",
        "lease_expires_at": 9999999999,
    })()
    claim = ClaimedTask(
        task_id="task-1", task_spec_id="spec-1", dataset_snapshot_id="dataset-1",
        method_source_id=None, title="Large", attempt_id="attempt-1",
        lease_token="lease-1", fencing_epoch=1, lease_expires_at=9999999999,
    )
    with pytest.raises(RuntimeError, match="cancelled during upload"):
        await client.upload_artifact_part(
            claim, "upload-1", 1, archive, 0, archive.stat().st_size,
            progress_check=cancel_after_first_chunk,
        )
    assert checks == 2
    await client.close()
