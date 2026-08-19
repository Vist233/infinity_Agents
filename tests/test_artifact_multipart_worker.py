from __future__ import annotations

import hashlib

import httpx
import pytest

from backend.security import SecurityBoundaryError
from backend.code_agent.worker.executor import _upload_remote_artifact


@pytest.mark.asyncio
async def test_large_worker_artifact_uses_server_multipart_contract(tmp_path, monkeypatch):
    archive = tmp_path / "result.zip"
    payload = b"abcdefghij"
    archive.write_bytes(payload)
    checksum = hashlib.sha256(payload).hexdigest()
    requests: list[tuple[str, bytes, dict[str, str]]] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        body = await request.aread()
        requests.append((request.url.path, body, dict(request.headers)))
        if request.url.path.endswith("/artifact-uploads") and request.method == "POST":
            return httpx.Response(
                201,
                json={"upload_id": "upload-1", "part_size_bytes": 4, "part_count": 3},
                request=request,
            )
        if "/parts/" in request.url.path and request.method == "PUT":
            return httpx.Response(200, json={"uploaded": True}, request=request)
        if request.url.path.endswith("/complete") and request.method == "POST":
            return httpx.Response(
                200,
                json={
                    "artifact_id": "artifact-12345678901234567890",
                    "file_size_bytes": len(payload),
                    "checksum_sha256": checksum,
                },
                request=request,
            )
        return httpx.Response(404, request=request)

    transport = httpx.MockTransport(handler)
    original_client = httpx.AsyncClient

    def client_factory(*args, **kwargs):
        kwargs["transport"] = transport
        return original_client(*args, **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", client_factory)
    monkeypatch.setenv("ARTIFACT_MULTIPART_THRESHOLD_BYTES", "4")

    result = await _upload_remote_artifact(
        "http://localhost:8000",
        "task-1",
        7,
        "artifact-12345678901234567890",
        archive,
        archive_checksum=checksum,
        worker_id="worker-1",
        worker_namespace="shared-lab",
        worker_credential="credential",
        lease_token="lease",
        worker_instance_id="instance-1",
        worker_protocol_version="1",
        worker_runtime_capability="goal-driven-claude-code",
    )

    assert result == "artifact-12345678901234567890"
    part_requests = [item for item in requests if "/parts/" in item[0]]
    assert [body for _path, body, _headers in part_requests] == [b"abcd", b"efgh", b"ij"]
    assert all(headers.get("x-worker-part-sha256") for _path, _body, headers in part_requests)
    assert requests[0][2]["x-worker-artifact-size"] == str(len(payload))


@pytest.mark.asyncio
async def test_large_worker_artifact_requires_checksum(tmp_path, monkeypatch):
    archive = tmp_path / "result.zip"
    archive.write_bytes(b"large")
    monkeypatch.setenv("ARTIFACT_MULTIPART_THRESHOLD_BYTES", "1")

    with pytest.raises(SecurityBoundaryError, match="checksum"):
        await _upload_remote_artifact(
            "http://localhost:8000",
            "task-1",
            7,
            "artifact-12345678901234567890",
            archive,
            worker_id="worker-1",
            worker_namespace="shared-lab",
            worker_credential="credential",
            lease_token="lease",
        )
