"""Infinity Agent — Task executor.

Orchestrates the full task execution flow: Docker execution,
artifact collection, verification, and result reporting.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import asyncio
from pathlib import Path
from typing import Any, AsyncIterator, Dict, Optional

logger = logging.getLogger(__name__)


async def execute_task(
    task_id: str,
    attempt_id: int,
    task_spec_id: str,
    dataset_snapshot_id: str,
    worker_id: str,
    lease_token: str,
    docker_image: str,
    db_pool,
    redis_client,
    *,
    output_base_dir: str = "/tmp/task-outputs",
    cancel_event: Optional[asyncio.Event] = None,
) -> Dict[str, Any]:
    """Execute a task end-to-end.

    Flow:
    1. Set up working directory
    2. Run Docker container with Claude Code
    3. Collect outputs
    4. Verify outputs
    5. Upload artifacts
    6. Report results
    """
    task_work_dir = Path(output_base_dir) / task_id
    task_output_dir = task_work_dir / "output"
    task_output_dir.mkdir(parents=True, exist_ok=True)

    # Load task spec for context
    task_spec = await _get_task_spec(db_pool, task_spec_id)
    dataset = await _get_dataset(db_pool, dataset_snapshot_id)

    # Report running status
    await _report_status(redis_client, task_id, "running", {
        "attempt_id": attempt_id,
        "worker_id": worker_id,
        "phase": "starting",
    })

    # Run Docker container
    success = False
    error_message = None
    output_files = []
    exit_code = None
    cancelled = False

    try:
        async for event in _run_docker_execution(
            task_id=task_id,
            task_spec=task_spec,
            dataset=dataset,
            docker_image=docker_image,
            work_dir=task_work_dir,
            output_dir=task_output_dir,
            redis_client=redis_client,
            cancel_event=cancel_event,
        ):
            if event["type"] == "status":
                await _report_status(redis_client, task_id, "running", {
                    "phase": event.get("phase", "running"),
                    "worker_id": worker_id,
                })
            elif event["type"] == "chunk":
                await _report_status(redis_client, task_id, "running", {
                    "phase": "executing",
                    "log_chunk": event.get("content", "")[:500],
                    "worker_id": worker_id,
                })
            elif event["type"] == "done":
                success = True
                output_files = await _collect_outputs(task_output_dir)
            elif event["type"] == "error":
                error_message = event.get("message", "Unknown error")
                success = False
            elif event["type"] == "cancelled":
                cancelled = True
                error_message = event.get("message", "Task cancelled by user")
                success = False
                break

    except Exception as exc:
        logger.error("Task %s execution failed: %s", task_id, exc)
        error_message = str(exc)
        success = False

    # Complete the attempt
    from backend.code_agent.task_service import complete_task_attempt
    await complete_task_attempt(
        db_pool,
        attempt_id=attempt_id,
        status="succeeded" if success else "failed",
        exit_code=0 if success else 1,
        error_message=error_message,
    )

    if cancelled:
        return {"success": False, "cancelled": True, "error": error_message}

    if not success:
        return {"success": False, "error": error_message}

    # Verify outputs
    await _report_status(redis_client, task_id, "running", {
        "phase": "verifying",
        "worker_id": worker_id,
    })

    verification = await _verify_outputs(task_output_dir, task_spec)
    if not verification["passed"]:
        return {
            "success": False,
            "error": f"Verification failed: {', '.join(f['message'] for f in verification['failures'])}",
        }

    # Create artifacts
    await _report_status(redis_client, task_id, "running", {
        "phase": "packaging",
        "worker_id": worker_id,
    })

    artifact_id = await _create_artifacts(
        task_id=task_id,
        attempt_id=attempt_id,
        output_dir=task_output_dir,
        output_files=output_files,
        db_pool=db_pool,
    )

    return {"success": True, "artifact_id": artifact_id, "output_files": output_files}


async def _get_task_spec(db_pool, task_spec_id: str) -> Dict[str, Any]:
    """Get task spec from database."""
    from backend.code_agent.task_service import get_task_spec
    spec = await get_task_spec(db_pool, task_spec_id)
    return spec or {}


async def _get_dataset(db_pool, dataset_snapshot_id: str) -> Dict[str, Any]:
    """Get dataset snapshot from database."""
    query = """
        SELECT dataset_snapshot_id, original_filename, stored_path,
               file_size_bytes, file_hash_sha256, metadata, validation_result
        FROM dataset_snapshots
        WHERE dataset_snapshot_id = $1::uuid
    """
    async with db_pool.acquire() as conn:
        row = await conn.fetchrow(query, dataset_snapshot_id)
    if not row:
        return {}
    return {
        "dataset_snapshot_id": str(row["dataset_snapshot_id"]),
        "original_filename": row["original_filename"],
        "stored_path": row["stored_path"],
        "file_size_bytes": row["file_size_bytes"],
        "file_hash_sha256": row["file_hash_sha256"],
        "metadata": dict(row["metadata"]) if row["metadata"] else {},
        "validation_result": dict(row["validation_result"]) if row["validation_result"] else {},
    }


async def _run_docker_execution(
    task_id: str,
    task_spec: Dict[str, Any],
    dataset: Dict[str, Any],
    docker_image: str,
    work_dir: Path,
    output_dir: Path,
    redis_client,
    cancel_event: Optional[asyncio.Event] = None,
) -> AsyncIterator[Dict[str, Any]]:
    """Run the actual Docker execution."""
    from backend.code_agent.worker.docker_runtime import run_docker_task

    # Determine case directory from task spec
    analysis_type = task_spec.get("analysis_type", "")
    case_mapping = {
        "rnaseq_deseq2": "1",
        "biopython": "2",
        "scanpy": "3",
    }
    case_num = case_mapping.get(analysis_type, "")

    # Use the pre-existing case data if available
    case_base = Path(
        os.getenv(
            "CODE_AGENT_CASE_DIR",
            "/Users/zhangyvjing/Library/Mobile Documents/com~apple~CloudDocs/Code/CodeExcuteGoalDriven/GoalDrivenAttempt/test/case",
        )
    )

    case_dir = None
    if case_num and (case_base / case_num).exists():
        case_dir = str(case_base / case_num)

    # Run Docker
    async for event in run_docker_task(
        task_id=task_id,
        task_spec_id=task_spec.get("task_spec_id", ""),
        dataset_snapshot_id=dataset.get("dataset_snapshot_id", ""),
        docker_image=docker_image,
        case_dir=case_dir,
        output_dir=str(output_dir),
        cancel_event=cancel_event,
    ):
        yield event


async def _collect_outputs(output_dir: Path) -> list:
    """Collect list of output files."""
    files = []
    if output_dir.exists():
        for f in output_dir.rglob("*"):
            if f.is_file():
                files.append(str(f.relative_to(output_dir)))
    return files


async def _verify_outputs(output_dir: Path, task_spec: Dict[str, Any]) -> Dict[str, Any]:
    """Verify that required deliverables exist and are valid.

    Uses the five-level verifier for comprehensive validation.
    Falls back to basic checks if the verifier is unavailable.
    """
    try:
        from backend.code_agent.verifier import verify_outputs
        return verify_outputs(output_dir, task_spec)
    except Exception as exc:
        logger.warning("Five-level verifier failed, using fallback: %s", exc)
        # Fallback to basic file existence checks
        failures = []
        deliverables = task_spec.get("spec_json", {}).get("deliverables", [])

        for deliverable in deliverables:
            path = deliverable.get("path", "")
            required = deliverable.get("required", True)
            min_bytes = deliverable.get("min_bytes", 0)

            if not path:
                continue

            file_path = output_dir / path
            if not file_path.exists():
                if required:
                    failures.append(f"Missing required deliverable: {path}")
            elif min_bytes and file_path.stat().st_size < min_bytes:
                failures.append(f"Deliverable too small: {path} ({file_path.stat().st_size} < {min_bytes} bytes)")

        return {"passed": len(failures) == 0, "failures": failures}


async def _create_artifacts(
    task_id: str,
    attempt_id: int,
    output_dir: Path,
    output_files: list,
    db_pool,
) -> str:
    """Create artifact records and manifest."""
    from backend.code_agent.task_service import create_artifact
    import zipfile

    artifact_id = f"artifact-{task_id[:8]}"

    # Create manifest
    manifest = {
        "task_id": task_id,
        "attempt_id": attempt_id,
        "generated_at": __import__("datetime").datetime.now().isoformat(),
        "files": [],
    }

    # Create ZIP archive
    zip_path = output_dir.parent / f"result-{task_id[:8]}.zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for rel_path in output_files:
            file_path = output_dir / rel_path
            if file_path.exists():
                zf.write(file_path, rel_path)
                file_hash = hashlib.sha256(file_path.read_bytes()).hexdigest()
                manifest["files"].append({
                    "path": rel_path,
                    "size": file_path.stat().st_size,
                    "sha256": file_hash,
                })

    # Register artifact
    from backend.code_agent.models import Artifact
    artifact_obj = Artifact(
        artifact_id=artifact_id,
        task_id=task_id,
        task_attempt_id=attempt_id,
        name="result",
        kind="result_archive",
        storage_backend="local",
        storage_path=str(zip_path),
        file_size_bytes=zip_path.stat().st_size if zip_path.exists() else 0,
        checksum_sha256=hashlib.sha256(zip_path.read_bytes()).hexdigest() if zip_path.exists() else "",
        content_type="application/zip",
        metadata={"file_count": len(output_files), "manifest": manifest},
    )
    artifact = await create_artifact(db_pool, artifact_obj)

    logger.info("Created artifact %s for task %s with %d files", artifact_id, task_id, len(output_files))
    return artifact_id


async def _report_status(redis_client, task_id: str, status: str, data: Dict[str, Any]) -> None:
    """Report task status to Redis for SSE consumption."""
    await redis_client.publish_task_event(task_id, {
        "event_type": f"task_{status}",
        **data,
    })
    await redis_client.set_progress(task_id, {"status": status, **data})
