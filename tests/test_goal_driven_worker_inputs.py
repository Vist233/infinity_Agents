from __future__ import annotations

import hashlib
import io
import json
import zipfile

import httpx
import pytest

from backend.code_agent.worker.executor import _assert_frozen_input, _download_remote_input, _stage_dataset, execute_task
from backend.security import SecurityBoundaryError


class _RecordingRedis:
    def __init__(self):
        self.events = []

    async def publish_task_event(self, task_id, payload):
        self.events.append((task_id, payload))

    async def set_progress(self, task_id, payload):
        self.events.append((task_id, {"progress": payload}))


async def _async_value(value):
    return value


def test_worker_stages_frozen_dataset_and_preserves_content(tmp_path, monkeypatch):
    upload_root = tmp_path / "resources"
    upload_root.mkdir()
    archive = upload_root / "dataset.zip"
    with zipfile.ZipFile(archive, "w") as bundle:
        bundle.writestr("counts.csv", "sample,condition\nA,control\n")
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    monkeypatch.setenv("RESOURCE_STORAGE_ROOT", str(upload_root))
    _assert_frozen_input(archive, {
        "file_size_bytes": archive.stat().st_size,
        "file_hash_sha256": digest,
    }, "dataset")
    destination = tmp_path / "input" / "data"
    _stage_dataset(archive, destination, logical_name="dataset.zip")
    extracted = destination / "counts.csv"
    assert extracted.read_text() == "sample,condition\nA,control\n"


def test_worker_rejects_changed_frozen_input(tmp_path):
    document = tmp_path / "method.md"
    document.write_text("# original")
    with pytest.raises(SecurityBoundaryError, match="hash"):
        _assert_frozen_input(document, {
            "file_size_bytes": document.stat().st_size,
            "file_hash_sha256": "0" * 64,
        }, "execution document")


