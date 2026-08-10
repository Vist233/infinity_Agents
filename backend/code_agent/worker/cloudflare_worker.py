"""Cloudflare-control-plane Docker Worker.

This Worker runs on the user's machine and keeps all provider/Redis settings
local.  Cloudflare D1 is reached only through the authenticated Worker Control
API; it is not treated as a PostgreSQL endpoint.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import platform
import re
import signal
import shutil
import uuid
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, Optional
from urllib.parse import urljoin, urlparse

import requests

logger = logging.getLogger(__name__)

_MAX_ERROR_LENGTH = 500
_SAFE_NAME = re.compile(r"[^A-Za-z0-9._-]+")


def _required(name: str, *aliases: str) -> str:
    for key in (name, *aliases):
        value = os.getenv(key, "").strip()
        if value:
            return value
    raise SystemExit(f"{name} is required")


def _optional(name: str, *aliases: str) -> Optional[str]:
    for key in (name, *aliases):
        value = os.getenv(key, "").strip()
        if value:
            return value
    return None


def _bool_env(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _safe_error(value: Any) -> str:
    text = str(value or "")
    text = re.sub(r"(password|passwd|secret|token|key)\s*[=:]\s*\S+", "[redacted]", text, flags=re.I)
    text = re.sub(r"(postgresql|redis|mysql|mongodb)://[^\s]+", "[redacted]", text, flags=re.I)
    return text[:_MAX_ERROR_LENGTH]


@dataclass
class CloudflareWorkerConfig:
    control_url: str
    worker_id: str
    namespace: str
    credential: str
    instance_id: str
    redis_url: Optional[str]
    redis_namespace: str
    anthropic_api_key: Optional[str]
    anthropic_auth_token: Optional[str]
    anthropic_base_url: Optional[str]
    anthropic_model: Optional[str]
    docker_image: str = "claude-code-env:v2"
    work_root: Path = Path("/workspace/task-workdirs")
    output_root: Path = Path("/workspace/task-outputs")
    poll_interval: float = 5.0
    version: str = "cloudflare-docker-worker/1"
    redis_required: bool = True
    session_id: Optional[str] = None
    heartbeat_interval: float = 30.0
    capabilities: list[str] = field(default_factory=list)

    @classmethod
    def from_env(cls) -> "CloudflareWorkerConfig":
        control_url = _required("CONTROL_BASE_URL", "WORKER_CONTROL_URL", "CF_DATABASE_URL").rstrip("/")
        parsed = urlparse(control_url)
        if parsed.scheme != "https" or not parsed.netloc:
            raise SystemExit("CONTROL_BASE_URL must be an HTTPS Cloudflare Worker control URL")
        worker_id = _required("WORKER_ID")
        namespace = _required("WORKER_NAMESPACE", "REDIS_NAMESPACE")
        credential = _required("WORKER_CREDENTIAL", "WORKER_API_KEY")
        if any(char.isspace() for char in worker_id + namespace + credential):
            raise SystemExit("WORKER_ID, WORKER_NAMESPACE and WORKER_CREDENTIAL cannot contain whitespace")
        redis_url = _optional("REDIS_URL")
        provider_key = _optional("ANTHROPIC_API_KEY")
        provider_token = _optional("ANTHROPIC_AUTH_TOKEN")
        provider_base = _optional("ANTHROPIC_BASE_URL")
        provider_model = _optional("ANTHROPIC_MODEL")
        capabilities = ["cloudflare-docker-worker-v1", os.name, "docker"]
        if redis_url:
            capabilities.append("redis-configured")
        if provider_key or provider_token:
            capabilities.append("provider-configured")
        return cls(
            control_url=control_url,
            worker_id=worker_id,
            namespace=namespace,
            credential=credential,
            instance_id=_optional("WORKER_INSTANCE_ID") or f"{platform.node()}-{uuid.uuid4()}",
            redis_url=redis_url,
            redis_namespace=_optional("REDIS_NAMESPACE") or namespace,
            anthropic_api_key=provider_key,
            anthropic_auth_token=provider_token,
            anthropic_base_url=provider_base,
            anthropic_model=provider_model,
            docker_image=os.getenv("CODE_AGENT_DOCKER_IMAGE", "claude-code-env:v2").strip(),
            work_root=Path(os.getenv("WORKER_WORK_ROOT", "/workspace/task-workdirs")),
            output_root=Path(os.getenv("WORKER_OUTPUT_ROOT", "/workspace/task-outputs")),
            poll_interval=max(1.0, float(os.getenv("WORKER_POLL_INTERVAL", "5"))),
            version=os.getenv("WORKER_VERSION", "cloudflare-docker-worker/1").strip(),
            redis_required=_bool_env("WORKER_REDIS_REQUIRED", True),
            capabilities=capabilities,
        )


class ControlPlaneError(RuntimeError):
    def __init__(self, message: str, status: int, code: str | None = None):
        super().__init__(message)
        self.status = status
        self.code = code


class CloudflareControlClient:
    def __init__(self, config: CloudflareWorkerConfig):
        self.config = config
        self.session = requests.Session()

    def _headers(self, *, epoch: int | None = None) -> dict[str, str]:
        headers = {
            "accept": "application/json",
            "authorization": f"Bearer {self.config.credential}",
        }
        if self.config.session_id:
            headers["x-worker-session"] = self.config.session_id
        if epoch is not None:
            headers["x-fencing-epoch"] = str(epoch)
        return headers

    def _request(self, method: str, path_or_url: str, *, json_body: Any = None,
                 epoch: int | None = None, timeout: float = 30.0, **kwargs: Any) -> Any:
        url = path_or_url if path_or_url.startswith("https://") else urljoin(f"{self.config.control_url}/", path_or_url.lstrip("/"))
        response = self.session.request(
            method,
            url,
            headers=self._headers(epoch=epoch),
            json=json_body,
            timeout=timeout,
            **kwargs,
        )
        try:
            payload = response.json()
        except ValueError:
            payload = {"raw": response.text[:500]}
        if not response.ok:
            error = payload.get("error") if isinstance(payload, dict) else None
            message = error.get("message") if isinstance(error, dict) else None
            code = error.get("code") if isinstance(error, dict) else None
            raise ControlPlaneError(message or f"HTTP {response.status_code}", response.status_code, code)
        return payload

    async def connect(self) -> dict[str, Any]:
        response = await asyncio.to_thread(
            self._request,
            "POST",
            "/api/worker/v1/connect",
            json_body={
                "worker_id": self.config.worker_id,
                "namespace": self.config.namespace,
                "instance_id": self.config.instance_id,
                "version": self.config.version,
                "capabilities": self.config.capabilities,
                "redis_configured": bool(self.config.redis_url),
                "provider_configured": bool(self.config.anthropic_api_key or self.config.anthropic_auth_token),
                "provider_model": self.config.anthropic_model,
            },
        )
        self.config.session_id = str(response["session_id"])
        self.config.heartbeat_interval = max(5.0, float(response.get("heartbeat_interval_seconds", 30)))
        return response

    async def heartbeat(self) -> dict[str, Any]:
        return await asyncio.to_thread(self._request, "POST", "/api/worker/v1/heartbeat", json_body={})

    async def health(self) -> dict[str, Any]:
        return await asyncio.to_thread(self._request, "GET", "/api/worker/v1/health")

    async def poll(self) -> dict[str, Any]:
        return await asyncio.to_thread(
            self._request,
            "POST",
            "/api/worker/v1/poll",
            json_body={"available_slots": 1, "capabilities": self.config.capabilities},
        )

    async def accept(self, offer_id: str) -> dict[str, Any]:
        return await asyncio.to_thread(
            self._request,
            "POST",
            f"/api/worker/v1/offers/{offer_id}/accept",
            json_body={},
        )

    async def heartbeat_attempt(self, attempt_id: str, epoch: int, progress: str) -> dict[str, Any]:
        return await asyncio.to_thread(
            self._request,
            "POST",
            f"/api/worker/v1/attempts/{attempt_id}/heartbeat",
            json_body={"fencing_epoch": epoch, "progress": progress},
        )

    async def fail_attempt(self, attempt_id: str, epoch: int, message: str) -> dict[str, Any]:
        return await asyncio.to_thread(
            self._request,
            "POST",
            f"/api/worker/v1/attempts/{attempt_id}/fail",
            json_body={
                "fencing_epoch": epoch,
                "error_code": "worker_runtime_error",
                "error_message": _safe_error(message),
                "retryable": False,
            },
        )

    async def download_resource(self, url: str, destination: Path, epoch: int) -> None:
        parsed_url = urlparse(url)
        control_origin = urlparse(self.config.control_url)
        if (parsed_url.scheme, parsed_url.netloc) != (control_origin.scheme, control_origin.netloc):
            raise ControlPlaneError("Resource URL is outside the Worker control origin", 400, "RESOURCE_ORIGIN_MISMATCH")

        def _download() -> None:
            destination.parent.mkdir(parents=True, exist_ok=True)
            with self.session.get(url, headers=self._headers(epoch=epoch), timeout=60, stream=True) as response:
                if not response.ok:
                    raise ControlPlaneError(f"Resource download failed: HTTP {response.status_code}", response.status_code)
                with destination.open("wb") as handle:
                    for chunk in response.iter_content(chunk_size=1024 * 1024):
                        if chunk:
                            handle.write(chunk)

        await asyncio.to_thread(_download)

    async def upload_artifact(self, attempt_id: str, epoch: int, archive: Path) -> dict[str, Any]:
        def _upload() -> dict[str, Any]:
            with archive.open("rb") as handle:
                return self._request(
                    "POST",
                    f"/api/worker/v1/attempts/{attempt_id}/artifacts",
                    epoch=epoch,
                    data={"fencing_epoch": str(epoch)},
                    files={"file": (archive.name, handle, "application/zip")},
                )

        return await asyncio.to_thread(_upload)

    async def finalize(self, task_id: str, attempt_id: str, epoch: int, artifact_id: str, checksum: str) -> dict[str, Any]:
        return await asyncio.to_thread(
            self._request,
            "POST",
            f"/api/worker/v1/attempts/{attempt_id}/finalize",
            json_body={
                "fencing_epoch": epoch,
                "artifact_id": artifact_id,
                "manifest": {
                    "task_id": task_id,
                    "attempt_id": attempt_id,
                    "fencing_epoch": epoch,
                    "checksum_sha256": checksum,
                },
            },
        )

    async def disconnect(self) -> None:
        if not self.config.session_id:
            return
        try:
            await asyncio.to_thread(self._request, "POST", "/api/worker/v1/disconnect", json_body={})
        finally:
            self.config.session_id = None


async def _redis_ping(config: CloudflareWorkerConfig) -> bool:
    if not config.redis_url:
        if config.redis_required:
            raise RuntimeError("REDIS_URL is required for this Worker")
        return False
    try:
        from redis.asyncio import Redis

        client = Redis.from_url(config.redis_url, socket_connect_timeout=5, socket_timeout=5)
        try:
            await client.ping()
        finally:
            await client.aclose()
        return True
    except Exception as exc:
        if config.redis_required:
            raise RuntimeError(f"Redis health check failed: {_safe_error(exc)}") from exc
        logger.warning("Redis health check failed; continuing because it is optional: %s", _safe_error(exc))
        return False


def _safe_filename(value: str, fallback: str) -> str:
    name = Path(value or fallback).name
    name = _SAFE_NAME.sub("_", name).strip("._")
    return name[:180] or fallback


def _zip_output(output_dir: Path, task_id: str) -> tuple[Path, str]:
    output_dir.mkdir(parents=True, exist_ok=True)
    archive = output_dir.parent / f"{task_id}-artifacts.zip"
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as bundle:
        for path in sorted(output_dir.rglob("*")):
            if path.is_file():
                bundle.write(path, path.relative_to(output_dir).as_posix())
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    return archive, digest


class CloudflareDockerWorker:
    def __init__(self, config: CloudflareWorkerConfig):
        self.config = config
        self.control = CloudflareControlClient(config)
        self.stop_event = asyncio.Event()

    def stop(self) -> None:
        self.stop_event.set()

    async def run_forever(self) -> None:
        self.config.work_root.mkdir(parents=True, exist_ok=True)
        self.config.output_root.mkdir(parents=True, exist_ok=True)
        redis_connected = await _redis_ping(self.config)
        if redis_connected:
            self.config.capabilities.append("redis-online")
        logger.info("Connecting Worker %s in namespace %s", self.config.worker_id, self.config.namespace)
        await self.control.connect()
        logger.info("Worker %s connected", self.config.worker_id)
        try:
            while not self.stop_event.is_set():
                try:
                    await self.control.heartbeat()
                    payload = await self.control.poll()
                    offers = payload.get("offers", []) if isinstance(payload, dict) else []
                    if offers:
                        attempt = await self.control.accept(str(offers[0]["offer_id"]))
                        await self._execute_attempt(attempt)
                    else:
                        await asyncio.wait_for(self.stop_event.wait(), timeout=self.config.poll_interval)
                except asyncio.TimeoutError:
                    continue
                except ControlPlaneError as exc:
                    if exc.code in {"WORKER_SESSION_LOST", "WORKER_SESSION_REQUIRED", "WORKER_ALREADY_CONNECTED"}:
                        logger.warning("Worker control session needs reconnect: %s", _safe_error(exc))
                        await asyncio.sleep(2)
                        await self.control.connect()
                    else:
                        logger.warning("Worker control request failed: %s", _safe_error(exc))
                        await asyncio.sleep(self.config.poll_interval)
                except Exception as exc:
                    logger.warning("Worker loop error: %s", _safe_error(exc))
                    await asyncio.sleep(self.config.poll_interval)
        finally:
            await self.control.disconnect()

    async def _execute_attempt(self, attempt: dict[str, Any]) -> None:
        from backend.code_agent.worker.docker_runtime import run_docker_task

        task_id = str(attempt.get("task_id", ""))
        attempt_id = str(attempt.get("attempt_id", ""))
        task_spec_id = str(attempt.get("task_spec_id", ""))
        dataset_snapshot_id = str(attempt.get("dataset_snapshot_id", ""))
        epoch = int(attempt.get("fencing_epoch", 0))
        if not task_id or not attempt_id or epoch < 1:
            raise RuntimeError("Cloudflare Attempt payload is incomplete")
        task_root = self.config.work_root / task_id
        input_dir = task_root / "input"
        output_dir = self.config.output_root / task_id
        if task_root.exists():
            shutil.rmtree(task_root)
        if output_dir.exists():
            shutil.rmtree(output_dir)
        input_dir.mkdir(parents=True, exist_ok=True)
        output_dir.mkdir(parents=True, exist_ok=True)

        try:
            for resource in attempt.get("resources", []):
                resource_id = str(resource.get("resource_id", "resource"))
                kind = _safe_filename(str(resource.get("kind", "input")), "input")
                logical_name = _safe_filename(str(resource.get("logical_name", resource_id)), resource_id)
                destination = input_dir / f"{kind}-{logical_name}"
                await self.control.download_resource(str(resource["url"]), destination, epoch)

            cancel_event = asyncio.Event()

            async def heartbeat_loop() -> None:
                while not cancel_event.is_set():
                    try:
                        await asyncio.wait_for(cancel_event.wait(), timeout=max(5.0, self.config.heartbeat_interval / 2))
                    except asyncio.TimeoutError:
                        await self.control.heartbeat_attempt(attempt_id, epoch, "executing")

            heartbeat_task = asyncio.create_task(heartbeat_loop())
            try:
                async for event in run_docker_task(
                    task_id=task_id,
                    task_spec_id=task_spec_id,
                    dataset_snapshot_id=dataset_snapshot_id,
                    docker_image=self.config.docker_image,
                    case_dir=input_dir,
                    output_dir=output_dir,
                    cancel_event=cancel_event,
                ):
                    if event.get("type") == "error":
                        raise RuntimeError(str(event.get("message", "Docker execution failed")))
            finally:
                cancel_event.set()
                heartbeat_task.cancel()
                try:
                    await heartbeat_task
                except asyncio.CancelledError:
                    pass

            archive, checksum = _zip_output(output_dir, task_id)
            uploaded = await self.control.upload_artifact(attempt_id, epoch, archive)
            artifact_id = str(uploaded["artifact_id"])
            # The control API binds the manifest to the attempt. Add the task
            # identifier here because it is the final anti-confusion check.
            await asyncio.to_thread(
                self.control._request,
                "POST",
                f"/api/worker/v1/attempts/{attempt_id}/finalize",
                json_body={
                    "fencing_epoch": epoch,
                    "artifact_id": artifact_id,
                    "manifest": {
                        "task_id": task_id,
                        "attempt_id": attempt_id,
                        "fencing_epoch": epoch,
                        "checksum_sha256": checksum,
                    },
                },
            )
            logger.info("Worker %s finalized Attempt %s", self.config.worker_id, attempt_id)
        except Exception as exc:
            logger.error("Attempt %s failed: %s", attempt_id, _safe_error(exc))
            try:
                await self.control.fail_attempt(attempt_id, epoch, _safe_error(exc))
            except Exception as report_error:
                logger.warning("Could not report Attempt failure: %s", _safe_error(report_error))


async def _main() -> None:
    logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO").upper(), format="%(asctime)s %(levelname)s %(message)s")
    config = CloudflareWorkerConfig.from_env()
    worker = CloudflareDockerWorker(config)
    loop = asyncio.get_running_loop()
    for signal_name in ("SIGTERM", "SIGINT"):
        if hasattr(signal, signal_name):
            try:
                loop.add_signal_handler(getattr(signal, signal_name), worker.stop)
            except (NotImplementedError, RuntimeError):
                # Windows event loops may not support POSIX signal handlers.
                pass
    await worker.run_forever()


if __name__ == "__main__":
    asyncio.run(_main())
