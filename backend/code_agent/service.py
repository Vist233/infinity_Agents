"""Infinity Agent — 产品设计与工程实施规范 v1.0"""

import asyncio
import logging
import os
from pathlib import Path
from typing import AsyncIterator, Dict, Optional

logger = logging.getLogger(__name__)

_CASE_BASE = Path(
    os.getenv(
        "CODE_AGENT_CASE_DIR",
        "/Users/zhangyvjing/Library/Mobile Documents/com~apple~CloudDocs/Code/CodeExcuteGoalDriven/GoalDrivenAttempt/test/case",
    )
)


def _detect_case_dir(user_input: str) -> Optional[Path]:
    normalized = (user_input or "").lower()
    if "case1" in normalized or "rna" in normalized or "deseq" in normalized:
        return _CASE_BASE / "1"
    if "case2" in normalized or "biopython" in normalized or "orchid" in normalized:
        return _CASE_BASE / "2"
    if "case3" in normalized or "scanpy" in normalized or "single cell" in normalized or "scrnaseq" in normalized or "单细胞" in normalized:
        return _CASE_BASE / "3"
    return None


def _read_outputs(case_dir: Path) -> Dict[str, str]:
    output_dir = case_dir / "output"
    results: Dict[str, str] = {}
    if not output_dir.exists():
        return results
    for path in sorted(output_dir.rglob("*")):
        if path.is_file() and path.suffix not in {".zip", ".png", ".jpg", ".jpeg", ".gif", ".svg"}:
            try:
                rel = path.relative_to(output_dir)
                text = path.read_text(errors="replace")
                results[str(rel)] = text[:2000] + ("...(truncated)" if len(text) > 2000 else "")
            except Exception:
                pass
    return results


async def _docker_stream(user_input: str, case_dir: Optional[Path]) -> AsyncIterator[Dict]:
    if case_dir is None:
        yield {"type": "chunk", "content": "CodeAgent received: " + user_input + "\n"}
        yield {"type": "chunk", "content": "Please specify a case (case1 / case2 / case3) for scientific data analysis.\n"}
        yield {"type": "done", "token_info": {"prompt": 0, "response": 0, "total": 0}}
        return

    case_name = case_dir.name
    yield {"type": "status", "phase": "thinking", "elapsed_ms": 0, "attempt": 1, "max_attempts": 1, "tool_name": "docker"}
    await asyncio.sleep(0.1)

    prompt = (
        "You are a scientific data analysis agent.\n"
        f"Analyze the data in: /workspace/{case_name}\n"
        "Save all results to /workspace/output/\n"
    )
    docker_image = os.getenv("CODE_AGENT_DOCKER_IMAGE", "claude/claude-code")

    try:
        proc = await asyncio.create_subprocess_exec(
            "docker", "run", "--rm",
            "-v", f"{case_dir.resolve()}:/workspace/{case_name}",
            docker_image,
            "claude", "--print", prompt,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
    except Exception as exc:
        yield {"type": "error", "message": f"Failed to start Docker: {exc}"}
        return

    output = ""
    try:
        while True:
            line = await proc.stdout.readline()
            if not line:
                break
            text = line.decode("utf-8", errors="replace")
            output += text
            yield {"type": "chunk", "content": text}
        await proc.wait()
    except Exception as exc:
        yield {"type": "error", "message": str(exc)}
    finally:
        if proc.returncode is None:
            try:
                proc.kill()
                await proc.wait()
            except Exception:
                pass

    yield {"type": "status", "phase": "responding", "elapsed_ms": 1500, "attempt": 1, "max_attempts": 1}
    yield {"type": "done", "token_info": {"prompt": 0, "response": len(output), "total": len(output)}}


async def _mock_stream(user_input: str, case_dir: Optional[Path]) -> AsyncIterator[Dict]:
    if case_dir is None:
        yield {"type": "chunk", "content": "CodeAgent received: " + user_input + "\n"}
        yield {"type": "chunk", "content": "Please specify a case (case1 / case2 / case3) for scientific data analysis.\n"}
        yield {"type": "done", "token_info": {"prompt": 0, "response": 0, "total": 0}}
        return

    case_name = case_dir.name
    yield {"type": "status", "phase": "thinking", "elapsed_ms": 0, "attempt": 1, "max_attempts": 1, "tool_name": "setup"}
    await asyncio.sleep(0.3)

    html_files = list(case_dir.glob("*.html"))
    if html_files:
        yield {"type": "chunk", "content": f"Reading analysis guide: {html_files[0].name}\n"}
    yield {"type": "chunk", "content": f"Case {case_name} directory: {case_dir}\n"}
    yield {"type": "status", "phase": "tool_running", "elapsed_ms": 400, "attempt": 1, "max_attempts": 1, "tool_name": "analyze"}
    await asyncio.sleep(0.5)

    outputs = _read_outputs(case_dir)
    if outputs:
        yield {"type": "chunk", "content": f"Found {len(outputs)} output files in case {case_name}/output/\n\n"}
        for name, content in outputs.items():
            yield {"type": "chunk", "content": f"--- {name} ---\n{content}\n\n"}
            await asyncio.sleep(0.1)

    yield {"type": "status", "phase": "responding", "elapsed_ms": 1500, "attempt": 1, "max_attempts": 1}
    yield {"type": "chunk", "content": f"\nCase {case_name} analysis complete. {len(outputs)} files in output directory.\n"}
    yield {"type": "done", "token_info": {"prompt": 0, "response": len(outputs) * 100, "total": len(outputs) * 100}}


async def run_code_agent_stream(user_input: str) -> AsyncIterator[Dict]:
    case_dir = _detect_case_dir(user_input)
    if os.getenv("CODE_AGENT_USE_DOCKER", "").lower() in ("1", "true", "yes"):
        async for event in _docker_stream(user_input, case_dir):
            yield event
    else:
        async for event in _mock_stream(user_input, case_dir):
            yield event
