from __future__ import annotations

import pytest

from backend.discovery.client import (
    DiscoveryGrant,
    DiscoveryProcessorClient,
    DiscoveryProcessorProtocolError,
)


def test_poll_distinguishes_idle_response_from_a_match_grant(monkeypatch):
    client = DiscoveryProcessorClient(
        "https://infinity.zhangyvjing.com",
        "processor-1",
        "bootstrap-secret",
        "instance-1",
    )
    client._session_token = "session-token-123456"
    responses = iter([
        {"resource": None},
        {
            "kind": "match",
            "work_id": "match-1",
            "lease_token": "lease-token-123456",
            "fencing_epoch": 2,
            "lease_expires_at": 1_800_000_000,
        },
    ])
    monkeypatch.setattr(client, "_request", lambda *_args, **_kwargs: next(responses))

    assert client.poll() is None
    grant = client.poll()
    assert grant == DiscoveryGrant(
        "match", "match-1", "lease-token-123456", 2, 1_800_000_000, None
    )


def test_poll_rejects_incomplete_grants_and_fixed_endpoint_rejects_other_hosts():
    client = DiscoveryProcessorClient(
        "https://infinity.zhangyvjing.com",
        "processor-1",
        "bootstrap-secret",
        "instance-1",
    )
    client._session_token = "session-token-123456"
    client._request = lambda *_args, **_kwargs: {"kind": "paper", "work_id": "paper-1"}
    with pytest.raises(DiscoveryProcessorProtocolError, match="incomplete"):
        client.poll()
    with pytest.raises(DiscoveryProcessorProtocolError, match="fixed control plane"):
        DiscoveryProcessorClient("https://attacker.example", "p", "secret", "i")


def test_protocol_requests_use_service_user_agent(monkeypatch):
    requests = []

    class FakeResponse:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def read(self, _maximum=None):
            return b'{"processor_session_token":"session-token-123456"}' if len(requests) == 1 else b"source"

    def fake_urlopen(request, timeout):
        assert timeout in {30, 120}
        requests.append(request)
        return FakeResponse()

    monkeypatch.setattr("backend.discovery.client.urllib.request.urlopen", fake_urlopen)
    client = DiscoveryProcessorClient(
        "https://infinity.zhangyvjing.com",
        "processor-1",
        "bootstrap-secret",
        "instance-1",
    )

    client.connect()
    client.input_source(DiscoveryGrant("paper", "paper-1", "lease-token-123456", 1, 2_000_000_000), 1024)

    assert len(requests) == 2
    assert all(request.get_header("User-agent") == "Infinity-Discovery-Processor/1.0" for request in requests)


def test_streamed_source_removes_partial_file_after_read_failure(monkeypatch, tmp_path):
    class FailingResponse:
        headers = {}

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def read(self, _maximum=None):
            if not hasattr(self, "read_once"):
                self.read_once = True
                return b"partial"
            raise OSError("connection reset")

    monkeypatch.setattr(
        "backend.discovery.client.urllib.request.urlopen",
        lambda *_args, **_kwargs: FailingResponse(),
    )
    client = DiscoveryProcessorClient(
        "https://infinity.zhangyvjing.com",
        "processor-1",
        "bootstrap-secret",
        "instance-1",
    )
    client._session_token = "session-token-123456"
    destination = tmp_path / "source.csv"

    with pytest.raises(DiscoveryProcessorProtocolError, match="transport failed"):
        client.input_source_to_file(
            DiscoveryGrant("collection", "collection-1", "lease-token-123456", 1, 2_000_000_000),
            destination,
            1024,
        )

    assert not destination.exists()
    assert list(tmp_path.iterdir()) == []
