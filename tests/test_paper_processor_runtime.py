import json
import re
from urllib.parse import urlparse

import pytest

from backend.paper_processor.client import (
    PaperProcessorClient,
    PaperProcessorProtocolError,
    ProcessorGrant,
    _validate_edge_url,
    from_environment,
)
from backend.paper_processor.ingest import ProcessorError, ProcessingDeadline, ProcessorRuntimeLimits


def test_processor_edge_url_is_the_fixed_https_control_plane():
    assert _validate_edge_url("https://infinity.zhangyvjing.com/") == "https://infinity.zhangyvjing.com"


def test_processor_edge_url_rejects_unapproved_hosts_and_url_parts():
    for value in (
        "http://infinity.zhangyvjing.com",
        "https://example.com",
        "https://infinity.zhangyvjing.com:443",
        "https://infinity.zhangyvjing.com/api",
        "https://user@infinity.zhangyvjing.com",
        "https://infinity.zhangyvjing.com/?redirect=example.com",
    ):
        try:
            _validate_edge_url(value)
        except PaperProcessorProtocolError as error:
            assert str(error) == "Paper Processor Edge URL is not the fixed control plane"
        else:
            raise AssertionError(f"unapproved Edge URL was accepted: {value}")


def test_processor_generates_a_unique_boot_and_process_scoped_instance_id(monkeypatch):
    monkeypatch.setenv("PAPER_PROCESSOR_EDGE_URL", "https://infinity.zhangyvjing.com")
    monkeypatch.setenv("PAPER_PROCESSOR_ID", "paper-processor-zhangbot-v1")
    monkeypatch.setenv("PAPER_PROCESSOR_TOKEN", "test-only-token")
    monkeypatch.delenv("PAPER_PROCESSOR_INSTANCE_ID", raising=False)

    first = from_environment()
    second = from_environment()

    assert first._instance_id != second._instance_id
    assert re.fullmatch(r"zhangbot-[a-z0-9-]+-[0-9]+-[0-9a-f]{16}", first._instance_id)


def test_runtime_limits_are_non_secret_and_fail_closed_for_invalid_environment(monkeypatch):
    monkeypatch.setenv("PAPER_PROCESSOR_ATTEMPT_TIMEOUT_SECONDS", "120")
    monkeypatch.setenv("PAPER_PROCESSOR_DOWNLOAD_TIMEOUT_SECONDS", "30")
    monkeypatch.setenv("PAPER_PROCESSOR_EXTRACTION_TIMEOUT_SECONDS", "60")
    monkeypatch.setenv("PAPER_PROCESSOR_UPLOAD_TIMEOUT_SECONDS", "30")
    monkeypatch.setenv("PAPER_PROCESSOR_HEARTBEAT_INTERVAL_SECONDS", "15")
    monkeypatch.setenv("PAPER_PROCESSOR_MAX_RESIDENT_MEMORY_BYTES", "134217728")

    limits = ProcessorRuntimeLimits.from_environment()
    assert limits == ProcessorRuntimeLimits(120, 30, 60, 30, 15, 134217728)

    monkeypatch.setenv("PAPER_PROCESSOR_ATTEMPT_TIMEOUT_SECONDS", "not-a-timeout")
    monkeypatch.setenv("PAPER_PROCESSOR_MAX_RESIDENT_MEMORY_BYTES", "1")
    fallback = ProcessorRuntimeLimits.from_environment()
    assert fallback.attempt_timeout_seconds == 240
    assert fallback.max_resident_memory_bytes == 192 * 1024 * 1024

    monkeypatch.setenv("PAPER_PROCESSOR_MAX_RESIDENT_MEMORY_BYTES", str(512 * 1024 * 1024))
    assert ProcessorRuntimeLimits.from_environment().max_resident_memory_bytes == 512 * 1024 * 1024

    monkeypatch.setenv("PAPER_PROCESSOR_ATTEMPT_TIMEOUT_SECONDS", "360")
    assert ProcessorRuntimeLimits.from_environment().attempt_timeout_seconds == 360


