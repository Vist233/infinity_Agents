"""Deterministic controlled Executor used for local acceptance only.

It copies precomputed, versioned fixture outputs into a clean Attempt output
directory.  It is deliberately disabled outside development/acceptance and is
never presented as a model execution result.
"""

from __future__ import annotations

import asyncio
import os
import shutil
from pathlib import Path
from typing import Any, AsyncIterator, Dict

from backend.security import ArtifactCollector, SecurityBoundaryError, ensure_within


def fixture_case_number(analysis_type: str) -> str | None:
    return {"rnaseq_deseq2": "1", "biopython": "2", "scanpy": "3"}.get(str(analysis_type or ""))


async def run_fixture_executor(task_spec: Dict[str, Any], output_dir: Path) -> AsyncIterator[Dict[str, Any]]:
    if os.getenv("APP_ENV", "development").lower() not in {"development", "acceptance", "test"}:
        yield {"type": "error", "message": "Fixture Executor is disabled outside local environments"}
        return
    if os.getenv("ALLOW_FIXTURE_EXECUTOR", "0").lower() not in {"1", "true", "yes"}:
        yield {"type": "error", "message": "Fixture Executor is not enabled"}
        return
    root_value = os.getenv("GOAL_DRIVEN_FIXTURE_ROOT", "").strip()
    case_number = fixture_case_number(str(task_spec.get("analysis_type") or ""))
    if not root_value or not case_number:
        yield {"type": "error", "message": "A configured scientific fixture is required"}
        return
    case_root = (Path(root_value).expanduser() / case_number).resolve()
    source_root = case_root / "output"
    if not source_root.is_dir() or source_root.is_symlink():
        yield {"type": "error", "message": "Fixture output directory is unavailable"}
        return
    output_dir.mkdir(parents=True, exist_ok=True)
    yield {"type": "status", "phase": "executing", "executor": "controlled-fixture", "case": case_number}
    count = 0
    for source in sorted(source_root.rglob("*")):
        if not source.is_file() or source.is_symlink():
            if source.is_symlink():
                yield {"type": "error", "message": "Fixture contains an unsupported link"}
                return
            continue
        # Keep the documented ``output/...`` contract in the Attempt. The
        # manifest and verifier therefore use the same paths for real and
        # controlled executions.
        relative = source.relative_to(case_root)
        destination = ensure_within(output_dir, output_dir / relative)
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, destination)
        count += 1
    try:
        ArtifactCollector(max_files=5000, max_total_bytes=2 * 1024 * 1024 * 1024)._iter_files(output_dir)
    except SecurityBoundaryError as exc:
        yield {"type": "error", "message": str(exc)}
        return
    await asyncio.sleep(0)
    yield {"type": "chunk", "content": f"Controlled fixture Executor copied {count} verified files for case {case_number}.\n"}
    yield {"type": "done", "output": "controlled-fixture"}
