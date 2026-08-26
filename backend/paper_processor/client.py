"""Small, deterministic client for the dedicated Paper Processor protocol.

The Processor receives short-lived capabilities and fixed logical object kinds
from the Edge. It never receives database, object-store, relay, or model parent
credentials. This module deliberately has no service SDK dependencies.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class ProcessorGrant:
    resource_id: str
    attempt_id: str
    lease_token: str
    fencing_epoch: int
    lease_expires_at: int
    source_kind: str
    source_ref: str
    canonical_ref: str | None


class PaperProcessorProtocolError(RuntimeError):
    """The Edge rejected a Processor protocol request."""


class PaperProcessorClient:
    def __init__(self, edge_url: str, processor_id: str, bootstrap_token: str, instance_id: str) -> None:
        self._edge_url = edge_url.rstrip("/")
        self._processor_id = processor_id
        self._bootstrap_token = bootstrap_token
        self._instance_id = instance_id
        self._session_token: str | None = None

    def _url(self, path: str) -> str:
        return f"{self._edge_url}/api/paper-processor/{path.lstrip('/')}"

    def _request(self, method: str, path: str, payload: Any = None, *, lease_token: str | None = None, raw: bytes | None = None, content_type: str = "application/json", extra_headers: dict[str, str] | None = None) -> dict[str, Any]:
        if not self._session_token and path != "connect":
            raise PaperProcessorProtocolError("Processor session is not connected")
        body = raw if raw is not None else (json.dumps(payload, separators=(",", ":")).encode("utf-8") if payload is not None else None)
        headers = {"accept": "application/json"}
        if body is not None:
            headers["content-type"] = content_type
        if path == "connect":
            headers.update({"x-paper-processor-id": self._processor_id, "x-paper-processor-token": self._bootstrap_token})
        else:
            headers["x-paper-processor-session"] = self._session_token or ""
            if lease_token:
                headers["x-paper-processor-lease-token"] = lease_token
        if extra_headers:
            headers.update(extra_headers)
        request = urllib.request.Request(self._url(path), data=body, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                decoded = response.read().decode("utf-8")
        except urllib.error.HTTPError as error:
            detail = error.read(1024).decode("utf-8", errors="replace")
            raise PaperProcessorProtocolError(f"Processor protocol HTTP {error.code}: {detail}") from error
        except urllib.error.URLError as error:
            raise PaperProcessorProtocolError("Processor protocol transport failed") from error
        try:
            value = json.loads(decoded)
        except json.JSONDecodeError as error:
            raise PaperProcessorProtocolError("Processor protocol returned invalid JSON") from error
        if not isinstance(value, dict):
            raise PaperProcessorProtocolError("Processor protocol returned a non-object")
        return value

    def connect(self) -> dict[str, Any]:
        value = self._request("POST", "connect", {"instance_id": self._instance_id})
        token = value.get("processor_session_token")
        if not isinstance(token, str) or not token:
            raise PaperProcessorProtocolError("Processor session token missing")
        self._session_token = token
        return value

    def poll(self) -> ProcessorGrant | None:
        value = self._request("POST", "poll", {})
        if value.get("resource") is None and len(value) == 1:
            return None
        required = ("resource_id", "attempt_id", "lease_token", "fencing_epoch", "lease_expires_at", "source_kind", "source_ref")
        if any(key not in value for key in required):
            raise PaperProcessorProtocolError("Processor grant is incomplete")
        return ProcessorGrant(
            resource_id=str(value["resource_id"]),
            attempt_id=str(value["attempt_id"]),
            lease_token=str(value["lease_token"]),
            fencing_epoch=int(value["fencing_epoch"]),
            lease_expires_at=int(value["lease_expires_at"]),
            source_kind=str(value["source_kind"]),
            source_ref=str(value["source_ref"]),
            canonical_ref=value.get("canonical_ref") if isinstance(value.get("canonical_ref"), str) else None,
        )

    def input_metadata(self, grant: ProcessorGrant) -> dict[str, Any]:
        path = f"attempts/{grant.attempt_id}/input?resource_id={grant.resource_id}&fencing_epoch={grant.fencing_epoch}"
        return self._request("GET", path, lease_token=grant.lease_token)

    def input_source(self, grant: ProcessorGrant, maximum_bytes: int) -> bytes:
        path = f"attempts/{grant.attempt_id}/input/object?resource_id={grant.resource_id}&fencing_epoch={grant.fencing_epoch}"
        if not self._session_token:
            raise PaperProcessorProtocolError("Processor session is not connected")
        request = urllib.request.Request(self._url(path), headers={"accept": "application/pdf", "x-paper-processor-session": self._session_token, "x-paper-processor-lease-token": grant.lease_token}, method="GET")
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                body = response.read(maximum_bytes + 1)
        except urllib.error.HTTPError as error:
            raise PaperProcessorProtocolError(f"Processor source HTTP {error.code}") from error
        except urllib.error.URLError as error:
            raise PaperProcessorProtocolError("Processor source transport failed") from error
        if len(body) > maximum_bytes:
            raise PaperProcessorProtocolError("Processor source exceeds the local limit")
        return body

    def renew(self, grant: ProcessorGrant) -> dict[str, Any]:
        return self._request("POST", f"attempts/{grant.attempt_id}/renew", {"resource_id": grant.resource_id, "fencing_epoch": grant.fencing_epoch}, lease_token=grant.lease_token)

    def stage(self, grant: ProcessorGrant, stage: str) -> dict[str, Any]:
        if stage not in {"extracting", "uploading"}:
            raise ValueError("unsupported processor stage")
        return self._request("POST", f"attempts/{grant.attempt_id}/stage", {"resource_id": grant.resource_id, "fencing_epoch": grant.fencing_epoch, "stage": stage}, lease_token=grant.lease_token)

    def upload(self, grant: ProcessorGrant, kind: str, body: bytes, content_type: str, object_id: str | None = None) -> dict[str, Any]:
        if kind not in {"source_pdf", "text_pages", "text_manifest", "image", "image_manifest"}:
            raise ValueError("unsupported paper object kind")
        if kind == "text_pages" and object_id != "pages":
            raise ValueError("text_pages object id is fixed")
        if kind == "image" and (object_id is None or not re.fullmatch(r"page-\d{4}-image-\d{4}", object_id)):
            raise ValueError("image object id is required")
        digest = hashlib.sha256(body).hexdigest()
        object_query = f"&image_id={object_id}" if kind == "image" else ""
        path = f"attempts/{grant.attempt_id}/objects/{kind}?resource_id={grant.resource_id}&fencing_epoch={grant.fencing_epoch}{object_query}"
        result = self._request("PUT", path, lease_token=grant.lease_token, raw=body, content_type=content_type, extra_headers={"x-paper-object-sha256": digest})
        return result

    def finalize(self, grant: ProcessorGrant, manifest: dict[str, Any]) -> dict[str, Any]:
        return self._request("POST", f"attempts/{grant.attempt_id}/finalize", {"resource_id": grant.resource_id, "fencing_epoch": grant.fencing_epoch, "manifest": manifest}, lease_token=grant.lease_token)

    def cancel(self, grant: ProcessorGrant) -> dict[str, Any]:
        return self._request("POST", f"attempts/{grant.attempt_id}/cancel", {"resource_id": grant.resource_id, "fencing_epoch": grant.fencing_epoch}, lease_token=grant.lease_token)

    def fail(self, grant: ProcessorGrant, error_code: str) -> dict[str, Any]:
        if not re.fullmatch(r"[A-Z0-9_]{1,64}", error_code):
            raise ValueError("invalid processor error code")
        return self._request("POST", f"attempts/{grant.attempt_id}/fail", {"resource_id": grant.resource_id, "fencing_epoch": grant.fencing_epoch, "error_code": error_code, "error_message": "Paper Processor rejected the resource"}, lease_token=grant.lease_token)


def from_environment() -> PaperProcessorClient:
    edge_url = os.environ.get("PAPER_PROCESSOR_EDGE_URL", "").strip()
    processor_id = os.environ.get("PAPER_PROCESSOR_ID", "").strip()
    bootstrap_token = os.environ.get("PAPER_PROCESSOR_TOKEN", "").strip()
    instance_id = os.environ.get("PAPER_PROCESSOR_INSTANCE_ID", "").strip()
    if not edge_url or not processor_id or not bootstrap_token or not instance_id:
        raise PaperProcessorProtocolError("Paper Processor runtime configuration is incomplete")
    return PaperProcessorClient(edge_url, processor_id, bootstrap_token, instance_id)
