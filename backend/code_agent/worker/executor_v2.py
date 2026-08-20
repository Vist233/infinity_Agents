"""D1 Worker v2 task executor.

The executor receives a frozen TaskSpec through HTTPS, runs the platform-owned
Goal-Driven Claude Code runtime, uploads one durable result Artifact through
R2 multipart, and deletes its attempt directory. It has no SQL or Redis data
client and no verifier stage.
"""

from __future__ import annotations

import asyncio
import logging
import os
import shutil
from pathlib import Path
from typing import Any, Mapping

from backend.code_agent.worker.claude_runtime import run_claude_task
from backend.code_agent.worker.control_plane import ClaimedTask, ControlPlaneError, WorkerV2Client
from backend.security import ArtifactCollector, SecurityBoundaryError

logger = logging.getLogger(__name__)


class TaskCancelledDuringPublish(ControlPlaneError):
    """Cancellation won before the Artifact reached its fenced finalize."""


def _safe_name(value: Any, fallback: str) -> str:
    name = Path(str(value or "")).name.strip()
    if not name or name in {".", ".."} or len(name) > 240 or "\x00" in name:
        return fallback
    return name


def _workspace_root() -> Path:
    return Path(os.getenv("WORKER_WORK_ROOT", "/workspace/task-workdirs")).resolve()


def _timeout_seconds() -> float:
    try:
        return max(60.0, min(float(os.getenv("WORKER_TASK_TIMEOUT_SECONDS", str(12 * 60 * 60))), 24 * 60 * 60))
    except ValueError:
        return float(12 * 60 * 60)


async def _renew_until_cancelled(
    client: WorkerV2Client,
    claim: ClaimedTask,
    stop: asyncio.Event,
    cancel: asyncio.Event,
    lost: asyncio.Event,
) -> None:
    while not stop.is_set():
        try:
            await asyncio.wait_for(stop.wait(), timeout=20.0)
            continue
        except asyncio.TimeoutError:
            pass
        try:
            await client.renew(claim)
            spec = await client.spec(claim)
            if bool(spec.get("cancel_requested")):
                cancel.set()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            lost.set()
            cancel.set()
            logger.warning("Worker lost the D1 lease for %s: %s", claim.task_id, type(exc).__name__)
            return


async def _download_inputs(client: WorkerV2Client, claim: ClaimedTask, spec: Mapping[str, Any], input_dir: Path) -> None:
    inputs = spec.get("inputs") if isinstance(spec.get("inputs"), Mapping) else {}
    method = inputs.get("method") if isinstance(inputs, Mapping) else None
    dataset = inputs.get("dataset") if isinstance(inputs, Mapping) else None
    if isinstance(method, Mapping):
        await client.download_input(
            claim,
            "method",
            input_dir / _safe_name(method.get("logical_name"), "execution-document.bin"),
            method,
        )
    if isinstance(dataset, Mapping):
        await client.download_input(
            claim,
            "dataset",
            input_dir / _safe_name(dataset.get("logical_name"), "dataset.bin"),
            dataset,
        )


def _require_publishable(cancel: asyncio.Event, lost: asyncio.Event) -> None:
    if lost.is_set():
        raise ControlPlaneError("Worker lease was lost during Artifact publication")
    if cancel.is_set():
        raise TaskCancelledDuringPublish("Task cancelled during Artifact publication")


async def _upload_result(
    client: WorkerV2Client,
    claim: ClaimedTask,
    archive: Path,
    manifest: Mapping[str, Any],
    checksum: str,
    cancel: asyncio.Event,
    lost: asyncio.Event,
) -> dict[str, Any]:
    _require_publishable(cancel, lost)
    size = archive.stat().st_size
    started = await client.start_artifact(
        claim,
        name="result.zip",
        kind="result_archive",
        content_type="application/zip",
        size=size,
        sha256=checksum,
        manifest=manifest,
    )
    upload_id = str(started.get("upload_id") or "")
    part_size = int(started.get("part_size_bytes") or 0)
    if not upload_id or part_size <= 0:
        raise ControlPlaneError("D1 Worker v2 returned an invalid multipart contract")
    parts: list[dict[str, Any]] = []
    offset = 0
    part_number = 1
    while offset < size:
        _require_publishable(cancel, lost)
        length = min(part_size, size - offset)
        uploaded = await client.upload_artifact_part(
            claim,
            upload_id,
            part_number,
            archive,
            offset,
            length,
            progress_check=lambda: _require_publishable(cancel, lost),
        )
        parts.append({"part_number": part_number, "etag": str(uploaded.get("etag") or "")})
        if not parts[-1]["etag"]:
            raise ControlPlaneError("D1 Worker v2 returned an empty artifact ETag")
        offset += length
        part_number += 1
    _require_publishable(cancel, lost)
    completed = await client.complete_artifact(claim, upload_id, parts)
    if str(completed.get("checksum_sha256") or checksum).lower() != checksum:
        raise ControlPlaneError("D1 Worker v2 returned an invalid artifact checksum")
    if int(completed.get("file_size_bytes") or size) != size:
        raise ControlPlaneError("D1 Worker v2 returned an invalid artifact size")
    return completed


