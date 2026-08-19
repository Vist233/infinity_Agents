"""Infinity Agents unified Worker task executor.

Production tasks use the fixed Claude Code runtime directly in the long-lived
Worker container. There is no nested-Docker or fixture execution branch.
"""

from __future__ import annotations

import logging
import os
import asyncio
import shutil
import uuid
import re
import hashlib
from pathlib import Path
from typing import Any, AsyncIterator, Dict, Optional
from urllib.parse import urlparse

from backend.security import ArtifactCollector, SecurityBoundaryError, validate_outbound_url

logger = logging.getLogger(__name__)


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        return default


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        return default


def _validated_control_plane_url(value: str) -> str:
    """Validate the URL that receives Worker credentials and task data."""
    candidate = str(value or "").strip().rstrip("/")
    if not candidate:
        raise SecurityBoundaryError("Worker control-plane URL is empty")
    hostname = (urlparse(candidate).hostname or "").lower().rstrip(".")
    local_hosts = {"localhost", "127.0.0.1", "::1", "api", "host.docker.internal"}
    allow_http_local = (
        hostname in local_hosts
        and os.getenv("APP_ENV", "development").lower() in {"development", "dev", "test", "acceptance"}
    )
    if os.getenv("WORKER_ALLOW_HTTP_LOCAL", "0").strip().lower() in {"1", "true", "yes", "on"}:
        allow_http_local = hostname in local_hosts
    return validate_outbound_url(
        candidate,
        allow_hosts=local_hosts,
        allow_http_local=allow_http_local,
    ).rstrip("/")


def _worker_transfer_timeout():
    """Use finite, configurable timeouts for large remote transfers."""
    import httpx

    seconds = max(30.0, min(_env_float("WORKER_TRANSFER_TIMEOUT_SECONDS", 600.0), 3600.0))
    return httpx.Timeout(connect=15.0, read=seconds, write=seconds, pool=15.0)


