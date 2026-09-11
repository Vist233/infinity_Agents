from __future__ import annotations

import json

import pytest

from backend.discovery.llm import ModelClientError, MoonshotJsonClient


class FakeResponse:
    def __init__(self, payload):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self, _limit):
        return json.dumps(self.payload).encode("utf-8")


def test_moonshot_defaults_to_kimi_and_parses_json(monkeypatch):
    captured = {}

    def fake_urlopen(request, timeout):
        captured["url"] = request.full_url
        captured["authorization"] = request.headers.get("Authorization")
        captured["timeout"] = timeout
        return FakeResponse({"choices": [{"message": {"content": "```json\n{\"ok\":true}\n```"}}]})

    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)
    client = MoonshotJsonClient(api_key="runtime-secret")
    assert client.model == "kimi-k2.6"
    assert client.complete_json(system_prompt="system", user_prompt="data") == {"ok": True}
    assert captured["url"].endswith("/v1/chat/completions")
    assert captured["authorization"] == "Bearer runtime-secret"


def test_moonshot_requires_runtime_secret_and_rejects_invalid_base(monkeypatch):
    monkeypatch.delenv("MOONSHOT_API_KEY", raising=False)
    with pytest.raises(ModelClientError, match="required"):
        MoonshotJsonClient()
    with pytest.raises(ModelClientError, match="HTTPS"):
        MoonshotJsonClient(base_url="http://example.test/v1", api_key="x")
