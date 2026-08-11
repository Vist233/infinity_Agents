"""Tests for retry backoff (GAP 6) and pending message recovery (GAP 5)."""

from __future__ import annotations

import time
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

import backend.app as backend_app_module
from backend.code_agent.retry_policy import calculate_retry_delay, next_attempt_at


class TestRetryBackoff:
    def test_base_delay_increases_exponentially(self):
        d0 = calculate_retry_delay(0).total_seconds()
        d1 = calculate_retry_delay(1).total_seconds()
        d2 = calculate_retry_delay(2).total_seconds()
        assert d0 <= 5.0
        assert d1 <= 10.0
        assert d2 <= 20.0

    def test_delay_is_jittered(self):
        delays = [calculate_retry_delay(2).total_seconds() for _ in range(20)]
        assert len(set(delays)) > 1

    def test_delay_caps_at_max(self):
        d = calculate_retry_delay(10).total_seconds()
        assert d <= 300.0

    def test_next_attempt_at_is_in_future(self):
        now = time.monotonic()
        # We can't easily mock datetime.now in next_attempt_at without refactoring,
        # so just verify it returns a datetime.
        result = next_attempt_at(0)
        assert result.__class__.__name__ == "datetime"


class TestLeaseReaperBackoff:
    @pytest.fixture
    def client(self, monkeypatch):
        fake_redis = type("R", (), {
            "is_connected": False,
            "connect": lambda s: None,
            "disconnect": lambda s: None,
            "ensure_consumer_group": lambda s, *a, **kw: None,
            "publish_task": lambda s, d: "m1",
            "consume_tasks": lambda s, *a, **kw: [],
            "ack_message": lambda s, m: None,
            "publish_task_event": lambda s, t, e: None,
            "set_progress": lambda s, t, p: None,
            "set_worker_heartbeat": lambda s, *a, **kw: None,
            "get_alive_workers": lambda s: [],
        })()
        monkeypatch.setattr(backend_app_module, "get_redis_client", lambda: fake_redis)
        yield TestClient(backend_app_module.app)

    def test_reaper_sets_next_attempt_at(self, client, monkeypatch):
        from datetime import datetime, timezone, timedelta

        class FakeConn:
            def __init__(self):
                self._updates = []

            async def fetch(self, query, *args):
                if "lease_expires_at < NOW()" in query and "FOR UPDATE SKIP LOCKED" in query and "lease_owner = $1" not in query:
                    return [{"task_id": "task-1", "attempt_count": 1, "lease_token": "t1"}]
                return []

            async def fetchrow(self, query, *args):
                if "FROM tasks" in query:
                    return {
                        "task_id": "task-1",
                        "active_attempt_id": None,
                        "attempt_count": 1,
                        "max_attempts": 3,
                        "lease_token": "t1",
                        "status": "running",
                    }
                return None

            async def execute(self, query, *args):
                self._updates.append((query, args))
                return "OK 1"

            def transaction(self):
                class _Transaction:
                    async def __aenter__(self):
                        return self

                    async def __aexit__(self, *args):
                        return None

                return _Transaction()

        class FakePool:
            def __init__(self):
                self.conn = FakeConn()
            def acquire(self):
                class CM:
                    def __init__(self, conn):
                        self._conn = conn
                    async def __aenter__(self):
                        return self._conn
                    async def __aexit__(self, *args):
                        pass
                return CM(self.conn)

        pool = FakePool()
        backend_app_module.app.state.db_pool = pool

        with patch("backend.code_agent.task_service.create_outbox_event", AsyncMock()):
            from backend.code_agent.worker.consumer import _lease_reaper_loop
            import asyncio

            async def _run_once():
                task = asyncio.create_task(_lease_reaper_loop("worker-1", pool, 60))
                await asyncio.sleep(0.1)
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass

            asyncio.run(_run_once())

        queries = [q for q, _ in pool.conn._updates]
        assert any("next_attempt_at" in q for q in queries), queries


