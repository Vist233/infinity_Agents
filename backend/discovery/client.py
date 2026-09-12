"""Short-lived client for the isolated Discovery Processor protocol."""

from __future__ import annotations

import json
import os
import secrets
import urllib.error
import urllib.request
from dataclasses import dataclass
from urllib.parse import urlparse
from typing import Any


_FIXED_EDGE_HOST = "infinity.zhangyvjing.com"
_PATHS = {"connect": "/api/discovery-processor/connect", "poll": "/api/discovery-processor/poll", "control": "/api/discovery-processor/control"}
_USER_AGENT = "Infinity-Discovery-Processor/1.0"


class DiscoveryProcessorProtocolError(RuntimeError):
    pass


@dataclass(frozen=True)
class DiscoveryGrant:
    kind: str
    work_id: str
    lease_token: str
    fencing_epoch: int
    lease_expires_at: int
    resource_id: str | None = None


def _validate_edge_url(edge_url: str) -> str:
    parsed = urlparse(edge_url)
    if parsed.scheme != "https" or parsed.hostname != _FIXED_EDGE_HOST or parsed.port is not None or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in {"", "/"}:
        raise DiscoveryProcessorProtocolError("Discovery Processor Edge URL is not the fixed control plane")
    return f"https://{_FIXED_EDGE_HOST}"


def _instance_id() -> str:
    return f"discovery-{os.getpid()}-{secrets.token_hex(8)}"


