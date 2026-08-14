from __future__ import annotations

import asyncio
import json
import os
from unittest.mock import patch

import pytest

from backend.code_agent.worker.cloudflare_worker import (
    CloudflareControlClient,
    CloudflareWorkerConfig,
    _zip_output,
)


def _config(tmp_path):
    return CloudflareWorkerConfig(
        control_url="https://infinity.zhangyvjing.com",
        worker_id="worker-a",
        namespace="infinity",
        credential="local-credential",
        instance_id="mac-worker-a",
        redis_url="redis://local-only",
        redis_namespace="infinity",
        anthropic_api_key="local-provider-secret",
        anthropic_auth_token=None,
        anthropic_base_url="https://provider.example/v1",
        anthropic_model="model-a",
        work_root=tmp_path / "work",
        output_root=tmp_path / "output",
    )


def test_connect_does_not_send_provider_secret(monkeypatch, tmp_path):
    config = _config(tmp_path)
    client = CloudflareControlClient(config)
    captured = {}

    def fake_request(method, path, **kwargs):
        captured.update(kwargs)
        return {"session_id": "session-a", "heartbeat_interval_seconds": 30}

    monkeypatch.setattr(client, "_request", fake_request)
    result = asyncio.run(client.connect())

    assert result["session_id"] == "session-a"
    assert config.session_id == "session-a"
    body = captured["json_body"]
    assert body["worker_id"] == "worker-a"
    assert body["provider_configured"] is True
    assert body["provider_model"] == "model-a"
    assert "anthropic_api_key" not in json.dumps(body)
    assert "local-provider-secret" not in json.dumps(body)


def test_from_env_requires_provider_configuration(monkeypatch):
    with patch.dict(os.environ, {}, clear=True):
        monkeypatch.setenv("CONTROL_BASE_URL", "https://infinity.zhangyvjing.com")
        monkeypatch.setenv("WORKER_ID", "public-worker-local")
        monkeypatch.setenv("WORKER_NAMESPACE", "infinity-public")
        monkeypatch.setenv("WORKER_CREDENTIAL", "local-credential")
        monkeypatch.setenv("ANTHROPIC_BASE_URL", "https://provider.example/v1")
        monkeypatch.setenv("ANTHROPIC_MODEL", "model-a")
        with pytest.raises(SystemExit, match="ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN"):
            CloudflareWorkerConfig.from_env()


def test_zip_output_is_deterministic_enough_for_upload(tmp_path):
    output = tmp_path / "output"
    output.mkdir()
    (output / "result.txt").write_text("ok", encoding="utf-8")
    archive, checksum = _zip_output(output, "task-a")

    assert archive.name == "task-a-artifacts.zip"
    assert archive.exists()
    assert len(checksum) == 64


def test_zip_output_rejects_empty_result_directory(tmp_path):
    output = tmp_path / "empty-output"
    output.mkdir()

    with pytest.raises(RuntimeError, match="no output artifacts"):
        _zip_output(output, "task-empty")


def test_large_artifact_uses_multipart_upload(tmp_path):
    archive = tmp_path / "large-artifacts.zip"
    archive.write_bytes(b"x" * (20 * 1024 * 1024 + 1))
    config = _config(tmp_path)
    client = CloudflareControlClient(config)
    calls = []

    def fake_request(method, path, **kwargs):
        calls.append((method, path, kwargs))
        if path.endswith("/multipart/init"):
            return {"artifact_id": "artifact-large", "part_size": 8 * 1024 * 1024}
        if path.endswith("/multipart/complete"):
            return {"artifact_id": "artifact-large", "status": "quarantine"}
        return {"part_number": 1}

    with patch.object(client, "_request", side_effect=fake_request):
        result = asyncio.run(client.upload_artifact("attempt-large", 1, archive, "a" * 64))

    assert result["artifact_id"] == "artifact-large"
    assert calls[0][0] == "POST"
    assert calls[0][1].endswith("/artifacts/multipart/init")
    assert sum(1 for method, path, _ in calls if method == "PUT" and "/parts/" in path) == 3
    assert calls[-1][1].endswith("/multipart/complete")
