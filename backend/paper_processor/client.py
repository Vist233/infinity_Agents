"""Small, deterministic client for the dedicated Paper Processor protocol.

The Processor receives short-lived capabilities and fixed logical object kinds
from the Edge. It never receives database, object-store, relay, or model parent
credentials. This module deliberately has no service SDK dependencies.
"""

from __future__ import annotations

import hashlib
import http.client
import json
import os
import re
import secrets
import urllib.error
from urllib.parse import urlparse
import urllib.request
from dataclasses import dataclass
from typing import Any
from pathlib import Path


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


_FIXED_EDGE_HOST = "infinity.zhangyvjing.com"
_ENDPOINT_PATHS = {
    "connect": "/api/paper-processor/connect",
    "poll": "/api/paper-processor/poll",
    "control": "/api/paper-processor/control",
    "object": "/api/paper-processor/object",
}


def _validate_edge_url(edge_url: str) -> str:
    parsed = urlparse(edge_url)
    if (
        parsed.scheme != "https"
        or parsed.hostname != _FIXED_EDGE_HOST
        or parsed.port is not None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or parsed.path not in {"", "/"}
    ):
        raise PaperProcessorProtocolError("Paper Processor Edge URL is not the fixed control plane")
    return f"https://{_FIXED_EDGE_HOST}"


def _new_instance_id() -> str:
    try:
        with open("/proc/sys/kernel/random/boot_id", encoding="ascii") as boot_file:
            boot_id = boot_file.read().strip()
    except OSError:
        boot_id = "boot-unknown"
    if not boot_id:
        boot_id = "boot-unknown"
    return f"zhangbot-{boot_id}-{os.getpid()}-{secrets.token_hex(8)}"