def _worker_identity_headers(
    *,
    worker_id: str,
    worker_namespace: str,
    worker_credential: str,
    worker_instance_id: Optional[str] = None,
    worker_protocol_version: Optional[str] = None,
    worker_runtime_capability: Optional[str] = None,
    worker_image_digest: Optional[str] = None,
) -> Dict[str, str]:
    """Build machine headers without adding optional legacy-test fields."""
    headers = {
        "X-Worker-ID": worker_id,
        "X-Worker-Namespace": worker_namespace,
        "X-Worker-Credential": worker_credential,
    }
    if worker_instance_id:
        headers.update({
            "X-Worker-Instance-ID": worker_instance_id,
            "X-Worker-Protocol-Version": worker_protocol_version or "",
            "X-Worker-Runtime-Capability": worker_runtime_capability or "",
        })
        if worker_image_digest:
            headers["X-Worker-Image-Digest"] = worker_image_digest
    return headers


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
    method_source_id: Optional[str] = None,
    output_base_dir: Optional[str] = None,
    cancel_event: Optional[asyncio.Event] = None,
    worker_namespace: Optional[str] = None,
    worker_credential: Optional[str] = None,
    control_plane_url: Optional[str] = None,
    worker_instance_id: Optional[str] = None,
    worker_protocol_version: Optional[str] = None,
    worker_runtime_capability: Optional[str] = None,
    worker_image_digest: Optional[str] = None,
) -> Dict[str, Any]:
    """Execute a task end-to-end.

    Flow:
    1. Set up an attempt-local working directory
    2. Run the single fixed Claude Code runtime in this Worker container
    3. Apply deterministic output safety/finalize checks
    4. Upload the artifact with lease/fencing protection
    5. Report the result and clear the attempt directory
    """
    if output_base_dir is None:
        # Shared with the API server's ARTIFACT_DOWNLOAD_ROOT so artifacts
        # written by the worker are downloadable from the host. The compose
        # stack mounts ./workspace at /workspace for exactly this reason.
        output_base_dir = os.getenv("ARTIFACT_STORAGE_ROOT", "/workspace/task-outputs")
    raw_control_plane_url = control_plane_url or os.getenv("WORKER_CONTROL_PLANE_URL") or os.getenv("CONTROL_PLANE_URL") or ""
    control_plane_url = _validated_control_plane_url(raw_control_plane_url) if raw_control_plane_url.strip() else None
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}", str(task_id)):
        raise ValueError("invalid task ID for worker workspace")
    output_root = Path(output_base_dir).resolve()
    task_work_dir = (output_root / str(task_id)).resolve()
    if not task_work_dir.is_relative_to(output_root):
        raise ValueError("task workspace escaped the output root")
    task_output_dir = task_work_dir / "output"
    task_output_dir.mkdir(parents=True, exist_ok=True)

    # Load task spec for context
    task_spec = await _get_task_spec(db_pool, task_spec_id)
    dataset = await _get_dataset(db_pool, dataset_snapshot_id)
    method_source = None
    if method_source_id:
        from backend.code_agent.task_service import get_method_source
        method_source = await get_method_source(db_pool, method_source_id)

    # Report running status
    await _report_status(redis_client, task_id, "running", {
        "attempt_id": attempt_id,
        "worker_id": worker_id,
        "phase": "starting",
    })

    # Run Claude Code directly in this Worker container.
    success = False
    error_message = None
    failure_code = None
    output_files = []
    cancelled = False
    image_digest = await _get_image_digest(docker_image)

    try:
        async for event in _run_claude_execution(
            task_id=task_id,
            attempt_id=attempt_id,
            task_spec=task_spec,
            dataset=dataset,
            method_source=method_source,
            work_dir=task_work_dir,
            output_dir=task_output_dir,
            redis_client=redis_client,
            cancel_event=cancel_event,
            worker_id=worker_id,
            worker_namespace=worker_namespace,
            worker_credential=worker_credential,
            control_plane_url=control_plane_url,
            worker_instance_id=worker_instance_id,
            worker_protocol_version=worker_protocol_version,
            worker_runtime_capability=worker_runtime_capability,
            worker_image_digest=worker_image_digest,
            lease_token=lease_token,
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
                failure_code = event.get("failure_code", "execution_error")
                success = False
            elif event["type"] == "cancelled":
                cancelled = True
                error_message = event.get("message", "Task cancelled by user")
                success = False
                break

    except Exception as exc:
        logger.error("Task %s execution failed: %s", task_id, exc)
        error_message = str(exc)
        failure_code = "execution_error"
        success = False

    from backend.code_agent.task_service import complete_task_attempt

    # Execution success is not Task success. Keep the Attempt open until the
    # deterministic artifact safety and lease/fencing gates have completed so
    # a missing deliverable cannot leave a misleading succeeded Attempt.
    if not success:
        await complete_task_attempt(
            db_pool,
            attempt_id=attempt_id,
            status="cancelled" if cancelled else "failed",
            task_id=task_id,
            lease_token=lease_token,
            exit_code=1,
            error_message=error_message,
            executor_image_digest=image_digest,
            failure_code=failure_code,
        )
        _cleanup_execution_workspace(task_work_dir)

    if cancelled:
        return {"success": False, "cancelled": True, "error": error_message}

    if not success:
        return {"success": False, "error": error_message, "failure_code": failure_code}

    # Deterministic output safety checks. There is no independent Verifier
    # service in the unified architecture.
    await _report_status(redis_client, task_id, "running", {
        "phase": "verifying",
        "worker_id": worker_id,
    })

    validation = await _validate_outputs(task_output_dir, task_spec)
    if not validation["passed"]:
        failure_messages = ", ".join(
            str(item.get("message", item)) if isinstance(item, dict) else str(item)
            for item in validation.get("failures", [])
        )
        await complete_task_attempt(
            db_pool,
            attempt_id=attempt_id,
            status="failed",
            task_id=task_id,
            lease_token=lease_token,
            exit_code=0,
            error_message=f"Output validation failed: {failure_messages}",
            executor_image_digest=image_digest,
            failure_code="verification_failed",
        )
        _cleanup_execution_workspace(task_work_dir)
        return {
            "success": False,
            "error": f"Verification failed: {failure_messages}",
            "failure_code": "output_validation_failed",
        }

    # Create artifacts
    await _report_status(redis_client, task_id, "running", {
        "phase": "packaging",
        "worker_id": worker_id,
    })

    artifact_id = ""
    try:
        artifact_id = await _create_artifacts(
            task_id=task_id,
            attempt_id=attempt_id,
            output_dir=task_output_dir,
            output_files=output_files,
            db_pool=db_pool,
            lease_token=lease_token,
            worker_id=worker_id,
            worker_namespace=worker_namespace,
            worker_credential=worker_credential,
            control_plane_url=control_plane_url,
            worker_instance_id=worker_instance_id,
            worker_protocol_version=worker_protocol_version,
            worker_runtime_capability=worker_runtime_capability,
            worker_image_digest=worker_image_digest,
        )
    except Exception as exc:
        await complete_task_attempt(
            db_pool,
            attempt_id=attempt_id,
            status="failed",
            task_id=task_id,
            lease_token=lease_token,
            exit_code=0,
            error_message=str(exc),
            executor_image_digest=image_digest,
            failure_code="artifact_publish_failed",
        )
        _cleanup_execution_workspace(task_work_dir)
        raise

    try:
        await complete_task_attempt(
            db_pool,
            attempt_id=attempt_id,
            status="succeeded",
            task_id=task_id,
            lease_token=lease_token,
            exit_code=0,
            executor_image_digest=image_digest,
        )
    except Exception:
        await _compensate_published_artifact(
            artifact_id=artifact_id,
            task_id=task_id,
            attempt_id=attempt_id,
            lease_token=lease_token,
            db_pool=db_pool,
            control_plane_url=control_plane_url,
            worker_id=worker_id,
            worker_namespace=worker_namespace,
            worker_credential=worker_credential,
            worker_instance_id=worker_instance_id,
            worker_protocol_version=worker_protocol_version,
            worker_runtime_capability=worker_runtime_capability,
            worker_image_digest=worker_image_digest,
        )
        _cleanup_execution_workspace(task_work_dir)
        raise

    # The result archive is the durable downloadable artifact.  Input files,
    # unpacked datasets, and Claude's scratch output are disposable and must
    # not accumulate across the long-lived Worker loop.
    _cleanup_execution_workspace(task_work_dir, preserve_artifact=not bool(control_plane_url))

    return {"success": True, "artifact_id": artifact_id, "output_files": output_files}


async def _compensate_published_artifact(
    *,
    artifact_id: str,
    task_id: str,
    attempt_id: int,
    lease_token: str,
    db_pool,
    control_plane_url: Optional[str],
    worker_id: Optional[str],
    worker_namespace: Optional[str],
    worker_credential: Optional[str],
    worker_instance_id: Optional[str] = None,
    worker_protocol_version: Optional[str] = None,
    worker_runtime_capability: Optional[str] = None,
    worker_image_digest: Optional[str] = None,
) -> None:
    """Best-effort lease-bound cleanup for an artifact/result race."""
    if not artifact_id:
        return
    try:
        if control_plane_url and worker_id and worker_namespace and worker_credential:
            import httpx
            headers = _worker_identity_headers(
                worker_id=worker_id,
                worker_namespace=worker_namespace,
                worker_credential=worker_credential,
                worker_instance_id=worker_instance_id,
                worker_protocol_version=worker_protocol_version,
                worker_runtime_capability=worker_runtime_capability,
                worker_image_digest=worker_image_digest,
            )
            headers.update({
                "X-Worker-Lease-Token": lease_token,
                "X-Worker-Attempt-ID": str(attempt_id),
            })
            async with httpx.AsyncClient(timeout=_worker_transfer_timeout(), follow_redirects=False) as client:
                response = await client.delete(
                    f"{control_plane_url}/api/worker/tasks/{task_id}/artifacts/{artifact_id}",
                    headers=headers,
                )
            if response.status_code >= 400:
                logger.warning("Artifact compensation was rejected (%s)", response.status_code)
            return
        from backend.code_agent.task_service import delete_artifact_if_current_lease
        deleted = await delete_artifact_if_current_lease(
            db_pool, artifact_id, task_id, attempt_id, lease_token, worker_id=worker_id
        )
        if deleted:
            storage_path = Path(str(deleted.get("storage_path") or ""))
            root = Path(os.getenv("ARTIFACT_STORAGE_ROOT", "/workspace/task-outputs")).resolve()
            resolved = storage_path.resolve(strict=False)
            if resolved.is_relative_to(root) and not storage_path.is_symlink():
                resolved.unlink(missing_ok=True)
    except Exception:
        logger.exception("Artifact compensation failed for %s", artifact_id)


def _cleanup_execution_workspace(task_work_dir: Path, *, preserve_artifact: bool = False) -> None:
    """Remove task-local secrets and scratch data after publication.

    A successful task keeps only ``result-*.zip`` for the API's download
    path.  Failed/cancelled tasks remove the entire task directory.
    """
    if not task_work_dir.exists():
        return
    if not preserve_artifact:
        shutil.rmtree(task_work_dir, ignore_errors=True)
        return
    for child in (task_work_dir / "input", task_work_dir / "output"):
        if child.exists():
            shutil.rmtree(child, ignore_errors=True)


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
    from backend.code_agent.task_service import _jsonb_to_dict
    return {
        "dataset_snapshot_id": str(row["dataset_snapshot_id"]),
        "original_filename": row["original_filename"],
        "stored_path": row["stored_path"],
        "file_size_bytes": row["file_size_bytes"],
        "file_hash_sha256": row["file_hash_sha256"],
        "metadata": _jsonb_to_dict(row["metadata"]),
        "validation_result": _jsonb_to_dict(row["validation_result"]),
    }


async def _request_attempt_gateway(
    *,
    task_id: str,
    attempt_id: int,
    worker_id: Optional[str],
    worker_namespace: Optional[str],
    worker_credential: Optional[str],
    lease_token: Optional[str],
    control_plane_url: Optional[str],
    worker_instance_id: Optional[str] = None,
    worker_protocol_version: Optional[str] = None,
    worker_runtime_capability: Optional[str] = None,
    worker_image_digest: Optional[str] = None,
) -> Dict[str, str]:
    """Acquire the current Attempt's short-lived model capability.

    The Worker authenticates with its persistent machine credential, but only
    receives a revocable Attempt token.  A preconfigured ``ATTEMPT_*`` tuple is
    retained for isolated development runs; normal remote/local Workers must
    use the control-plane endpoint so provider keys stay server-side.
    """
    if not control_plane_url:
        if os.getenv("APP_ENV", "development").lower() not in {"development", "dev", "test"}:
            raise SecurityBoundaryError(
                "A control-plane Attempt gateway is required outside development/test"
            )
        values = {
            "gateway_url": os.getenv("ATTEMPT_GATEWAY_URL", "").strip(),
            "gateway_token": os.getenv("ATTEMPT_GATEWAY_TOKEN", "").strip(),
            "model_id": os.getenv("ATTEMPT_MODEL_ID", "").strip(),
        }
        if all(values.values()):
            return values
        raise SecurityBoundaryError("Attempt model gateway is not configured")
    if not worker_id or not worker_namespace or not worker_credential or not lease_token:
        raise SecurityBoundaryError("Worker identity is required for an Attempt gateway grant")
    import httpx

    headers = _worker_identity_headers(
        worker_id=worker_id,
        worker_namespace=worker_namespace,
        worker_credential=worker_credential,
        worker_instance_id=worker_instance_id,
        worker_protocol_version=worker_protocol_version,
        worker_runtime_capability=worker_runtime_capability,
        worker_image_digest=worker_image_digest,
    )
    headers.update({
        "X-Worker-Lease-Token": lease_token,
        "X-Worker-Attempt-ID": str(attempt_id),
    })
    url = f"{control_plane_url.rstrip('/')}/api/worker/tasks/{task_id}/attempts/{attempt_id}/gateway"
    try:
        async with httpx.AsyncClient(timeout=_worker_transfer_timeout(), follow_redirects=False) as client:
            response = await client.post(url, headers=headers)
    except Exception as exc:
        raise SecurityBoundaryError("Attempt model gateway could not be reached") from exc
    if response.status_code >= 400:
        raise SecurityBoundaryError(
            f"Attempt model gateway rejected the lease ({response.status_code})"
        )
    try:
        payload = response.json()
    except ValueError as exc:
        raise SecurityBoundaryError("Attempt model gateway returned invalid data") from exc
    values = {
        "gateway_url": str(payload.get("gateway_url") or "").strip(),
        "gateway_token": str(payload.get("gateway_token") or "").strip(),
        "model_id": str(payload.get("model_id") or "").strip(),
    }
    if not all(values.values()):
        raise SecurityBoundaryError("Attempt model gateway response is incomplete")
    return values


async def _run_claude_execution(
    task_id: str,
    attempt_id: int,
    task_spec: Dict[str, Any],
    dataset: Dict[str, Any],
    method_source: Optional[Dict[str, Any]],
    work_dir: Path,
    output_dir: Path,
    redis_client,
    cancel_event: Optional[asyncio.Event] = None,
    worker_id: Optional[str] = None,
    worker_namespace: Optional[str] = None,
    worker_credential: Optional[str] = None,
    control_plane_url: Optional[str] = None,
    lease_token: Optional[str] = None,
    worker_instance_id: Optional[str] = None,
    worker_protocol_version: Optional[str] = None,
    worker_runtime_capability: Optional[str] = None,
    worker_image_digest: Optional[str] = None,
) -> AsyncIterator[Dict[str, Any]]:
    """Run the single production Claude Code execution mode."""
    input_dir = None
    executor_mode = os.getenv("CODE_AGENT_EXECUTOR_MODE", "direct").strip().lower() or "direct"
    if executor_mode != "direct":
        raise SecurityBoundaryError(
            f"Unsupported executor mode {executor_mode!r}; the unified Worker only supports direct Claude Code"
        )

    # Preferred path: assemble the task input directory from the uploaded
    # method source document + dataset snapshot (design doc §8.5).
    if (dataset and dataset.get("stored_path")) or (
        method_source and method_source.get("stored_path")
    ):
        input_dir = work_dir / "input"
        input_dir.mkdir(parents=True, exist_ok=True)
        if dataset and dataset.get("stored_path"):
            dataset_path = Path(dataset["stored_path"])
            if dataset_path.is_file() and _inside_upload_roots(dataset_path):
                _assert_frozen_input(dataset_path, dataset, "dataset")
                _stage_dataset(dataset_path, input_dir / "data", logical_name=dataset.get("original_filename"))
            elif control_plane_url and worker_id and worker_namespace and worker_credential:
                downloaded = await _download_remote_input(
                    control_plane_url,
                    task_id,
                    "dataset",
                    worker_id=worker_id,
                    worker_namespace=worker_namespace,
                    worker_credential=worker_credential,
                    lease_token=lease_token or "",
                    worker_instance_id=worker_instance_id,
                    worker_protocol_version=worker_protocol_version,
                    worker_runtime_capability=worker_runtime_capability,
                    worker_image_digest=worker_image_digest,
                    destination=work_dir / "remote-input" / (Path(dataset.get("original_filename") or "dataset.zip").name),
                )
                _assert_frozen_input(downloaded, dataset, "dataset")
                _stage_dataset(downloaded, input_dir / "data", logical_name=dataset.get("original_filename"), trusted_local=True)
            else:
                raise SecurityBoundaryError("dataset input is not available to this Worker")
        if method_source and method_source.get("stored_path"):
            src = Path(method_source["stored_path"])
            # Same upload-root confinement as datasets (defense in depth).
            if src.exists() and _inside_upload_roots(src):
                _assert_frozen_input(src, method_source, "execution document")
                shutil.copy2(src, input_dir / src.name)
            elif control_plane_url and worker_id and worker_namespace and worker_credential:
                method_name = Path(method_source.get("original_filename") or "execution-document.bin").name
                await _download_remote_input(
                    control_plane_url,
                    task_id,
                    "method",
                    worker_id=worker_id,
                    worker_namespace=worker_namespace,
                    worker_credential=worker_credential,
                    lease_token=lease_token or "",
                    worker_instance_id=worker_instance_id,
                    worker_protocol_version=worker_protocol_version,
                    worker_runtime_capability=worker_runtime_capability,
                    worker_image_digest=worker_image_digest,
                    destination=work_dir / "remote-input" / method_name,
                )
                downloaded_method = work_dir / "remote-input" / method_name
                _assert_frozen_input(downloaded_method, method_source, "execution document")
                shutil.copy2(downloaded_method, input_dir / method_name)
            else:
                raise SecurityBoundaryError("execution document is not available to this Worker")

    from backend.code_agent.worker.claude_runtime import run_claude_task

    if input_dir is None:
        input_dir = work_dir / "input"
        input_dir.mkdir(parents=True, exist_ok=True)
    gateway = await _request_attempt_gateway(
        task_id=task_id,
        attempt_id=attempt_id,
        worker_id=worker_id,
        worker_namespace=worker_namespace,
        worker_credential=worker_credential,
        lease_token=lease_token,
        control_plane_url=control_plane_url,
        worker_instance_id=worker_instance_id,
        worker_protocol_version=worker_protocol_version,
        worker_runtime_capability=worker_runtime_capability,
        worker_image_digest=worker_image_digest,
    )
    async for event in run_claude_task(
        task_id=task_id,
        task_spec_id=task_spec.get("task_spec_id", ""),
        dataset_snapshot_id=dataset.get("dataset_snapshot_id", "") if dataset else "",
        title=task_spec.get("title", ""),
        goal=task_spec.get("research_question") or task_spec.get("goal") or "",
        analysis_type=task_spec.get("analysis_type", "generic"),
        case_dir=str(input_dir),
        output_dir=output_dir,
        cancel_event=cancel_event,
        attempt_gateway_url=gateway["gateway_url"],
        attempt_gateway_token=gateway["gateway_token"],
        attempt_model_id=gateway["model_id"],
    ):
        yield event


def _inside_upload_roots(path: Path) -> bool:
    """True only if the resolved path lives inside a known upload root."""
    allowed_roots = [
        Path(os.getenv("DATASET_UPLOAD_ROOT", "/tmp/uploaded-datasets")).resolve(),
        Path(os.getenv("METHOD_SOURCE_UPLOAD_ROOT", "/tmp/uploaded-method-sources")).resolve(),
        Path(os.getenv("RESOURCE_STORAGE_ROOT", "/workspace/resources")).resolve(),
    ]
    try:
        resolved = path.resolve()
        return any(resolved.is_relative_to(root) for root in allowed_roots)
    except OSError:
        return False


def _assert_frozen_input(path: Path, metadata: Dict[str, Any], label: str) -> None:
    """Fail closed if a Worker input differs from its frozen DB snapshot."""
    if path.is_symlink() or not path.is_file():
        raise SecurityBoundaryError(f"{label} input is not a regular file")
    expected_size = metadata.get("file_size_bytes")
    expected_hash = metadata.get("file_hash_sha256")
    actual_size = path.stat().st_size
    if expected_size is not None and int(expected_size) != actual_size:
        raise SecurityBoundaryError(f"{label} input size does not match the frozen snapshot")
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    if expected_hash and digest.hexdigest() != str(expected_hash):
        raise SecurityBoundaryError(f"{label} input hash does not match the frozen snapshot")


def _stage_dataset(
    stored_path: Path,
    dest_dir: Path,
    *,
    logical_name: Optional[str] = None,
    trusted_local: bool = False,
) -> None:
    """Copy or safely extract the dataset snapshot into the input dir."""
    import zipfile

    # Defense in depth: even though the API validates stored_path against the
    # upload roots, the worker must never mount arbitrary filesystem paths.
    if not trusted_local and not _inside_upload_roots(stored_path):
        logger.warning("Refusing to stage dataset outside upload roots: %s", stored_path)
        raise SecurityBoundaryError("dataset path is outside the Worker upload roots")

    if not stored_path.exists():
        logger.warning("Dataset stored_path does not exist: %s", stored_path)
        return
    dest_dir.mkdir(parents=True, exist_ok=True)

    if Path(logical_name or stored_path.name).suffix.lower() == ".zip":
        base = dest_dir.resolve()
        with zipfile.ZipFile(stored_path, "r") as zf:
            max_entries = _env_int("DATASET_ZIP_MAX_ENTRIES", 10000)
            max_file_bytes = _env_int("DATASET_ZIP_MAX_FILE_BYTES", 5 * 1024**3)
            max_total_bytes = _env_int("DATASET_ZIP_MAX_UNCOMPRESSED_BYTES", 10 * 1024**3)
            max_ratio = _env_float("DATASET_ZIP_MAX_COMPRESSION_RATIO", 200.0)
            infos = zf.infolist()
            if not infos or len(infos) > max_entries:
                raise SecurityBoundaryError("ZIP entry count exceeds the configured limit")
            total_bytes = 0
            for info in infos:
                # Block path traversal inside the archive. is_relative_to
                # avoids the classic startswith("...data") vs "...data2"
                # prefix-match bypass.
                safe_name = info.filename.replace("\\", "/")
                if safe_name.startswith("/") or any(part == ".." for part in safe_name.split("/")):
                    raise SecurityBoundaryError(f"ZIP contains path traversal: {info.filename}")
                mode = (info.external_attr >> 16) & 0o170000
                if mode and mode != 0o100000 and not info.is_dir():
                    raise SecurityBoundaryError(f"ZIP contains a special file: {info.filename}")
                if not info.is_dir():
                    if info.file_size > max_file_bytes:
                        raise SecurityBoundaryError("ZIP contains an oversized file")
                    total_bytes += info.file_size
                    if total_bytes > max_total_bytes:
                        raise SecurityBoundaryError("ZIP expands beyond the configured limit")
                    compressed_size = max(info.compress_size, 1)
                    if info.file_size and info.file_size / compressed_size > max_ratio:
                        raise SecurityBoundaryError("ZIP compression ratio exceeds the configured limit")
                target = (base / safe_name).resolve()
                if not target.is_relative_to(base):
                    raise SecurityBoundaryError(f"ZIP entry escapes staging root: {info.filename}")
                zf.extract(info, dest_dir)
    elif stored_path.is_file():
        shutil.copy2(stored_path, dest_dir / stored_path.name)
    elif stored_path.is_dir():
        shutil.copytree(stored_path, dest_dir / stored_path.name, dirs_exist_ok=True)


async def _download_remote_input(
    control_plane_url: str,
    task_id: str,
    kind: str,
    *,
    worker_id: str,
    worker_namespace: str,
    worker_credential: str,
    lease_token: str,
    destination: Path,
    worker_instance_id: Optional[str] = None,
    worker_protocol_version: Optional[str] = None,
    worker_runtime_capability: Optional[str] = None,
    worker_image_digest: Optional[str] = None,
) -> Path:
    """Download one input through the authenticated control-plane transfer API."""
    if not lease_token:
        raise SecurityBoundaryError("Worker lease token is unavailable for input transfer")
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(f".{destination.name}.{uuid.uuid4().hex}.part")
    headers = _worker_identity_headers(
        worker_id=worker_id,
        worker_namespace=worker_namespace,
        worker_credential=worker_credential,
        worker_instance_id=worker_instance_id,
        worker_protocol_version=worker_protocol_version,
        worker_runtime_capability=worker_runtime_capability,
        worker_image_digest=worker_image_digest,
    )
    headers["X-Worker-Lease-Token"] = lease_token
    import httpx
    try:
        timeout = _worker_transfer_timeout()
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=False) as client:
            async with client.stream("GET", f"{control_plane_url}/api/worker/tasks/{task_id}/inputs/{kind}", headers=headers) as response:
                if response.status_code >= 400:
                    raise SecurityBoundaryError(f"control-plane input transfer failed ({response.status_code})")
                max_bytes = int(os.getenv("WORKER_INPUT_MAX_BYTES", str(10 * 1024**3)))
                total = 0
                with temporary.open("wb") as handle:
                    async for chunk in response.aiter_bytes(1024 * 1024):
                        total += len(chunk)
                        if total > max_bytes:
                            raise SecurityBoundaryError("remote input exceeds the Worker limit")
                        handle.write(chunk)
        temporary.replace(destination)
        return destination
    except Exception:
        temporary.unlink(missing_ok=True)
        raise


