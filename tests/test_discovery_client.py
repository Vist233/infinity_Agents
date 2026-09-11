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