def test_processing_deadline_reports_stage_timeout_before_attempt_timeout():
    now = [100.0]
    deadline = ProcessingDeadline(
        ProcessorRuntimeLimits(
            attempt_timeout_seconds=10,
            download_timeout_seconds=2,
            extraction_timeout_seconds=5,
            upload_timeout_seconds=5,
            heartbeat_interval_seconds=1,
        ),
        clock=lambda: now[0],
    )
    deadline.start_stage("downloading")
    deadline.check("downloading")
    now[0] = 102.0
    with pytest.raises(ProcessorError, match="PAPER_PROCESSOR_DOWNLOAD_TIMEOUT"):
        deadline.check("downloading")


class _FakeHTTPResponse:
    def __init__(self, body: bytes):
        self.body = body

    def read(self, _size: int = -1) -> bytes:
        return self.body

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None


def test_processor_client_uses_only_fixed_paths_and_envelopes(monkeypatch):
    client = PaperProcessorClient(
        "https://infinity.zhangyvjing.com",
        "paper-processor-zhangbot-v1",
        "test-bootstrap-token",
        "instance-1",
    )
    requests = []

    def fake_urlopen(request, timeout=0):
        assert timeout == (120 if urlparse(request.full_url).path == "/api/paper-processor/object" else 30)
        requests.append(request)
        path = urlparse(request.full_url).path
        if path == "/api/paper-processor/connect":
            return _FakeHTTPResponse(json.dumps({"processor_session_token": "session-token-long-enough"}).encode())
        if path == "/api/paper-processor/poll":
            return _FakeHTTPResponse(json.dumps({
                "resource_id": "resource-1",
                "attempt_id": "attempt-1",
                "lease_token": "lease-token-long-enough",
                "fencing_epoch": 1,
                "lease_expires_at": 999,
                "source_kind": "arxiv",
                "source_ref": "2401.00001",
            }).encode())
        if path == "/api/paper-processor/control":
            payload = json.loads(request.data.decode())
            if payload["operation"] == "input_source":
                return _FakeHTTPResponse(b"%PDF-1.7\nfixed-endpoint")
            return _FakeHTTPResponse(json.dumps({"status": payload["operation"]}).encode())
        if path == "/api/paper-processor/object":
            return _FakeHTTPResponse(b'{"status":"uploaded"}')
        raise AssertionError(f"unexpected Processor URL: {request.full_url}")

    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)

    client.connect()
    grant = client.poll()
    assert isinstance(grant, ProcessorGrant)
    client.input_metadata(grant)
    assert client.input_source(grant, 1024).startswith(b"%PDF-")
    client.renew(grant)
    client.stage(grant, "extracting")
    client.upload(grant, "text_pages", b"pages", "application/json", "pages")
    client.finalize(grant, {"resource_id": grant.resource_id, "page_count": 1})
    client.cancel(grant)
    client.fail(grant, "MALFORMED_PDF")

    paths = [urlparse(request.full_url).path for request in requests]
    assert set(paths) == {
        "/api/paper-processor/connect",
        "/api/paper-processor/poll",
        "/api/paper-processor/control",
        "/api/paper-processor/object",
    }
    assert all("/attempts/" not in request.full_url and "?" not in request.full_url for request in requests)
    control_operations = [
        json.loads(request.data.decode())["operation"]
        for request in requests
        if urlparse(request.full_url).path == "/api/paper-processor/control"
    ]
    assert control_operations == ["input", "input_source", "renew", "stage", "finalize", "cancel", "fail"]
    object_request = next(request for request in requests if urlparse(request.full_url).path == "/api/paper-processor/object")
    object_headers = {key.lower(): value for key, value in object_request.header_items()}
    assert json.loads(object_headers["x-paper-processor-envelope"]) == {
        "operation": "upload",
        "attempt_id": "attempt-1",
        "resource_id": "resource-1",
        "fencing_epoch": 1,
        "kind": "text_pages",
        "object_id": "pages",
    }
    with pytest.raises(PaperProcessorProtocolError, match="fixed protocol"):
        client._url("attempts/attempt-1/renew")