async def _get_image_digest(docker_image: str) -> Optional[str]:
    """Read the immutable image digest supplied by deployment metadata.

    The unified image has no Docker CLI and must not inspect a host daemon.
    """
    configured = (
        os.getenv("WORKER_IMAGE_DIGEST", "").strip()
        or os.getenv("CODE_AGENT_IMAGE_DIGEST", "").strip()
    )
    return configured or None


async def _collect_outputs(output_dir: Path) -> list:
    """Collect only ordinary files under output root.

    The collector intentionally performs the lstat/path/secret checks before
    verifier or ZIP code can read a byte.
    """
    collector = ArtifactCollector(
        max_files=int(os.getenv("ARTIFACT_MAX_FILES", "5000")),
        max_file_bytes=int(os.getenv("ARTIFACT_MAX_FILE_BYTES", str(512 * 1024 * 1024))),
        max_total_bytes=int(os.getenv("ARTIFACT_MAX_TOTAL_BYTES", str(2 * 1024 * 1024 * 1024))),
    )
    return [relative for _path, relative in collector._iter_files(output_dir)]


async def _validate_outputs(output_dir: Path, task_spec: Dict[str, Any]) -> Dict[str, Any]:
    """Apply deterministic data-plane checks before artifact finalization.

    Scientific correctness belongs in the frozen TaskSpec/Case manifest and
    downstream review. This function enforces only data-plane invariants:
    output exists, declared required paths exist, and every candidate is a
    regular file inside the output root.
    """
    failures: list[dict[str, str]] = []
    if not output_dir.exists() or not output_dir.is_dir():
        return {"passed": False, "failures": [{"message": "output directory is missing"}]}
    try:
        collector = ArtifactCollector(
            max_files=int(os.getenv("ARTIFACT_MAX_FILES", "5000")),
            max_file_bytes=int(os.getenv("ARTIFACT_MAX_FILE_BYTES", str(512 * 1024 * 1024))),
            max_total_bytes=int(os.getenv("ARTIFACT_MAX_TOTAL_BYTES", str(2 * 1024 * 1024 * 1024))),
        )
        files = list(collector._iter_files(output_dir))
    except (OSError, SecurityBoundaryError) as exc:
        return {"passed": False, "failures": [{"message": str(exc)}]}
    if not files:
        failures.append({"message": "Claude Code produced no output artifacts"})
    spec_json = task_spec.get("spec_json") if isinstance(task_spec, dict) else None
    required_outputs = spec_json.get("required_outputs", []) if isinstance(spec_json, dict) else []
    present = {str(relative) for _path, relative in files}
    if isinstance(required_outputs, list):
        for required in required_outputs:
            required_name = str(required).strip().lstrip("/")
            if required_name and required_name not in present:
                failures.append({"message": f"required output is missing: {required_name}"})
    return {"passed": not failures, "failures": failures}