async def execute_claim(client: WorkerV2Client, claim: ClaimedTask) -> dict[str, Any]:
    root = (_workspace_root() / claim.task_id / claim.attempt_id).resolve()
    if not root.is_relative_to(_workspace_root()):
        raise SecurityBoundaryError("Worker task path escaped the configured workspace")
    input_dir = root / "input"
    output_dir = root / "output"
    archive = root / "result.zip"
    input_dir.mkdir(parents=True, exist_ok=True)
    output_dir.mkdir(parents=True, exist_ok=True)
    cancel = asyncio.Event()
    stop = asyncio.Event()
    lost = asyncio.Event()
    renew_task = asyncio.create_task(_renew_until_cancelled(client, claim, stop, cancel, lost))
    try:
        spec_response = await client.spec(claim)
        task_spec = spec_response.get("task_spec") if isinstance(spec_response.get("task_spec"), Mapping) else {}
        await _download_inputs(client, claim, spec_response, input_dir)
        runtime_error: dict[str, Any] | None = None
        async for event in run_claude_task(
            task_id=claim.task_id,
            task_spec_id=claim.task_spec_id,
            dataset_snapshot_id=claim.dataset_snapshot_id,
            title=str(task_spec.get("title") or claim.title),
            goal=str(task_spec.get("goal") or task_spec.get("research_question") or ""),
            analysis_type=str(task_spec.get("analysis_type") or "generic"),
            case_dir=str(input_dir),
            output_dir=str(output_dir),
            cancel_event=cancel,
            timeout_seconds=_timeout_seconds(),
        ):
            if event.get("type") in {"error", "cancelled"}:
                runtime_error = event
                break
        if lost.is_set():
            raise ControlPlaneError("Worker lease was lost during Claude execution")
        if runtime_error:
            cancelled = runtime_error.get("type") == "cancelled" or cancel.is_set()
            await client.finish(
                claim,
                cancelled=cancelled,
                error_code=str(runtime_error.get("failure_code") or ("cancelled" if cancelled else "execution_error")),
                error_message=str(runtime_error.get("message") or "Claude Code execution failed"),
            )
            return {"success": False, "cancelled": cancelled, "error": runtime_error.get("message")}

        collector = ArtifactCollector(
            max_files=int(os.getenv("ARTIFACT_MAX_FILES", "5000")),
            max_file_bytes=int(os.getenv("ARTIFACT_MAX_FILE_BYTES", str(512 * 1024 * 1024))),
            max_total_bytes=int(os.getenv("ARTIFACT_MAX_TOTAL_BYTES", str(2 * 1024 * 1024 * 1024))),
        )
        collected = await asyncio.to_thread(
            collector.collect,
            output_dir,
            archive,
            metadata={"task_id": claim.task_id, "attempt_id": claim.attempt_id},
            progress_check=lambda: _require_publishable(cancel, lost),
        )
        _require_publishable(cancel, lost)
        completed = await _upload_result(
            client,
            claim,
            archive,
            collected.manifest,
            collected.checksum_sha256,
            cancel,
            lost,
        )
        return {"success": True, "artifact_id": completed.get("artifact_id"), "checksum_sha256": collected.checksum_sha256}
    except TaskCancelledDuringPublish as exc:
        if not lost.is_set():
            try:
                await client.finish(claim, cancelled=True, error_code="cancelled", error_message=str(exc))
            except Exception:
                logger.warning("D1 Worker v2 failed to record task cancellation for %s", claim.task_id)
        return {"success": False, "cancelled": True, "error": str(exc)}
    except Exception as exc:
        if not lost.is_set():
            try:
                await client.finish(claim, error_code="worker_execution_failed", error_message=str(exc))
            except Exception:
                logger.warning("D1 Worker v2 failed to record task failure for %s", claim.task_id)
        return {"success": False, "error": str(exc)}
    finally:
        stop.set()
        renew_task.cancel()
        try:
            await renew_task
        except asyncio.CancelledError:
            pass
        shutil.rmtree(root, ignore_errors=True)