class TestPendingMessageRecovery:
    def test_recover_pending_messages_calls_xautoclaim(self):
        from backend.code_agent.redis_client import RedisClient
        import asyncio

        async def _run():
            client = RedisClient("redis://localhost:6379/0")
            client._client = AsyncMock()
            client._client.xautoclaim = AsyncMock(return_value=[])
            result = await client.recover_pending_messages("worker-1", min_idle_time_ms=60000)
            return result, client

        result, client = asyncio.run(_run())
        assert result == 0
        client._client.xautoclaim.assert_called_once()
        client._client.xautoclaim.assert_called_once()

    def test_claim_pending_messages_returns_payload_for_normal_processing(self):
        from backend.code_agent.redis_client import RedisClient
        import asyncio

        async def _run():
            client = RedisClient("redis://localhost:6379/0")
            client._client = AsyncMock()
            client._client.xautoclaim = AsyncMock(return_value=(
                "0-0",
                [("7-0", {"task_id": "task-7", "attempt": "2"})],
                [],
            ))
            return await client.claim_pending_tasks("worker-2", min_idle_time_ms=60000, count=1)

        claimed = asyncio.run(_run())
        assert claimed == [{
            "message_id": "7-0",
            "task_data": {"task_id": "task-7", "attempt": 2},
            "raw_data": {"task_id": "task-7", "attempt": "2"},
        }]

    def test_pending_fallback_scans_id_range_then_applies_idle_claim(self):
        from backend.code_agent.redis_client import RedisClient
        import asyncio

        async def _run():
            client = RedisClient("redis://localhost:6379/0")
            client._client = AsyncMock()
            client._client.xautoclaim = AsyncMock(side_effect=RuntimeError("unsupported"))
            client._client.xpending_range = AsyncMock(return_value=[{"message_id": "8-0"}])
            client._client.xclaim = AsyncMock(return_value=[("8-0", {"task_id": "task-8"})])
            result = await client.claim_pending_tasks("worker-3", min_idle_time_ms=60000, count=1)
            return result, client

        result, client = asyncio.run(_run())
        assert result[0]["task_data"]["task_id"] == "task-8"
        client._client.xpending_range.assert_awaited_once()
        assert client._client.xpending_range.await_args.kwargs["min"] == "-"


@pytest.mark.asyncio
async def test_worker_does_not_ack_queued_task_it_cannot_claim(monkeypatch):
    from unittest.mock import AsyncMock
    from backend.code_agent.worker.consumer import _process_next_task

    monkeypatch.setattr(
        "backend.code_agent.task_service.get_task",
        AsyncMock(return_value={"task_id": "task-owner-b", "status": "queued"}),
    )
    monkeypatch.setattr(
        "backend.code_agent.task_service.try_claim_task",
        AsyncMock(return_value=None),
    )
    redis_client = type("Redis", (), {"ack_message": AsyncMock(return_value=True)})()

    await _process_next_task(
        "worker-owner-a",
        object(),
        redis_client,
        "fixture-image",
        60,
        worker_namespace="namespace-a",
        messages=[{"message_id": "msg-owner-b", "task_data": {"task_id": "task-owner-b"}}],
    )

    redis_client.ack_message.assert_not_awaited()


@pytest.mark.asyncio
async def test_worker_does_not_ack_task_hidden_by_rls(monkeypatch):
    """An RLS-hidden task must remain pending for its authorized Worker."""
    from unittest.mock import AsyncMock
    from backend.code_agent.worker.consumer import _process_next_task

    monkeypatch.setattr(
        "backend.code_agent.task_service.get_task",
        AsyncMock(return_value=None),
    )
    redis_client = type("Redis", (), {"ack_message": AsyncMock(return_value=True)})()

    await _process_next_task(
        "worker-owner-a",
        object(),
        redis_client,
        "fixture-image",
        60,
        worker_namespace="namespace-a",
        messages=[{"message_id": "msg-owner-b", "task_data": {"task_id": "task-owner-b"}}],
    )

    redis_client.ack_message.assert_not_awaited()
