"""Logical ResourceBroker for Analysis and Task inputs.

Agents receive opaque resource IDs.  Physical paths are resolved only after an
authorization callback and never become part of a model prompt or API URL.
"""

from __future__ import annotations

import hashlib
import mimetypes
import uuid
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Awaitable, Callable, Optional

import httpx

from backend.security import SecurityBoundaryError, ensure_within, safe_relative_path, validate_outbound_url


class ResourceNotFound(SecurityBoundaryError):
    pass


class ResourceForbidden(SecurityBoundaryError):
    pass


class EgressDenied(SecurityBoundaryError):
    pass


@dataclass(frozen=True)
class ResourceRecord:
    resource_id: str
    project_id: str
    kind: str
    logical_name: str
    storage_key: str
    content_type: str
    file_size_bytes: int
    checksum_sha256: str
    egress_policy: str = "local_only"
    status: str = "ready"


Authorize = Callable[[ResourceRecord, str], bool | Awaitable[bool]]


class ResourceBroker:
    def __init__(self, storage_root: str | Path, *, authorize: Optional[Authorize] = None) -> None:
        self.root = Path(storage_root).expanduser().resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self._records: dict[str, ResourceRecord] = {}
        self._authorize = authorize

    def _path_for(self, record: ResourceRecord) -> Path:
        return ensure_within(self.root, self.root / safe_relative_path(record.storage_key))

    def register_file(
        self,
        source_path: str | Path,
        *,
        project_id: str,
        logical_name: Optional[str] = None,
        kind: str = "dataset",
        egress_policy: str = "local_only",
        copy: bool = True,
    ) -> ResourceRecord:
        source = Path(source_path).expanduser().resolve()
        if not source.is_file() or source.is_symlink():
            raise ResourceNotFound("resource source is not a regular file")
        if egress_policy not in {"local_only", "provider_allowed"}:
            raise SecurityBoundaryError("unknown egress policy")
        resource_id = str(uuid.uuid4())
        if copy:
            storage_key = f"resources/{resource_id}/{safe_relative_path(logical_name or source.name)}"
        else:
            storage_key = ensure_within(self.root, source).relative_to(self.root).as_posix()
        destination = self._path_for(ResourceRecord(resource_id, project_id, kind, logical_name or source.name, storage_key, "", 0, ""))
        destination.parent.mkdir(parents=True, exist_ok=True)
        if copy:
            destination.write_bytes(source.read_bytes())
        else:
            destination = source
        data = destination.read_bytes()
        record = ResourceRecord(
            resource_id=resource_id,
            project_id=str(project_id),
            kind=kind,
            logical_name=logical_name or source.name,
            storage_key=storage_key,
            content_type=mimetypes.guess_type(source.name)[0] or "application/octet-stream",
            file_size_bytes=len(data),
            checksum_sha256=hashlib.sha256(data).hexdigest(),
            egress_policy=egress_policy,
        )
        self._records[resource_id] = record
        return record

    def get(self, resource_id: str, *, user_id: str, purpose: str = "read") -> ResourceRecord:
        record = self._records.get(str(resource_id))
        if record is None or record.status != "ready":
            raise ResourceNotFound("resource not found")
        if self._authorize is not None:
            allowed = self._authorize(record, user_id)
            if hasattr(allowed, "__await__"):
                raise RuntimeError("async authorization requires get_async")
            if not allowed:
                raise ResourceForbidden("resource is not authorized")
        return record

    async def get_async(self, resource_id: str, *, user_id: str, purpose: str = "read") -> ResourceRecord:
        record = self._records.get(str(resource_id))
        if record is None or record.status != "ready":
            raise ResourceNotFound("resource not found")
        if self._authorize is not None:
            allowed = self._authorize(record, user_id)
            if hasattr(allowed, "__await__"):
                allowed = await allowed
            if not allowed:
                raise ResourceForbidden("resource is not authorized")
        return record

    def authorize_egress(
        self,
        resource_id: str,
        *,
        user_id: str,
        provider_id: str,
        purpose: str,
        content_kind: str,
    ) -> dict[str, str]:
        """Make the final provider disclosure decision for a resource.

        The return value is an audit-safe decision record.  It intentionally
        contains no physical path, signed URL, or source bytes.
        """

        record = self.get(resource_id, user_id=user_id, purpose=purpose)
        if record.egress_policy != "provider_allowed":
            raise EgressDenied("resource egress policy does not allow this provider")
        if not provider_id or not purpose or not content_kind:
            raise EgressDenied("provider disclosure metadata is incomplete")
        return {
            "resource_id": record.resource_id,
            "project_id": record.project_id,
            "provider_id": provider_id,
            "purpose": purpose,
            "content_kind": content_kind,
            "egress_policy": record.egress_policy,
        }

    def read_bytes(self, resource_id: str, *, user_id: str, max_bytes: int = 50 * 1024 * 1024) -> bytes:
        record = self.get(resource_id, user_id=user_id)
        path = self._path_for(record)
        if not path.is_file() or path.is_symlink():
            raise ResourceNotFound("resource content is unavailable")
        if path.stat().st_size > max_bytes:
            raise SecurityBoundaryError("resource exceeds read limit")
        return path.read_bytes()

    async def fetch_url(
        self,
        url: str,
        *,
        project_id: str,
        user_id: str,
        kind: str = "paper",
        max_bytes: int = 50 * 1024 * 1024,
        allow_hosts: Optional[set[str]] = None,
        allow_http_local: bool = False,
    ) -> ResourceRecord:
        current = validate_outbound_url(url, allow_hosts=allow_hosts, allow_http_local=allow_http_local)
        async with httpx.AsyncClient(follow_redirects=False, timeout=15.0) as client:
            for _ in range(3):
                validated = validate_outbound_url(current, allow_hosts=allow_hosts, allow_http_local=allow_http_local)
                async with client.stream("GET", validated, headers={"Accept": "application/pdf,text/html,*/*"}) as response:
                    if response.is_redirect:
                        location = response.headers.get("location")
                        if not location:
                            raise SecurityBoundaryError("redirect has no location")
                        current = str(httpx.URL(validated).join(location))
                        continue
                    response.raise_for_status()
                    content_length = response.headers.get("content-length")
                    if content_length and int(content_length) > max_bytes:
                        raise SecurityBoundaryError("remote resource exceeds size limit")
                    temporary = self.root / "incoming" / f"{uuid.uuid4().hex}.bin"
                    temporary.parent.mkdir(parents=True, exist_ok=True)
                    total = 0
                    with temporary.open("wb") as handle:
                        async for chunk in response.aiter_bytes(1024 * 1024):
                            total += len(chunk)
                            if total > max_bytes:
                                temporary.unlink(missing_ok=True)
                                raise SecurityBoundaryError("remote resource exceeds size limit")
                            handle.write(chunk)
                    try:
                        record = self.register_file(
                            temporary,
                            project_id=project_id,
                            logical_name=Path(httpx.URL(validated).path).name or "remote-resource",
                            kind=kind,
                            egress_policy="provider_allowed",
                        )
                    finally:
                        temporary.unlink(missing_ok=True)
                    if record.egress_policy != "provider_allowed":
                        raise SecurityBoundaryError("remote resource policy mismatch")
                    return record
            raise SecurityBoundaryError("too many redirects")

    def export_manifest(self) -> list[dict]:
        return [asdict(item) for item in sorted(self._records.values(), key=lambda item: item.resource_id)]
