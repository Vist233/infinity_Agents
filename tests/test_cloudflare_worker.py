from __future__ import annotations

import asyncio
import json

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


def test_zip_output_is_deterministic_enough_for_upload(tmp_path):
    output = tmp_path / "output"
    output.mkdir()
    (output / "result.txt").write_text("ok", encoding="utf-8")
    archive, checksum = _zip_output(output, "task-a")

    assert archive.name == "task-a-artifacts.zip"
    assert archive.exists()
    assert len(checksum) == 64
