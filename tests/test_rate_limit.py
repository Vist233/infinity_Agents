"""Rate-limiting tests for paperAgent (basic tier: 3 requests / minute).

Covers:
- Fixed-window counter: allows up to `limit`, rejects the next request
- Window expiry: counter resets after the TTL
- Action isolation: chat and create_session counters are independent
- Fail-open: Redis unavailable → requests are allowed (availability first)
- app._check_user_rate_limit wiring (env-configurable limit/window)
"""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, patch

import pytest

from backend.code_agent.redis_client import RedisClient


def _make_client_with_fake_redis():
    """RedisClient with a mocked underlying connection (in-memory counters)."""
    client = RedisClient("redis://mock/0")
    store: dict[str, str] = {}
    fake = AsyncMock()

    async def fake_get(key):
        return store.get(key)

    async def fake_set(key, value, ex=None):
        store[key] = str(value)

    async def fake_incr(key):
        store[key] = str(int(store.get(key, "0")) + 1)
        return int(store[key])

    fake.get = AsyncMock(side_effect=fake_get)
    fake.set = AsyncMock(side_effect=fake_set)
    fake.incr = AsyncMock(side_effect=fake_incr)
    client._client = fake
    return client, store


class TestCheckRateLimit:
    """RedisClient.check_rate_limit fixed-window semantics."""

    @pytest.mark.asyncio
    async def test_allows_up_to_limit_then_rejects(self):
        client, _ = _make_client_with_fake_redis()
        results = []
        for _ in range(5):
            allowed, remaining = await client.check_rate_limit("u1", 3, 60, action="chat")
            results.append(allowed)
        # Basic tier: exactly 3 allowed, then rejected.
        assert results == [True, True, True, False, False]

    @pytest.mark.asyncio
    async def test_users_are_isolated(self):
        client, _ = _make_client_with_fake_redis()
        for _ in range(3):
            allowed, _ = await client.check_rate_limit("u1", 3, 60, action="chat")
            assert allowed
        # u1 exhausted; u2 still has quota.
        allowed, _ = await client.check_rate_limit("u1", 3, 60, action="chat")
        assert not allowed
        allowed, _ = await client.check_rate_limit("u2", 3, 60, action="chat")
        assert allowed

    @pytest.mark.asyncio
    async def test_actions_are_isolated(self):
        client, store = _make_client_with_fake_redis()
        for _ in range(3):
            await client.check_rate_limit("u1", 3, 60, action="chat")
        # chat quota exhausted, create_session quota untouched.
        allowed, _ = await client.check_rate_limit("u1", 3, 60, action="chat")
        assert not allowed
        allowed, _ = await client.check_rate_limit("u1", 3, 60, action="create_session")
        assert allowed
        assert "rate:user:u1:chat" in store
        assert "rate:user:u1:create_session" in store

    @pytest.mark.asyncio
    async def test_window_expiry_resets_counter(self):
        client, store = _make_client_with_fake_redis()
        for _ in range(3):
            await client.check_rate_limit("u1", 3, 60, action="chat")
        allowed, _ = await client.check_rate_limit("u1", 3, 60, action="chat")
        assert not allowed
        # Simulate TTL expiry (Redis would drop the key after window_seconds).
        store.clear()
        allowed, _ = await client.check_rate_limit("u1", 3, 60, action="chat")
        assert allowed

    @pytest.mark.asyncio
    async def test_fails_open_when_disconnected(self):
        client = RedisClient("redis://nonexistent:9999/0")  # never connected
        for _ in range(10):
            allowed, remaining = await client.check_rate_limit("u1", 3, 60, action="chat")
            assert allowed
            assert remaining == 3

    @pytest.mark.asyncio
    async def test_fails_open_on_redis_error(self):
        client, _ = _make_client_with_fake_redis()
        client._client.eval = AsyncMock(side_effect=ConnectionError("boom"))
        client._client.incr = AsyncMock(side_effect=ConnectionError("boom"))
        allowed, remaining = await client.check_rate_limit("u1", 3, 60, action="chat")
        assert allowed
        assert remaining == 3


class TestAppRateLimitWiring:
    """backend.app._check_user_rate_limit env wiring."""

    @pytest.mark.asyncio
    async def test_defaults_are_3_per_60s(self):
        from backend import app as app_module

        limit, window = app_module._rate_limit_settings()
        assert limit == 3
        assert window == 60

    @pytest.mark.asyncio
    async def test_env_overrides(self):
        from backend import app as app_module

        with patch.dict("os.environ", {"PAPER_CHAT_RATE_LIMIT": "10", "PAPER_CHAT_RATE_WINDOW": "120"}):
            limit, window = app_module._rate_limit_settings()
        assert (limit, window) == (10, 120)

    @pytest.mark.asyncio
    async def test_fail_open_without_redis_client(self):
        from backend import app as app_module

        with patch.object(app_module, "get_redis_client", return_value=None):
            allowed, _ = await app_module._check_user_rate_limit("u1", "chat")
        assert allowed

    @pytest.mark.asyncio
    async def test_fail_open_when_redis_disconnected(self):
        from backend import app as app_module

        disconnected = RedisClient("redis://nonexistent:9999/0")
        with patch.object(app_module, "get_redis_client", return_value=disconnected):
            allowed, _ = await app_module._check_user_rate_limit("u1", "chat")
        assert allowed

    @pytest.mark.asyncio
    async def test_rejects_when_quota_exhausted(self):
        from backend import app as app_module

        client, _ = _make_client_with_fake_redis()
        with patch.object(app_module, "get_redis_client", return_value=client):
            for _ in range(3):
                allowed, _ = await app_module._check_user_rate_limit("u1", "chat")
                assert allowed
            allowed, _ = await app_module._check_user_rate_limit("u1", "chat")
            assert not allowed