async def _create_artifacts(
    task_id: str,
    attempt_id: int,
    output_dir: Path,
    output_files: list,
    db_pool,
    lease_token: Optional[str] = None,
    worker_id: Optional[str] = None,
    worker_namespace: Optional[str] = None,
    worker_credential: Optional[str] = None,
    control_plane_url: Optional[str] = None,
    worker_instance_id: Optional[str] = None,
    worker_protocol_version: Optional[str] = None,
    worker_runtime_capability: Optional[str] = None,
    worker_image_digest: Optional[str] = None,
) -> str:
    """Create artifact records and manifest."""
    from backend.code_agent.task_service import create_artifact, create_artifact_if_current_lease
    artifact_id = f"artifact-{uuid.uuid4()}"
    zip_path = output_dir.parent / f"result-{task_id[:8]}.zip"
    collector = ArtifactCollector(
        max_files=int(os.getenv("ARTIFACT_MAX_FILES", "5000")),
        max_file_bytes=int(os.getenv("ARTIFACT_MAX_FILE_BYTES", str(512 * 1024 * 1024))),
        max_total_bytes=int(os.getenv("ARTIFACT_MAX_TOTAL_BYTES", str(2 * 1024 * 1024 * 1024))),
    )
    collected = collector.collect(
        output_dir,
        zip_path,
        metadata={"task_id": task_id, "attempt_id": attempt_id},
    )
    manifest = collected.manifest

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
        file_size_bytes=collected.archive_path.stat().st_size,
        checksum_sha256=collected.checksum_sha256,
        content_type="application/zip",
        metadata={"file_count": collected.file_count, "byte_count": collected.byte_count, "manifest": manifest},
    )
    if control_plane_url and worker_id and worker_namespace and worker_credential:
        return await _upload_remote_artifact(
            control_plane_url,
            task_id,
            attempt_id,
            artifact_id,
            collected.archive_path,
            archive_checksum=collected.checksum_sha256,
            worker_id=worker_id,
            worker_namespace=worker_namespace,
            worker_credential=worker_credential,
            lease_token=lease_token or "",
            worker_instance_id=worker_instance_id,
            worker_protocol_version=worker_protocol_version,
            worker_runtime_capability=worker_runtime_capability,
            worker_image_digest=worker_image_digest,
        )
    if lease_token:
        artifact = await create_artifact_if_current_lease(
            db_pool, artifact_obj, lease_token, worker_id=worker_id
        )
        if artifact is None:
            raise RuntimeError("task lease was lost before artifact publication")
    else:
        artifact = await create_artifact(db_pool, artifact_obj)

    logger.info("Created artifact %s for task %s with %d files", artifact_id, task_id, collected.file_count)
    return artifact_id


