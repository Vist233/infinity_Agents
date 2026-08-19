from __future__ import annotations

import asyncio
import os
from unittest.mock import AsyncMock, patch

from backend.code_agent.worker.claude_runtime import run_claude_task


def test_direct_claude_runtime_inherits_local_environment(tmp_path, monkeypatch):
    input_dir = tmp_path / "input"
    output_dir = tmp_path / "output"
    monkeypatch.setenv("ANTHROPIC_AUTH_TOKEN", "long-lived-provider-token")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "long-lived-api-key")
    monkeypatch.setenv("ANTHROPIC_BASE_URL", "local-base")
    monkeypatch.setenv("ANTHROPIC_MODEL", "local-model")
    monkeypatch.setenv("WORKER_CREDENTIAL", "worker-secret")
    monkeypatch.setenv("REDIS_URL", "redis://:redis-secret@example.test:6379/0")
    input_dir.mkdir(parents=True, exist_ok=True)
    (input_dir / "method.md").write_text("method", encoding="utf-8")
    process = AsyncMock()
    process.stdout.readline = AsyncMock(side_effect=[b"done\n", b""])
    process.wait = AsyncMock(return_value=None)
    process.returncode = 0

    async def run():
        return [
            event async for event in run_claude_task(
                "task-local",
                "spec-local",
                "dataset-local",
                title="Local test task",
                goal="Produce a reproducible result",
                case_dir=str(input_dir),
                output_dir=str(output_dir),
                attempt_gateway_url="https://gateway.example/attempt/task-local",
                attempt_gateway_token="attempt-token",
                attempt_model_id="local-model",
            )
        ]

    with patch(
        "backend.code_agent.worker.claude_runtime.asyncio.create_subprocess_exec",
        AsyncMock(return_value=process),
    ) as start:
        events = asyncio.run(run())

    args, kwargs = start.call_args
    assert args[0] == "claude"
    assert "--print" in args
    assert "--dangerously-skip-permissions" in args
    assert f"--add-dir={input_dir.resolve()}" in args
    prompt = args[-1]
    assert str(input_dir.resolve()) in prompt
    assert "SYSTEM ROLE" in prompt
    assert "PHASE PROTOCOL" in prompt
    assert "Maximum retries per command: 3." in prompt
    assert "completion message is not proof of success" in prompt
    assert (input_dir.parent / "spec" / "task_spec.json").is_file()
    assert '"goal": "Produce a reproducible result"' in (input_dir.parent / "spec" / "task_spec.json").read_text()
    assert "MISSION" in prompt
    assert "Save every deliverable" in prompt
    assert "attempt-token" not in args
    assert kwargs["env"]["ANTHROPIC_AUTH_TOKEN"] == "attempt-token"
    assert kwargs["env"].get("ANTHROPIC_API_KEY") is None
    assert kwargs["env"]["ANTHROPIC_BASE_URL"] == "https://gateway.example/attempt/task-local"
    assert kwargs["env"]["ANTHROPIC_MODEL"] == "local-model"
    assert "WORKER_CREDENTIAL" not in kwargs["env"]
    assert "REDIS_URL" not in kwargs["env"]
    assert kwargs["env"]["HOME"] == "/home/claude"
    assert kwargs["user"] == 10001
    assert kwargs["group"] == 10001
    assert kwargs["cwd"] == str(input_dir.parent / "work")
    assert os.stat(input_dir).st_mode & 0o222 == 0
    assert os.stat(input_dir / "method.md").st_mode & 0o222 == 0
    assert events[-1]["type"] == "done"


def test_goal_driven_failure_marker_overrides_zero_exit(tmp_path):
    input_dir = tmp_path / "input"
    output_dir = tmp_path / "output"
    logs_dir = input_dir.parent / "logs"
    logs_dir.mkdir(parents=True)
    (logs_dir / "BLOCKED_INPUT").write_text("dataset is missing\n", encoding="utf-8")
    input_dir.mkdir(parents=True, exist_ok=True)
    process = AsyncMock()
    process.stdout.readline = AsyncMock(side_effect=[b"agent stopped\n", b""])
    process.wait = AsyncMock(return_value=None)
    process.returncode = 0

    async def run():
        return [
            event async for event in run_claude_task(
                "task-marker",
                "spec-marker",
                "dataset-marker",
                case_dir=str(input_dir),
                output_dir=str(output_dir),
                attempt_gateway_url="https://gateway.example/attempt/task-marker",
                attempt_gateway_token="attempt-token",
                attempt_model_id="test-model",
            )
        ]

    with patch(
        "backend.code_agent.worker.claude_runtime.asyncio.create_subprocess_exec",
        AsyncMock(return_value=process),
    ):
        events = asyncio.run(run())

    assert events[-1]["type"] == "error"
    assert events[-1]["failure_code"] == "blocked_input"
    assert "dataset is missing" not in events[-1]["message"]


def test_runtime_start_failure_has_explicit_failure_code(tmp_path):
    input_dir = tmp_path / "input"
    input_dir.mkdir(parents=True)

    async def run():
        return [
            event async for event in run_claude_task(
                "task-start-failure",
                "spec-start-failure",
                "dataset-start-failure",
                case_dir=str(input_dir),
                output_dir=str(tmp_path / "output"),
                attempt_gateway_url="https://gateway.example/attempt/task-start-failure",
                attempt_gateway_token="attempt-token",
                attempt_model_id="test-model",
            )
        ]

    with patch(
        "backend.code_agent.worker.claude_runtime.asyncio.create_subprocess_exec",
        AsyncMock(side_effect=FileNotFoundError),
    ):
        events = asyncio.run(run())

    assert events[-1]["type"] == "error"
    assert events[-1]["failure_code"] == "runtime_unavailable"


def test_oversized_failure_marker_is_rejected_without_unbounded_read(tmp_path):
    from backend.code_agent.worker.claude_runtime import _failure_marker

    logs_dir = tmp_path / "logs"
    logs_dir.mkdir()
    (logs_dir / "DEPENDENCY_FAILURE").write_bytes(b"x" * 8193)

    assert _failure_marker(logs_dir) == ("DEPENDENCY_FAILURE", "invalid_failure_marker")
