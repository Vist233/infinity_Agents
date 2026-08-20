from __future__ import annotations

import pytest

from backend.code_agent.worker import consumer_v2
from backend.code_agent.worker.control_plane import ControlPlaneError


@pytest.mark.asyncio
async def test_worker_keeps_polling_when_relay_hints_are_unavailable(monkeypatch: pytest.MonkeyPatch) -> None:
    required = {
        "WORKER_CONTROL_PLANE_URL": "https://infinity.test",
        "WORKER_RELAY_URL": "https://relay.test",
        "WORKER_CREDENTIAL": "credential-value-123456",
        "WORKER_INSTANCE_ID": "instance-test",
        "WORKER_RELAY_HINT_TOKEN": "hint-token-123456",
    }
    for name, value in required.items():
        monkeypatch.setenv(name, value)

    poll_count = 0

    class FakeClient:
        def __init__(self, **_kwargs: object) -> None:
            pass

        async def connect(self) -> None:
            return None

        async def poll(self) -> tuple[list[dict[str, object]], int]:
            nonlocal poll_count
            poll_count += 1
            if poll_count == 1:
                return [], 0
            raise ControlPlaneError("stop after fallback poll", code="WORKER_SESSION_INVALID")

        async def close(self) -> None:
            return None

    class FailingRelay:
        def __init__(self, **_kwargs: object) -> None:
            pass

        async def read(self, limit: int = 20) -> list[dict[str, object]]:
            del limit
            raise RuntimeError("relay unavailable")

        async def close(self) -> None:
            return None

    monkeypatch.setattr(consumer_v2, "WorkerV2Client", FakeClient)
    monkeypatch.setattr(consumer_v2, "RedisHintClient", FailingRelay)

    with pytest.raises(ControlPlaneError, match="stop after fallback poll"):
        await consumer_v2.run_worker("test-worker")

    assert poll_count == 2