async def _upload_remote_artifact(
    control_plane_url: str,
    task_id: str,
    attempt_id: int,
    artifact_id: str,
    archive_path: Path,
    *,
    archive_checksum: Optional[str] = None,
    worker_id: str,
    worker_namespace: str,
    worker_credential: str,
    lease_token: str,
    worker_instance_id: Optional[str] = None,
    worker_protocol_version: Optional[str] = None,
    worker_runtime_capability: Optional[str] = None,
    worker_image_digest: Optional[str] = None,
) -> str:
    """Upload a result archive to the API before the Worker forgets its scratch path."""
    if not lease_token:
        raise SecurityBoundaryError("Worker lease token is unavailable for artifact transfer")
    threshold = max(1, _env_int("ARTIFACT_MULTIPART_THRESHOLD_BYTES", 30 * 1024 * 1024))
    if archive_path.stat().st_size > threshold:
        if not archive_checksum:
            raise SecurityBoundaryError("multipart artifact transfer requires an archive checksum")
        return await _upload_remote_artifact_multipart(
            control_plane_url,
            task_id,
            attempt_id,
            artifact_id,
            archive_path,
            archive_checksum=archive_checksum,
            worker_id=worker_id,
            worker_namespace=worker_namespace,
            worker_credential=worker_credential,
            lease_token=lease_token,
            worker_instance_id=worker_instance_id,
            worker_protocol_version=worker_protocol_version,
            worker_runtime_capability=worker_runtime_capability,
            worker_image_digest=worker_image_digest,
        )
    import httpx
    headers = _worker_identity_headers(
        worker_id=worker_id,
        worker_namespace=worker_namespace,
        worker_credential=worker_credential,
        worker_instance_id=worker_instance_id,
        worker_protocol_version=worker_protocol_version,
        worker_runtime_capability=worker_runtime_capability,
        worker_image_digest=worker_image_digest,
    )
    headers.update({
        "X-Worker-Lease-Token": lease_token,
        "X-Worker-Attempt-ID": str(attempt_id),
        "X-Worker-Artifact-ID": artifact_id,
        "Content-Type": "application/zip",
        "Content-Length": str(archive_path.stat().st_size),
    })
    if archive_checksum:
        headers["X-Worker-Artifact-SHA256"] = archive_checksum
    timeout = _worker_transfer_timeout()
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=False) as client:
        class _ArchiveStream(httpx.AsyncByteStream):
            """Stream the archive without handing a synchronous file to httpx."""

            def __init__(self, path: Path, chunk_size: int = 1024 * 1024):
                self.path = path
                self.chunk_size = chunk_size

            async def __aiter__(self):
                handle = await asyncio.to_thread(self.path.open, "rb")
                try:
                    while True:
                        chunk = await asyncio.to_thread(handle.read, self.chunk_size)
                        if not chunk:
                            break
                        yield chunk
                finally:
                    await asyncio.to_thread(handle.close)

            async def aclose(self) -> None:
                return None

        response = await client.post(
            f"{control_plane_url}/api/worker/tasks/{task_id}/artifacts",
            headers=headers,
            content=_ArchiveStream(archive_path),
        )
    if response.status_code >= 400:
        raise SecurityBoundaryError(f"control-plane artifact upload failed ({response.status_code})")
    try:
        payload = response.json()
    except ValueError as exc:
        raise SecurityBoundaryError("control-plane artifact response is invalid") from exc
    if str(payload.get("artifact_id")) != artifact_id:
        raise SecurityBoundaryError("control-plane artifact ID mismatch")
    return artifact_id


