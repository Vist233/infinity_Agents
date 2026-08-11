"""Unit tests for Redis worker-heartbeat discovery."""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest

from backend.code_agent.redis_client import RedisClient


@pytest.mark.asyncio
async def test_alive_workers_uses_bounded_scan_batches() -> None:
    client = RedisClient("redis://mock/0")
    fake = AsyncMock()
    fake.scan = AsyncMock(
        side_effect=[
            (1, ["worker:alpha"]),
            (0, ["worker:beta"]),
        ]
    )
    fake.keys = AsyncMock(side_effect=AssertionError("KEYS must not be used"))
    client._client = fake

    assert await client.get_alive_workers() == ["alpha", "beta"]
    assert fake.scan.await_count == 2
    fake.keys.assert_not_awaited()
