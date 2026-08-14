from __future__ import annotations

import asyncio
import os
from unittest.mock import AsyncMock, patch

from backend.code_agent.worker.claude_runtime import run_claude_task


def test_direct_claude_runtime_inherits_local_environment(tmp_path, monkeypatch):
    input_dir = tmp_path / "input"
    output_dir = tmp_path / "output"
    monkeypatch.setenv("ANTHROPIC_AUTH_TOKEN", "local-token")
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
    assert "Goal-Driven execution protocol" in prompt
    assert "Do not copy the" in prompt
    assert "local-token" not in args
    assert kwargs["env"]["ANTHROPIC_AUTH_TOKEN"] == "local-token"
    assert kwargs["env"]["ANTHROPIC_BASE_URL"] == "local-base"
    assert kwargs["env"]["ANTHROPIC_MODEL"] == "local-model"
    assert "WORKER_CREDENTIAL" not in kwargs["env"]
    assert "REDIS_URL" not in kwargs["env"]
    assert kwargs["env"]["HOME"] == "/home/claude"
    assert kwargs["user"] == 10001
    assert kwargs["group"] == 10001
    assert kwargs["cwd"] == str(output_dir.resolve())
    assert os.stat(input_dir).st_mode & 0o222 == 0
    assert os.stat(input_dir / "method.md").st_mode & 0o222 == 0
    assert events[-1]["type"] == "done"