def _hash_file_range(path: Path, offset: int, length: int) -> str:
    """Hash one bounded archive range without retaining it in memory."""
    hasher = hashlib.sha256()
    remaining = length
    with path.open("rb") as handle:
        handle.seek(offset)
        while remaining:
            chunk = handle.read(min(1024 * 1024, remaining))
            if not chunk:
                raise SecurityBoundaryError("archive changed while preparing multipart upload")
            hasher.update(chunk)
            remaining -= len(chunk)
    return hasher.hexdigest()


async def _upload_remote_artifact_multipart(
    control_plane_url: str,
    task_id: str,
    attempt_id: int,
    artifact_id: str,
    archive_path: Path,
    *,
    archive_checksum: str,
    worker_id: str,
    worker_namespace: str,
    worker_credential: str,
    lease_token: str,
    worker_instance_id: Optional[str] = None,
    worker_protocol_version: Optional[str] = None,
    worker_runtime_capability: Optional[str] = None,
    worker_image_digest: Optional[str] = None,
) -> str:
    """Upload a large archive in server-sized parts, then finalize it."""
    import httpx

    archive_size = archive_path.stat().st_size
    if archive_size <= 0 or not re.fullmatch(r"[0-9a-f]{64}", archive_checksum.lower()):
        raise SecurityBoundaryError("multipart artifact metadata is invalid")
    identity = _worker_identity_headers(
        worker_id=worker_id,
        worker_namespace=worker_namespace,
        worker_credential=worker_credential,
        worker_instance_id=worker_instance_id,
        worker_protocol_version=worker_protocol_version,
        worker_runtime_capability=worker_runtime_capability,
        worker_image_digest=worker_image_digest,
    )
    identity.update({
        "X-Worker-Lease-Token": lease_token,
        "X-Worker-Attempt-ID": str(attempt_id),
        "X-Worker-Artifact-ID": artifact_id,
    })
    timeout = _worker_transfer_timeout()
    upload_id: Optional[str] = None

    class _ArchivePartStream(httpx.AsyncByteStream):
        def __init__(self, path: Path, offset: int, length: int, chunk_size: int = 1024 * 1024):
            self.path = path
            self.offset = offset
            self.length = length
            self.chunk_size = chunk_size

        async def __aiter__(self):
            handle = await asyncio.to_thread(self.path.open, "rb")
            try:
                await asyncio.to_thread(handle.seek, self.offset)
                remaining = self.length
                while remaining:
                    chunk = await asyncio.to_thread(handle.read, min(self.chunk_size, remaining))
                    if not chunk:
                        raise SecurityBoundaryError("archive changed during multipart transfer")
                    remaining -= len(chunk)
                    yield chunk
            finally:
                await asyncio.to_thread(handle.close)

        async def aclose(self) -> None:
            return None

    try:
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=False) as client:
            start_headers = {
                **identity,
                "X-Worker-Artifact-SHA256": archive_checksum.lower(),
                "X-Worker-Artifact-Size": str(archive_size),
            }
            response = await client.post(
                f"{control_plane_url}/api/worker/tasks/{task_id}/artifact-uploads",
                headers=start_headers,
            )
            if response.status_code >= 400:
                raise SecurityBoundaryError(f"control-plane multipart start failed ({response.status_code})")
            try:
                start_payload = response.json()
                upload_id = str(start_payload["upload_id"])
                part_size = int(start_payload["part_size_bytes"])
                part_count = int(start_payload["part_count"])
            except (ValueError, KeyError, TypeError) as exc:
                raise SecurityBoundaryError("control-plane multipart start response is invalid") from exc
            if not upload_id or part_size <= 0 or part_count <= 0:
                raise SecurityBoundaryError("control-plane multipart part contract is invalid")
            expected_count = (archive_size + part_size - 1) // part_size
            if part_count != expected_count:
                raise SecurityBoundaryError("control-plane multipart part count is invalid")

            for part_number in range(part_count):
                offset = part_number * part_size
                length = min(part_size, archive_size - offset)
                if length <= 0:
                    raise SecurityBoundaryError("control-plane multipart part size is invalid")
                part_checksum = await asyncio.to_thread(_hash_file_range, archive_path, offset, length)
                part_headers = {
                    **identity,
                    "X-Worker-Part-SHA256": part_checksum,
                    "Content-Type": "application/octet-stream",
                    "Content-Length": str(length),
                }
                response = await client.put(
                    f"{control_plane_url}/api/worker/tasks/{task_id}/artifact-uploads/{upload_id}/parts/{part_number}",
                    headers=part_headers,
                    content=_ArchivePartStream(archive_path, offset, length),
                )
                if response.status_code >= 400:
                    raise SecurityBoundaryError(
                        f"control-plane multipart part {part_number} failed ({response.status_code})"
                    )

            response = await client.post(
                f"{control_plane_url}/api/worker/tasks/{task_id}/artifact-uploads/{upload_id}/complete",
                headers=identity,
            )
            if response.status_code >= 400:
                raise SecurityBoundaryError(f"control-plane multipart finalize failed ({response.status_code})")
            try:
                payload = response.json()
            except ValueError as exc:
                raise SecurityBoundaryError("control-plane multipart finalize response is invalid") from exc
            if str(payload.get("artifact_id")) != artifact_id:
                raise SecurityBoundaryError("control-plane multipart artifact ID mismatch")
            if str(payload.get("checksum_sha256", archive_checksum)).lower() != archive_checksum.lower():
                raise SecurityBoundaryError("control-plane multipart artifact checksum mismatch")
            if int(payload.get("file_size_bytes", archive_size)) != archive_size:
                raise SecurityBoundaryError("control-plane multipart artifact size mismatch")
            return artifact_id
    except SecurityBoundaryError:
        if upload_id:
            await _abort_remote_artifact_multipart(
                control_plane_url,
                task_id,
                upload_id,
                identity,
            )
        raise
    except Exception as exc:
        if upload_id:
            await _abort_remote_artifact_multipart(
                control_plane_url,
                task_id,
                upload_id,
                identity,
            )
        raise SecurityBoundaryError("control-plane multipart artifact transfer failed") from exc


async def _abort_remote_artifact_multipart(
    control_plane_url: str,
    task_id: str,
    upload_id: str,
    identity: Dict[str, str],
) -> None:
    """Best-effort cleanup after a failed multipart transfer."""
    import httpx

    try:
        async with httpx.AsyncClient(timeout=_worker_transfer_timeout(), follow_redirects=False) as client:
            response = await client.delete(
                f"{control_plane_url}/api/worker/tasks/{task_id}/artifact-uploads/{upload_id}",
                headers=identity,
            )
            if response.status_code >= 400:
                logger.warning("Multipart cleanup was rejected (%s)", response.status_code)
    except Exception:
        logger.warning("Multipart cleanup failed", exc_info=True)


async def _report_status(redis_client, task_id: str, status: str, data: Dict[str, Any]) -> None:
    """Report task status to Redis for SSE consumption."""
    await redis_client.publish_task_event(task_id, {
        "event_type": f"task_{status}",
        **data,
    })
    await redis_client.set_progress(task_id, {"status": status, **data})
