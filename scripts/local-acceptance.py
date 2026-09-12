"""Run a deterministic local Task -> Attempt -> Artifact acceptance check.

The local launcher must already be running with CODE_AGENT_EXECUTOR_MODE=
local-fixture. The fixture is intentionally provider-free and is never used by
the Cloudflare or production paths.
"""

from __future__ import annotations

import asyncio
import hashlib
import os
import sys
import time
from pathlib import Path

import asyncpg
import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend.code_agent.models import DatasetSnapshot, Task, TaskSpec
from backend.code_agent.task_service import (
    create_dataset_snapshot,
    create_task,
    create_task_spec,
    ensure_default_project,
    get_task,
)
from backend.db import ensure_table


async def main() -> None:
    database_url = os.getenv("DATABASE_URL", "").strip()
    if not database_url:
        raise SystemExit("DATABASE_URL is required; source .env.local first")
    api_url = os.getenv("LOCAL_ACCEPTANCE_API_URL", "http://127.0.0.1:8008").rstrip("/")
    pool = await asyncpg.create_pool(database_url, min_size=1, max_size=2)
    try:
        await ensure_table(pool)
        project = await ensure_default_project(pool)
        spec = await create_task_spec(
            pool,
            TaskSpec(
                project_id=project["project_id"],
                title="local acceptance fixture",
                analysis_type="generic",
                research_question="Verify deterministic local Artifact delivery",
                spec_json={"required_outputs": ["local-fixture-result.json"]},
                created_by="local-admin",
            ),
        )
        snapshot = await create_dataset_snapshot(
            pool,
            DatasetSnapshot(
                task_spec_id=spec.task_spec_id,
                project_id=project["project_id"],
                original_filename="fixture.csv",
                stored_path="/tmp/local-fixture.csv",
                file_size_bytes=0,
                file_hash_sha256=hashlib.sha256(b"").hexdigest(),
                validation_passed=True,
            ),
        )
        idempotency_key = f"local-acceptance-{time.time_ns()}"
        first, first_new = await create_task(
            pool,
            Task(
                task_spec_id=spec.task_spec_id,
                dataset_snapshot_id=snapshot.dataset_snapshot_id,
                project_id=project["project_id"],
                title="local acceptance task",
                status="queued",
                created_by="local-admin",
            ),
            idempotency_key=idempotency_key,
        )
        replay, replay_new = await create_task(
            pool,
            Task(
                task_spec_id=spec.task_spec_id,
                dataset_snapshot_id=snapshot.dataset_snapshot_id,
                project_id=project["project_id"],
                title="local acceptance replay",
                status="queued",
                created_by="local-admin",
            ),
            idempotency_key=idempotency_key,
        )
        task_id = first.task_id
        replay_id = replay["task_id"] if isinstance(replay, dict) else replay.task_id
        assert first_new and not replay_new and task_id == replay_id
        print(f"IDEMPOTENCY first_new={first_new} replay_new={replay_new} same_task=True")

        task = None
        for _ in range(45):
            task = await get_task(pool, task_id)
            if task and task["status"] in {"succeeded", "failed"}:
                break
            await asyncio.sleep(1)
        if not task or task["status"] != "succeeded":
            raise RuntimeError(f"local Worker did not succeed: {task}")
        artifact = await pool.fetchrow(
            """
            SELECT artifact_id, storage_path, file_size_bytes, checksum_sha256
            FROM artifacts WHERE task_id = $1::uuid ORDER BY created_at DESC LIMIT 1
            """,
            task_id,
        )
        if not artifact:
            raise RuntimeError("local Worker succeeded without an Artifact")
        path = Path(str(artifact["storage_path"]))
        stored_sha = hashlib.sha256(path.read_bytes()).hexdigest()
        async with httpx.AsyncClient(base_url=api_url, timeout=30) as client:
            response = await client.get(f"/api/artifacts/{artifact['artifact_id']}")
        response.raise_for_status()
        downloaded_sha = hashlib.sha256(response.content).hexdigest()
        expected_sha = str(artifact["checksum_sha256"])
        assert stored_sha == expected_sha == downloaded_sha
        print(
            "TASK_ATTEMPT_ARTIFACT="
            f"{task['status']}|{task['attempt_count']}|succeeded"
        )
        print(f"ARTIFACT_ID={artifact['artifact_id']}")
        print(f"ARTIFACT_SIZE={artifact['file_size_bytes']}")
        print(f"RECORDED_SHA={expected_sha}")
        print(f"STORED_SHA={stored_sha}")
        print(f"DOWNLOADED_SHA={downloaded_sha}")
    finally:
        await pool.close()


if __name__ == "__main__":
    asyncio.run(main())