@pytest.mark.asyncio
async def test_worker_downloads_remote_frozen_input_with_persistent_identity(tmp_path, monkeypatch):
    payload = b"# frozen method\n"
    observed = {}

    def handler(request):
        observed["path"] = request.url.path
        observed["worker_id"] = request.headers.get("X-Worker-ID")
        observed["namespace"] = request.headers.get("X-Worker-Namespace")
        observed["credential"] = request.headers.get("X-Worker-Credential")
        observed["lease"] = request.headers.get("X-Worker-Lease-Token")
        return httpx.Response(200, headers={"Content-Length": str(len(payload))}, content=payload, request=request)

    transport = httpx.MockTransport(handler)
    original_client = httpx.AsyncClient

    def client_factory(*args, **kwargs):
        kwargs["transport"] = transport
        return original_client(*args, **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", client_factory)
    destination = tmp_path / "downloaded" / "method.md"
    downloaded = await _download_remote_input(
        "https://control.example",
        "task-1",
        "method",
        worker_id="worker-a",
        worker_namespace="shared-lab",
        worker_credential="persistent-credential",
        lease_token="lease-token",
        destination=destination,
    )

    assert downloaded == destination
    assert destination.read_bytes() == payload
    assert observed == {
        "path": "/api/worker/tasks/task-1/inputs/method",
        "worker_id": "worker-a",
        "namespace": "shared-lab",
        "credential": "persistent-credential",
        "lease": "lease-token",
    }
    _assert_frozen_input(destination, {
        "file_size_bytes": len(payload),
        "file_hash_sha256": hashlib.sha256(payload).hexdigest(),
    }, "execution document")


@pytest.mark.asyncio
async def test_worker_fixture_downloads_inputs_uploads_artifact_and_cleans_workspace(tmp_path, monkeypatch):
    method_payload = b"# frozen method\n"
    dataset_payload = io.BytesIO()
    with zipfile.ZipFile(dataset_payload, "w") as archive:
        archive.writestr("counts.csv", "sample,value\nA,1\n")
    dataset_payload = dataset_payload.getvalue()
    method_hash = hashlib.sha256(method_payload).hexdigest()
    dataset_hash = hashlib.sha256(dataset_payload).hexdigest()

    fixture_root = tmp_path / "fixtures"
    fixture_output = fixture_root / "2" / "output"
    fixture_output.mkdir(parents=True)
    (fixture_output / "result.txt").write_text("fixture result\n", encoding="utf-8")

    task_id = "worker-fixture-task"
    attempt_id = 7
    output_root = tmp_path / "worker-output"
    observed = {"inputs": [], "artifact": None}

    async def transport_handler(request):
        path = request.url.path
        if path.endswith("/inputs/method"):
            observed["inputs"].append("method")
            return httpx.Response(200, content=method_payload, request=request)
        if path.endswith("/inputs/dataset"):
            observed["inputs"].append("dataset")
            return httpx.Response(200, content=dataset_payload, request=request)
        if path.endswith("/artifacts"):
            observed["artifact"] = {
                "worker_id": request.headers.get("X-Worker-ID"),
                "namespace": request.headers.get("X-Worker-Namespace"),
                "credential": request.headers.get("X-Worker-Credential"),
                "lease": request.headers.get("X-Worker-Lease-Token"),
                "attempt": request.headers.get("X-Worker-Attempt-ID"),
                "archive": request.content,
            }
            return httpx.Response(
                200,
                json={"artifact_id": request.headers.get("X-Worker-Artifact-ID")},
                request=request,
            )
        return httpx.Response(404, request=request)

    transport = httpx.MockTransport(transport_handler)
    original_client = httpx.AsyncClient

    def client_factory(*args, **kwargs):
        kwargs["transport"] = transport
        return original_client(*args, **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", client_factory)
    monkeypatch.setenv("APP_ENV", "test")
    monkeypatch.setenv("ALLOW_FIXTURE_EXECUTOR", "1")
    monkeypatch.setenv("CODE_AGENT_EXECUTOR_MODE", "fixture")
    monkeypatch.setenv("GOAL_DRIVEN_FIXTURE_ROOT", str(fixture_root))
    monkeypatch.setattr(
        "backend.code_agent.worker.executor._get_task_spec",
        lambda *_args: _async_value({
            "task_spec_id": "spec-1",
            "analysis_type": "biopython",
            "record_frozen_input_manifest": True,
        }),
    )
    monkeypatch.setattr(
        "backend.code_agent.worker.executor._get_dataset",
        lambda *_args: _async_value({
            "dataset_snapshot_id": "snapshot-1",
            "original_filename": "dataset.zip",
            "stored_path": "/remote-only/dataset.zip",
            "file_size_bytes": len(dataset_payload),
            "file_hash_sha256": dataset_hash,
        }),
    )
    monkeypatch.setattr(
        "backend.code_agent.task_service.get_method_source",
        lambda *_args: _async_value({
            "method_source_id": "method-1",
            "original_filename": "method.md",
            "stored_path": "/remote-only/method.md",
            "file_size_bytes": len(method_payload),
            "file_hash_sha256": method_hash,
        }),
    )
    monkeypatch.setattr("backend.code_agent.worker.executor._get_image_digest", lambda *_args: _async_value(None))
    monkeypatch.setattr(
        "backend.code_agent.task_service.complete_task_attempt",
        lambda *_args, **_kwargs: _async_value(None),
    )
    monkeypatch.setattr("backend.code_agent.worker.executor._validate_outputs", lambda *_args: _async_value({"passed": True, "failures": []}))

    redis = _RecordingRedis()
    result = await execute_task(
        task_id=task_id,
        attempt_id=attempt_id,
        task_spec_id="spec-1",
        dataset_snapshot_id="snapshot-1",
        worker_id="worker-a",
        lease_token="lease-token",
        docker_image="fixture-image",
        db_pool=None,
        redis_client=redis,
        method_source_id="method-1",
        output_base_dir=str(output_root),
        worker_namespace="shared-lab",
        worker_credential="persistent-credential",
        control_plane_url="http://localhost",
    )

    assert result["success"] is True
    assert observed["inputs"] == ["dataset", "method"]
    assert observed["artifact"]["worker_id"] == "worker-a"
    assert observed["artifact"]["namespace"] == "shared-lab"
    assert observed["artifact"]["credential"] == "persistent-credential"
    assert observed["artifact"]["lease"] == "lease-token"
    assert observed["artifact"]["attempt"] == str(attempt_id)
    archive = zipfile.ZipFile(io.BytesIO(observed["artifact"]["archive"]))
    manifest_name = next(name for name in archive.namelist() if name.endswith("frozen-input-manifest.json"))
    manifest = json.loads(archive.read(manifest_name))
    hashes = {item["sha256"] for item in manifest}
    assert method_hash in hashes
    assert hashlib.sha256(b"sample,value\nA,1\n").hexdigest() in hashes
    assert not (output_root / task_id).exists()