class DiscoveryProcessorClient:
    def __init__(self, edge_url: str, processor_id: str, bootstrap_token: str, instance_id: str) -> None:
        self._edge_url = _validate_edge_url(edge_url)
        self._processor_id = processor_id
        self._bootstrap_token = bootstrap_token
        self._instance_id = instance_id
        self._session_token: str | None = None

    def _url(self, endpoint: str) -> str:
        try:
            return self._edge_url + _PATHS[endpoint]
        except KeyError as exc:
            raise DiscoveryProcessorProtocolError("Discovery endpoint is not in the fixed protocol") from exc

    def _request(self, method: str, endpoint: str, payload: Any = None, *, grant: DiscoveryGrant | None = None) -> dict[str, Any]:
        if endpoint != "connect" and not self._session_token:
            raise DiscoveryProcessorProtocolError("Discovery Processor session is not connected")
        body = json.dumps(payload if payload is not None else {}, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        headers = {"accept": "application/json", "content-type": "application/json", "user-agent": _USER_AGENT}
        if endpoint == "connect":
            headers.update({"x-discovery-processor-id": self._processor_id, "x-discovery-processor-token": self._bootstrap_token})
        else:
            headers["x-discovery-processor-session"] = self._session_token or ""
            if grant:
                headers["x-discovery-processor-lease-token"] = grant.lease_token
        try:
            request = urllib.request.Request(self._url(endpoint), data=body, headers=headers, method=method)
            with urllib.request.urlopen(request, timeout=30) as response:
                raw = response.read(2_000_001)
        except urllib.error.HTTPError as exc:
            raise DiscoveryProcessorProtocolError(f"Discovery protocol HTTP {exc.code}") from exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise DiscoveryProcessorProtocolError("Discovery protocol transport failed") from exc
        if len(raw) > 2_000_000:
            raise DiscoveryProcessorProtocolError("Discovery protocol response is too large")
        try:
            value = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise DiscoveryProcessorProtocolError("Discovery protocol returned invalid JSON") from exc
        if not isinstance(value, dict):
            raise DiscoveryProcessorProtocolError("Discovery protocol returned a non-object")
        return value

    def _bytes(self, payload: dict[str, Any], grant: DiscoveryGrant, maximum_bytes: int) -> bytes:
        body = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        request = urllib.request.Request(self._url("control"), data=body, method="POST", headers={
            "accept": "application/octet-stream", "content-type": "application/json", "user-agent": _USER_AGENT,
            "x-discovery-processor-session": self._session_token or "",
            "x-discovery-processor-lease-token": grant.lease_token,
        })
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                value = response.read(maximum_bytes + 1)
        except urllib.error.HTTPError as exc:
            raise DiscoveryProcessorProtocolError(f"Discovery source HTTP {exc.code}") from exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise DiscoveryProcessorProtocolError("Discovery source transport failed") from exc
        if len(value) > maximum_bytes:
            raise DiscoveryProcessorProtocolError("Discovery source exceeds the local limit")
        return value

    def connect(self) -> dict[str, Any]:
        value = self._request("POST", "connect", {"instance_id": self._instance_id})
        token = value.get("processor_session_token")
        if not isinstance(token, str) or len(token) < 16:
            raise DiscoveryProcessorProtocolError("Discovery Processor session token missing")
        self._session_token = token
        return value

    def poll(self) -> DiscoveryGrant | None:
        value = self._request("POST", "poll", {})
        # The Edge poll contract uses an explicit `kind` only when work is
        # available; an idle response is `{resource: null}`.  Do not key the
        # decision off `resource` for a granted item because the grant carries
        # the resource identity in `resource_id` (and matches have none).
        if not isinstance(value.get("kind"), str):
            return None
        required = ("kind", "work_id", "lease_token", "fencing_epoch", "lease_expires_at")
        if any(not isinstance(value.get(key), (str, int)) for key in required):
            raise DiscoveryProcessorProtocolError("Discovery grant is incomplete")
        kind = str(value["kind"])
        if kind not in {"paper", "collection", "match"}:
            raise DiscoveryProcessorProtocolError("Discovery grant kind is invalid")
        resource_id = value.get("resource_id")
        if resource_id is not None and not isinstance(resource_id, str):
            raise DiscoveryProcessorProtocolError("Discovery grant resource id is invalid")
        return DiscoveryGrant(kind, str(value["work_id"]), str(value["lease_token"]), int(value["fencing_epoch"]), int(value["lease_expires_at"]), resource_id)

    def control(self, operation: str, grant: DiscoveryGrant, **fields: Any) -> dict[str, Any]:
        return self._request("POST", "control", {"operation": operation, "kind": grant.kind, "work_id": grant.work_id, **({"resource_id": grant.resource_id} if grant.resource_id else {}), "fencing_epoch": grant.fencing_epoch, **fields}, grant=grant)

    def input(self, grant: DiscoveryGrant) -> dict[str, Any]:
        return self.control("input", grant)

    def input_source(self, grant: DiscoveryGrant, maximum_bytes: int = 64 * 1024 * 1024) -> bytes:
        return self._bytes({"operation": "input_source", "kind": grant.kind, "work_id": grant.work_id, **({"resource_id": grant.resource_id} if grant.resource_id else {}), "fencing_epoch": grant.fencing_epoch}, grant, maximum_bytes)

    def renew(self, grant: DiscoveryGrant) -> dict[str, Any]:
        return self.control("renew", grant)

    def save_paper_profile(self, grant: DiscoveryGrant, profile: dict[str, Any], overview: str) -> dict[str, Any]:
        return self.control("save_paper_profile", grant, profile=profile, overview=overview)

    def save_dataset_profile(self, grant: DiscoveryGrant, profile: dict[str, Any]) -> dict[str, Any]:
        return self.control("save_dataset_profile", grant, profile=profile)

    def create_match(self, paper_id: str, collection_id: str, paper_profile_version: str, dataset_profile_version: str) -> dict[str, Any]:
        return self._request("POST", "control", {"operation": "create_match", "paper_id": paper_id, "collection_id": collection_id, "paper_profile_version": paper_profile_version, "dataset_profile_version": dataset_profile_version})

    def save_evaluation(self, grant: DiscoveryGrant, evaluation: dict[str, Any]) -> dict[str, Any]:
        return self.control("save_evaluation", grant, evaluation=evaluation)

    def fail(self, grant: DiscoveryGrant, error_code: str, spam_status: str | None = None) -> dict[str, Any]:
        fields: dict[str, Any] = {"error_code": error_code}
        if spam_status:
            fields["spam_status"] = spam_status
        return self.control("fail", grant, **fields)


def from_environment() -> DiscoveryProcessorClient:
    edge_url = os.environ.get("DISCOVERY_PROCESSOR_EDGE_URL", "https://infinity.zhangyvjing.com").strip()
    processor_id = os.environ.get("DISCOVERY_PROCESSOR_ID", "").strip()
    bootstrap_token = os.environ.get("DISCOVERY_PROCESSOR_TOKEN", "").strip()
    if not edge_url or not processor_id or not bootstrap_token:
        raise DiscoveryProcessorProtocolError("Discovery Processor runtime configuration is incomplete")
    return DiscoveryProcessorClient(edge_url, processor_id, bootstrap_token, os.environ.get("DISCOVERY_PROCESSOR_INSTANCE_ID", "").strip() or _instance_id())
