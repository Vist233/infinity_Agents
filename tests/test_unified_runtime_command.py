from __future__ import annotations

import inspect

from backend.code_agent.worker.claude_runtime import _claude_child_environment, run_claude_task


def test_claude_runtime_has_no_nested_docker_command():
    source = inspect.getsource(run_claude_task)
    assert '"docker"' not in source
    assert "docker run" not in source
    assert "create_subprocess_exec" in source
    assert '"claude"' in source


def test_child_environment_excludes_worker_and_redis_secrets_but_keeps_provider_config(monkeypatch):
    monkeypatch.setenv("WORKER_CREDENTIAL", "worker-secret")
    monkeypatch.setenv("REDIS_URL", "redis://:redis-secret@example.test/0")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "long-lived-provider-key")
    monkeypatch.setenv("ANTHROPIC_AUTH_TOKEN", "long-lived-provider-token")
    monkeypatch.setenv("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1")

    env = _claude_child_environment()

    assert "WORKER_CREDENTIAL" not in env
    assert "REDIS_URL" not in env
    assert env["ANTHROPIC_API_KEY"] == "long-lived-provider-key"
    assert env["ANTHROPIC_AUTH_TOKEN"] == "long-lived-provider-token"
    assert env["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"] == "1"
