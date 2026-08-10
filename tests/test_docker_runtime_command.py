from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, patch

from backend.code_agent.worker.docker_runtime import run_docker_task


def test_gateway_secret_is_inherited_not_put_in_docker_argv(monkeypatch, tmp_path):
    monkeypatch.setenv("ATTEMPT_GATEWAY_TOKEN", "gateway-secret-do-not-leak")
    monkeypatch.delenv("ANTHROPIC_AUTH_TOKEN", raising=False)
    monkeypatch.delenv("CODE_AGENT_INPUT_VOLUME", raising=False)
    monkeypatch.delenv("CODE_AGENT_OUTPUT_VOLUME", raising=False)
    process = AsyncMock()
    process.stdout.readline = AsyncMock(side_effect=[b"", b""])
    process.wait = AsyncMock(return_value=None)
    process.returncode = 0

    async def run():
        async for _ in run_docker_task(
            "task-a", "spec-a", "dataset-a", case_dir=str(tmp_path / "input"), output_dir=str(tmp_path / "output")
        ):
            pass

    with patch("backend.code_agent.worker.docker_runtime.asyncio.create_subprocess_exec", AsyncMock(return_value=process)) as start:
        asyncio.run(run())

    args, kwargs = start.call_args
    assert "gateway-secret-do-not-leak" not in args
    assert "-e" in args
    assert "ANTHROPIC_AUTH_TOKEN" in args
    assert kwargs["env"]["ANTHROPIC_AUTH_TOKEN"] == "gateway-secret-do-not-leak"


def test_named_worker_volumes_replace_host_bind_paths(monkeypatch, tmp_path):
    monkeypatch.setenv("CODE_AGENT_INPUT_VOLUME", "infinity-agents-worker-a-inputs")
    monkeypatch.setenv("CODE_AGENT_OUTPUT_VOLUME", "infinity-agents-worker-a-outputs")
    input_root = tmp_path / "input-root"
    output_root = tmp_path / "output-root"
    monkeypatch.setenv("CODE_AGENT_INPUT_VOLUME_ROOT", str(input_root))
    monkeypatch.setenv("CODE_AGENT_OUTPUT_VOLUME_ROOT", str(output_root))
    process = AsyncMock()
    process.stdout.readline = AsyncMock(side_effect=[b"", b""])
    process.wait = AsyncMock(return_value=None)
    process.returncode = 0

    async def run():
        async for _ in run_docker_task(
            "task-a", "spec-a", "dataset-a",
            case_dir=str(input_root / "task-a" / "input"),
            output_dir=str(output_root / "task-a" / "output"),
        ):
            pass

    with patch("backend.code_agent.worker.docker_runtime.asyncio.create_subprocess_exec", AsyncMock(return_value=process)) as start:
        asyncio.run(run())

    args = start.call_args.args
    assert "type=volume,source=infinity-agents-worker-a-inputs,target=/workspace/input,volume-subpath=task-a/input,readonly" in args
    assert "type=volume,source=infinity-agents-worker-a-outputs,target=/workspace/output,volume-subpath=task-a/output" in args
    assert not any(str(value).startswith(str(tmp_path)) for value in args)