class PaperProcessorClient:
    def __init__(self, edge_url: str, processor_id: str, bootstrap_token: str, instance_id: str) -> None:
        self._edge_url = _validate_edge_url(edge_url)
        self._processor_id = processor_id
        self._bootstrap_token = bootstrap_token
        self._instance_id = instance_id
        self._session_token: str | None = None

    def _url(self, endpoint: str) -> str:
        path = _ENDPOINT_PATHS.get(endpoint)
        if path is None:
            raise PaperProcessorProtocolError("Processor endpoint is not in the fixed protocol")
        return f"{self._edge_url}{path}"

    def _request(self, method: str, endpoint: str, payload: Any = None, *, lease_token: str | None = None, raw: bytes | None = None, content_type: str = "application/json", extra_headers: dict[str, str] | None = None) -> dict[str, Any]:
        if endpoint not in _ENDPOINT_PATHS:
            raise PaperProcessorProtocolError("Processor endpoint is not in the fixed protocol")
        if not self._session_token and endpoint != "connect":
            raise PaperProcessorProtocolError("Processor session is not connected")
        body = raw if raw is not None else (json.dumps(payload, separators=(",", ":")).encode("utf-8") if payload is not None else None)
        headers = {"accept": "application/json"}
        if body is not None:
            headers["content-type"] = content_type
        if endpoint == "connect":
            headers.update({"x-paper-processor-id": self._processor_id, "x-paper-processor-token": self._bootstrap_token})
        else:
            headers["x-paper-processor-session"] = self._session_token or ""
            if lease_token:
                headers["x-paper-processor-lease-token"] = lease_token
        if extra_headers:
            headers.update(extra_headers)
        request = urllib.request.Request(self._url(endpoint), data=body, headers=headers, method=method)
        try:
            # JSON control calls remain tightly bounded.  A reviewed source
            # PDF or image upload may legitimately take longer than thirty
            # seconds on the zhangbot-to-Edge path; the attempt-level alarm
            # and lease heartbeat remain the outer bound.
            request_timeout = 120 if raw is not None else 30
            with urllib.request.urlopen(request, timeout=request_timeout) as response:
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

    def _request_bytes(self, method: str, endpoint: str, payload: dict[str, Any], maximum_bytes: int, *, lease_token: str) -> bytes:
        if endpoint not in _ENDPOINT_PATHS:
            raise PaperProcessorProtocolError("Processor endpoint is not in the fixed protocol")
        if not self._session_token:
            raise PaperProcessorProtocolError("Processor session is not connected")
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        headers = {
            "accept": "application/pdf",
            "content-type": "application/json",
            "x-paper-processor-session": self._session_token,
            "x-paper-processor-lease-token": lease_token,
        }
        request = urllib.request.Request(self._url(endpoint), data=body, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                response_body = response.read(maximum_bytes + 1)
        except urllib.error.HTTPError as error:
            raise PaperProcessorProtocolError(f"Processor source HTTP {error.code}") from error
        except urllib.error.URLError as error:
            raise PaperProcessorProtocolError("Processor source transport failed") from error
        if len(response_body) > maximum_bytes:
            raise PaperProcessorProtocolError("Processor source exceeds the local limit")
        return response_body

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
        return self._request("POST", "control", {
            "operation": "input",
            "attempt_id": grant.attempt_id,
            "resource_id": grant.resource_id,
            "fencing_epoch": grant.fencing_epoch,
        }, lease_token=grant.lease_token)

    def input_source(self, grant: ProcessorGrant, maximum_bytes: int) -> bytes:
        return self._request_bytes("POST", "control", {
            "operation": "input_source",
            "attempt_id": grant.attempt_id,
            "resource_id": grant.resource_id,
            "fencing_epoch": grant.fencing_epoch,
        }, maximum_bytes, lease_token=grant.lease_token)

    def renew(self, grant: ProcessorGrant) -> dict[str, Any]:
        return self._request("POST", "control", {
            "operation": "renew",
            "attempt_id": grant.attempt_id,
            "resource_id": grant.resource_id,
            "fencing_epoch": grant.fencing_epoch,
        }, lease_token=grant.lease_token)

    def stage(self, grant: ProcessorGrant, stage: str) -> dict[str, Any]:
        if stage not in {"extracting", "uploading"}:
            raise ValueError("unsupported processor stage")
        return self._request("POST", "control", {
            "operation": "stage",
            "attempt_id": grant.attempt_id,
            "resource_id": grant.resource_id,
            "fencing_epoch": grant.fencing_epoch,
            "stage": stage,
        }, lease_token=grant.lease_token)

    def upload(self, grant: ProcessorGrant, kind: str, body: bytes, content_type: str, object_id: str | None = None) -> dict[str, Any]:
        if kind not in {"source_pdf", "text_pages", "text_manifest", "image", "image_manifest"}:
            raise ValueError("unsupported paper object kind")
        if kind == "text_pages" and object_id != "pages":
            raise ValueError("text_pages object id is fixed")
        if kind == "image" and (object_id is None or not re.fullmatch(r"page-\d{4}-image-\d{4}", object_id)):
            raise ValueError("image object id is required")
        digest = hashlib.sha256(body).hexdigest()
        envelope: dict[str, Any] = {
            "operation": "upload",
            "attempt_id": grant.attempt_id,
            "resource_id": grant.resource_id,
            "fencing_epoch": grant.fencing_epoch,
            "kind": kind,
        }
        if object_id is not None:
            envelope["object_id"] = object_id
        result = self._request("PUT", "object", lease_token=grant.lease_token, raw=body, content_type=content_type, extra_headers={
            "x-paper-processor-envelope": json.dumps(envelope, separators=(",", ":")),
            "x-paper-object-sha256": digest,
        })
        return result

    def upload_file(self, grant: ProcessorGrant, path: Path, content_type: str = "application/pdf") -> dict[str, Any]:
        """Stream the admitted source PDF without materializing it in Python memory."""
        if not self._session_token:
            raise PaperProcessorProtocolError("Processor session is not connected")
        size = path.stat().st_size
        digest = hashlib.sha256()
        with path.open("rb") as source:
            while chunk := source.read(64 * 1024):
                digest.update(chunk)
        envelope = json.dumps({
            "operation": "upload", "attempt_id": grant.attempt_id,
            "resource_id": grant.resource_id, "fencing_epoch": grant.fencing_epoch,
            "kind": "source_pdf",
        }, separators=(",", ":"))
        connection = http.client.HTTPSConnection(_FIXED_EDGE_HOST, timeout=120)
        try:
            connection.putrequest("PUT", _ENDPOINT_PATHS["object"])
            connection.putheader("accept", "application/json")
            connection.putheader("content-type", content_type)
            connection.putheader("content-length", str(size))
            connection.putheader("x-paper-processor-session", self._session_token)
            connection.putheader("x-paper-processor-lease-token", grant.lease_token)
            connection.putheader("x-paper-processor-envelope", envelope)
            connection.putheader("x-paper-object-sha256", digest.hexdigest())
            connection.endheaders()
            with path.open("rb") as source:
                while chunk := source.read(64 * 1024):
                    connection.send(chunk)
            response = connection.getresponse()
            decoded = response.read().decode("utf-8")
            if response.status < 200 or response.status >= 300:
                raise PaperProcessorProtocolError(f"Processor protocol HTTP {response.status}")
            value = json.loads(decoded)
            if not isinstance(value, dict):
                raise PaperProcessorProtocolError("Processor protocol returned a non-object")
            return value
        except (OSError, http.client.HTTPException) as error:
            raise PaperProcessorProtocolError("Processor protocol transport failed") from error
        finally:
            connection.close()

    def finalize(self, grant: ProcessorGrant, manifest: dict[str, Any]) -> dict[str, Any]:
        return self._request("POST", "control", {
            "operation": "finalize",
            "attempt_id": grant.attempt_id,
            "resource_id": grant.resource_id,
            "fencing_epoch": grant.fencing_epoch,
            "manifest": manifest,
        }, lease_token=grant.lease_token)

    def cancel(self, grant: ProcessorGrant) -> dict[str, Any]:
        return self._request("POST", "control", {
            "operation": "cancel",
            "attempt_id": grant.attempt_id,
            "resource_id": grant.resource_id,
            "fencing_epoch": grant.fencing_epoch,
        }, lease_token=grant.lease_token)

    def fail(self, grant: ProcessorGrant, error_code: str) -> dict[str, Any]:
        if not re.fullmatch(r"[A-Z0-9_]{1,64}", error_code):
            raise ValueError("invalid processor error code")
        return self._request("POST", "control", {
            "operation": "fail",
            "attempt_id": grant.attempt_id,
            "resource_id": grant.resource_id,
            "fencing_epoch": grant.fencing_epoch,
            "error_code": error_code,
            "error_message": "Paper Processor rejected the resource",
        }, lease_token=grant.lease_token)


def from_environment() -> PaperProcessorClient:
    edge_url = os.environ.get("PAPER_PROCESSOR_EDGE_URL", "").strip()
    processor_id = os.environ.get("PAPER_PROCESSOR_ID", "").strip()
    bootstrap_token = os.environ.get("PAPER_PROCESSOR_TOKEN", "").strip()
    instance_id = os.environ.get("PAPER_PROCESSOR_INSTANCE_ID", "").strip() or _new_instance_id()
    if not edge_url or not processor_id or not bootstrap_token:
        raise PaperProcessorProtocolError("Paper Processor runtime configuration is incomplete")
    return PaperProcessorClient(edge_url, processor_id, bootstrap_token, instance_id)
