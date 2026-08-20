"""HTTP clients for the D1 Worker v2 control plane and Redis Relay.

This module is the only runtime data-plane client used by the new Docker
Worker. It deliberately has no SQL driver and no Redis driver. D1/R2 operations
go through the Cloudflare Worker; Redis is visible only through fixed HTTPS
hint records from the Relay.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, AsyncIterator, Callable, Mapping
from urllib.parse import urlparse

import httpx

from backend.security import SecurityBoundaryError, validate_outbound_url

logger = logging.getLogger(__name__)

PROTOCOL_VERSION = "2"
RUNTIME_CAPABILITY = "goal-driven-claude-code"
WORKER_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")
MAX_INPUT_BYTES = 25 * 1024 * 1024
MAX_ERROR_LENGTH = 500


def _timeout() -> httpx.Timeout:
    try:
        seconds = float(os.getenv("WORKER_TRANSFER_TIMEOUT_SECONDS", "600"))
    except ValueError:
        seconds = 600.0
    seconds = max(30.0, min(seconds, 3600.0))
    return httpx.Timeout(connect=15.0, read=seconds, write=seconds, pool=15.0)


def validated_control_plane_url(value: str) -> str:
    candidate = str(value or "").strip().rstrip("/")
    if not candidate:
        raise SecurityBoundaryError("WORKER_CONTROL_PLANE_URL is required")
    parsed = urlparse(candidate)
    local_hosts = {"localhost", "127.0.0.1", "::1", "host.docker.internal", "api"}
    allow_local_http = (
        (parsed.hostname or "").lower() in local_hosts
        and os.getenv("APP_ENV", "production").lower() in {"development", "dev", "test", "acceptance"}
    )
    return validate_outbound_url(candidate, allow_hosts=local_hosts, allow_http_local=allow_local_http).rstrip("/")


def validated_relay_url(value: str) -> str:
    candidate = str(value or "").strip().rstrip("/")
    if not candidate:
        raise SecurityBoundaryError("WORKER_RELAY_URL is required")
    parsed = urlparse(candidate)
    local_hosts = {"localhost", "127.0.0.1", "::1", "host.docker.internal", "redis-relay"}
    allow_local_http = (
        (parsed.hostname or "").lower() in local_hosts
        and os.getenv("APP_ENV", "production").lower() in {"development", "dev", "test", "acceptance"}
    )
    return validate_outbound_url(candidate, allow_hosts=local_hosts, allow_http_local=allow_local_http).rstrip("/")


class ControlPlaneError(RuntimeError):
    def __init__(self, message: str, *, status_code: int | None = None, code: str | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code


def _bounded_error(response: httpx.Response) -> ControlPlaneError:
    code = None
    message = f"control plane request failed ({response.status_code})"
    try:
        payload = response.json()
        error = payload.get("error") if isinstance(payload, dict) else None
        if isinstance(error, dict):
            code = str(error.get("code") or "")[:80] or None
            message = str(error.get("message") or message).replace("\x00", " ")[:MAX_ERROR_LENGTH]
    except (ValueError, TypeError):
        pass
    return ControlPlaneError(message, status_code=response.status_code, code=code)


@dataclass(frozen=True)
class WorkerSession:
    session_id: str
    session_epoch: int
    pool_id: str
    namespace: str
    lease_expires_at: int


@dataclass(frozen=True)
class ClaimedTask:
    task_id: str
    task_spec_id: str
    dataset_snapshot_id: str
    method_source_id: str | None
    title: str
    attempt_id: str
    lease_token: str
    fencing_epoch: int
    lease_expires_at: int


class WorkerV2Client:
    def __init__(
        self,
        *,
        base_url: str,
        worker_id: str,
        credential: str,
        instance_id: str,
        image_digest: str | None = None,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        if not WORKER_ID_RE.fullmatch(worker_id):
            raise SecurityBoundaryError("WORKER_ID is invalid")
        if not credential or len(credential) < 16:
            raise SecurityBoundaryError("WORKER_CREDENTIAL is required")
        if not instance_id or len(instance_id) > 160:
            raise SecurityBoundaryError("WORKER_INSTANCE_ID is required")
        self.base_url = validated_control_plane_url(base_url)
        self.worker_id = worker_id
        self.credential = credential
        self.instance_id = instance_id
        self.image_digest = image_digest or None
        self.session: WorkerSession | None = None
        self._client = http_client
        self._owns_client = http_client is None

    async def __aenter__(self) -> "WorkerV2Client":
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=_timeout(), follow_redirects=False)
        return self

    async def __aexit__(self, _exc_type: Any, _exc: Any, _tb: Any) -> None:
        await self.close()

    async def close(self) -> None:
        if self._client is not None and self._owns_client:
            await self._client.aclose()
            self._client = None

    def _headers(self, *, attempt_id: str | None = None, lease_token: str | None = None) -> dict[str, str]:
        if self.session is None and attempt_id:
            raise ControlPlaneError("Worker session is not connected")
        headers = {
            "authorization": f"Bearer {self.credential}",
            "x-worker-id": self.worker_id,
            "x-worker-instance-id": self.instance_id,
            "x-worker-protocol-version": PROTOCOL_VERSION,
            "x-worker-runtime-capability": RUNTIME_CAPABILITY,
            "content-type": "application/json",
        }
        if self.image_digest:
            headers["x-worker-image-digest"] = self.image_digest
        if self.session:
            headers.update({
                "x-worker-session-id": self.session.session_id,
                "x-worker-session-epoch": str(self.session.session_epoch),
            })
        if attempt_id:
            headers["x-worker-attempt-id"] = attempt_id
        if lease_token:
            headers["x-worker-lease-token"] = lease_token
        return headers

    async def _request(self, method: str, path: str, *, headers: Mapping[str, str] | None = None, **kwargs: Any) -> httpx.Response:
        if self._client is None:
            await self.__aenter__()
        assert self._client is not None
        response = await self._client.request(method, f"{self.base_url}{path}", headers=headers, **kwargs)
        if response.status_code >= 400:
            raise _bounded_error(response)
        return response

    async def connect(self) -> WorkerSession:
        response = await self._request(
            "POST",
            "/api/worker/v2/connect",
            headers={
                **self._headers(),
                "content-type": "application/json",
            },
            json={
                "worker_id": self.worker_id,
                "instance_id": self.instance_id,
                "protocol_version": PROTOCOL_VERSION,
                "runtime_capability": RUNTIME_CAPABILITY,
                **({"image_digest": self.image_digest} if self.image_digest else {}),
            },
        )
        payload = response.json()
        session = WorkerSession(
            session_id=str(payload.get("session_id") or ""),
            session_epoch=int(payload.get("session_epoch")),
            pool_id=str(payload.get("pool_id") or ""),
            namespace=str(payload.get("namespace") or ""),
            lease_expires_at=int(payload.get("lease_expires_at")),
        )
        if not session.session_id or session.pool_id != "public-default" or session.namespace != "infinity-public":
            raise ControlPlaneError("Worker connect response is not server-bound to the public pool")
        self.session = session
        return session

    async def heartbeat(self) -> dict[str, Any]:
        response = await self._request("POST", "/api/worker/v2/heartbeat", headers=self._headers(), json={})
        return response.json()

    async def poll(self) -> tuple[list[dict[str, Any]], int]:
        response = await self._request("POST", "/api/worker/v2/poll", headers=self._headers(), json={})
        payload = response.json()
        tasks = payload.get("tasks") if isinstance(payload, dict) else []
        return (tasks if isinstance(tasks, list) else [], max(1, min(int(payload.get("next_poll_seconds", 5)), 30)))

    async def accept(self, task: Mapping[str, Any]) -> ClaimedTask:
        task_id = str(task.get("task_id") or "")
        response = await self._request(
            "POST",
            f"/api/worker/v2/tasks/{task_id}/accept",
            headers=self._headers(),
            json={},
        )
        payload = response.json()
        return ClaimedTask(
            task_id=task_id,
            task_spec_id=str(task.get("task_spec_id") or ""),
            dataset_snapshot_id=str(task.get("dataset_snapshot_id") or ""),
            method_source_id=str(task.get("method_source_id")) if task.get("method_source_id") else None,
            title=str(task.get("title") or ""),
            attempt_id=str(payload["attempt_id"]),
            lease_token=str(payload["lease_token"]),
            fencing_epoch=int(payload["fencing_epoch"]),
            lease_expires_at=int(payload["lease_expires_at"]),
        )

    async def renew(self, claim: ClaimedTask) -> dict[str, Any]:
        response = await self._request(
            "POST",
            f"/api/worker/v2/tasks/{claim.task_id}/renew",
            headers=self._headers(attempt_id=claim.attempt_id, lease_token=claim.lease_token),
            json={},
        )
        return response.json()

    async def spec(self, claim: ClaimedTask) -> dict[str, Any]:
        response = await self._request(
            "GET",
            f"/api/worker/v2/tasks/{claim.task_id}/spec",
            headers=self._headers(attempt_id=claim.attempt_id, lease_token=claim.lease_token),
        )
        return response.json()

    async def download_input(self, claim: ClaimedTask, kind: str, destination: Path, expected: Mapping[str, Any] | None) -> Path:
        if kind not in {"method", "dataset"}:
            raise ControlPlaneError("unsupported task input")
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.with_name(f".{destination.name}.part")
        digest = hashlib.sha256()
        total = 0
        if self._client is None:
            await self.__aenter__()
        assert self._client is not None
        async with self._client.stream(
            "GET",
            f"{self.base_url}/api/worker/v2/tasks/{claim.task_id}/inputs/{kind}",
            headers=self._headers(attempt_id=claim.attempt_id, lease_token=claim.lease_token),
        ) as response:
            if response.status_code >= 400:
                raise _bounded_error(response)
            try:
                with temporary.open("wb") as handle:
                    async for chunk in response.aiter_bytes(1024 * 1024):
                        total += len(chunk)
                        if total > MAX_INPUT_BYTES:
                            raise ControlPlaneError("task input exceeds 25 MiB limit")
                        digest.update(chunk)
                        handle.write(chunk)
            except Exception:
                temporary.unlink(missing_ok=True)
                raise
        expected_size = expected.get("file_size_bytes") if expected else None
        expected_hash = str(expected.get("sha256") or "").lower() if expected else ""
        if expected_size is not None and int(expected_size) != total:
            temporary.unlink(missing_ok=True)
            raise ControlPlaneError(f"{kind} input size does not match D1 metadata")
        if expected_hash and digest.hexdigest() != expected_hash:
            temporary.unlink(missing_ok=True)
            raise ControlPlaneError(f"{kind} input checksum does not match D1 metadata")
        temporary.replace(destination)
        return destination

    async def start_artifact(self, claim: ClaimedTask, *, name: str, kind: str, content_type: str, size: int, sha256: str, manifest: Mapping[str, Any]) -> dict[str, Any]:
        response = await self._request(
            "POST",
            f"/api/worker/v2/tasks/{claim.task_id}/artifacts/start",
            headers=self._headers(attempt_id=claim.attempt_id, lease_token=claim.lease_token),
            json={
                "name": name,
                "kind": kind,
                "content_type": content_type,
                "expected_size_bytes": size,
                "expected_sha256": sha256,
                "manifest": dict(manifest),
            },
        )
        return response.json()

    async def upload_artifact_part(
        self,
        claim: ClaimedTask,
        upload_id: str,
        part_number: int,
        path: Path,
        offset: int,
        length: int,
        *,
        progress_check: Callable[[], None] | None = None,
    ) -> dict[str, Any]:
        check = progress_check or (lambda: None)
        digest = hashlib.sha256()

        class FilePart(httpx.AsyncByteStream):
            async def __aiter__(self_nonlocal) -> AsyncIterator[bytes]:
                handle = await asyncio.to_thread(path.open, "rb")
                try:
                    await asyncio.to_thread(handle.seek, offset)
                    remaining = length
                    while remaining:
                        check()
                        chunk = await asyncio.to_thread(handle.read, min(1024 * 1024, remaining))
                        if not chunk:
                            raise ControlPlaneError("artifact changed during upload")
                        remaining -= len(chunk)
                        digest.update(chunk)
                        yield chunk
                finally:
                    await asyncio.to_thread(handle.close)

            async def aclose(self_nonlocal) -> None:
                return None

        check()
        headers = self._headers(attempt_id=claim.attempt_id, lease_token=claim.lease_token)
        headers.update({"content-type": "application/octet-stream", "content-length": str(length)})
        response = await self._request(
            "PUT",
            f"/api/worker/v2/artifacts/{upload_id}/parts/{part_number}",
            headers=headers,
            content=FilePart(),
        )
        payload = response.json()
        if str(payload.get("sha256") or "").lower() != digest.hexdigest() or int(payload.get("size_bytes", -1)) != length:
            raise ControlPlaneError("artifact part checksum response is invalid")
        return payload

    async def complete_artifact(self, claim: ClaimedTask, upload_id: str, parts: list[dict[str, Any]]) -> dict[str, Any]:
        response = await self._request(
            "POST",
            f"/api/worker/v2/artifacts/{upload_id}/complete",
            headers=self._headers(attempt_id=claim.attempt_id, lease_token=claim.lease_token),
            json={"parts": parts},
        )
        return response.json()

    async def finish(self, claim: ClaimedTask, *, cancelled: bool = False, error_code: str = "", error_message: str = "") -> dict[str, Any]:
        response = await self._request(
            "POST",
            f"/api/worker/v2/tasks/{claim.task_id}/{('cancelled' if cancelled else 'fail')}",
            headers=self._headers(attempt_id=claim.attempt_id, lease_token=claim.lease_token),
            json={"error_code": error_code[:80], "error_message": error_message[:MAX_ERROR_LENGTH]},
        )
        return response.json()


class RedisHintClient:
    """Fixed HTTPS hint reader; it never imports or speaks the Redis protocol."""

    def __init__(self, *, base_url: str, token: str, http_client: httpx.AsyncClient | None = None) -> None:
        if not token:
            raise SecurityBoundaryError("WORKER_RELAY_HINT_TOKEN is required")
        self.base_url = validated_relay_url(base_url)
        self.token = token
        self.cursor = "0-0"
        self._client = http_client
        self._owns_client = http_client is None

    async def __aenter__(self) -> "RedisHintClient":
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=_timeout(), follow_redirects=False)
        return self

    async def __aexit__(self, _exc_type: Any, _exc: Any, _tb: Any) -> None:
        await self.close()

    async def close(self) -> None:
        if self._client is not None and self._owns_client:
            await self._client.aclose()
            self._client = None

    async def read(self, limit: int = 20) -> list[dict[str, Any]]:
        if self._client is None:
            await self.__aenter__()
        assert self._client is not None
        response = await self._client.get(
            f"{self.base_url}/v1/hints",
            params={"cursor": self.cursor, "limit": max(1, min(int(limit), 100))},
            headers={"authorization": f"Bearer {self.token}"},
        )
        if response.status_code >= 400:
            raise ControlPlaneError(f"Redis Relay request failed ({response.status_code})", status_code=response.status_code)
        payload = response.json()
        items = payload.get("items", []) if isinstance(payload, dict) else []
        if not isinstance(items, list):
            raise ControlPlaneError("Redis Relay hint response is invalid")
        next_cursor = str(payload.get("next_cursor") or self.cursor)
        if not re.fullmatch(r"(?:0-0|[0-9]{1,20}-[0-9]{1,20})", next_cursor):
            raise ControlPlaneError("Redis Relay returned an invalid cursor")
        self.cursor = next_cursor
        return [item for item in items if isinstance(item, dict) and item.get("pool_id") == "public-default"]
