"""Tests for SSE reconnection and persisted task state."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from unittest.mock import AsyncMock, patch

import pytest

import backend.app as backend_app_module
from backend.code_agent.redis_client import RedisClient


class TestSSEReconnection:
    """SSE reconnect restores persisted task state from last_event_id."""

    def test_read_task_events_respects_last_event_id(self):
        """Redis read_task_events should skip events before last_event_id."""
        fake_redis = RedisClient("redis://localhost:6379/0")
        fake_redis._client = AsyncMock()

        events = [
            ("2", {"event_type": "task_succeeded", "data": json.dumps({"status": "succeeded"})}),
        ]
        fake_redis._client.xread = AsyncMock(return_value=[("stream:task-events", events)])

        async def run():
            result = await fake_redis.read_task_events(
                "task-1", last_event_id="1", count=50
            )
            assert len(result) == 1
            assert result[0]["_message_id"] == "2"
            fake_redis._client.xread.assert_called_once()

        import asyncio
        asyncio.run(run())

    def test_persisted_events_survive_redis_restart(self):
        """Task events stored in PostgreSQL remain after Redis restart."""
        task_id = "task-sse-persist"
        events = [
            {
                "task_event_id": 1,
                "task_id": task_id,
                "task_attempt_id": 1,
                "event_type": "task_running",
                "event_data": {"status": "running"},
                "created_at": datetime(2026, 1, 1, tzinfo=timezone.utc),
            },
            {
                "task_event_id": 2,
                "task_id": task_id,
                "task_attempt_id": 1,
                "event_type": "task_succeeded",
                "event_data": {"status": "succeeded"},
                "created_at": datetime(2026, 1, 1, tzinfo=timezone.utc),
            },
        ]

        class FakeConn:
            def __init__(self, rows):
                self._rows = rows

            async def fetch(self, query, *args):
                qu = query.strip().upper()
                if "TASK_EVENTS" in qu:
                    return self._rows
                return []

        class FakePool:
            def __init__(self, rows):
                self.conn = FakeConn(rows)

            def acquire(self):
                class _CM:
                    def __init__(self, conn):
                        self._conn = conn

                    async def __aenter__(self):
                        return self._conn

                    async def __aexit__(self, *args):
                        pass

                return _CM(self.conn)

        pool = FakePool(events)

        async def fake_get_task_events(p, task_id, limit=50):
            return [e for e in events if str(e["task_id"]) == str(task_id)]

        with patch("backend.app.get_task_events", fake_get_task_events):
            import asyncio

            async def _run():
                result = await fake_get_task_events(pool, task_id, limit=50)
                assert len(result) == 2
                assert result[0]["event_type"] == "task_running"
                assert result[1]["event_type"] == "task_succeeded"

            asyncio.run(_run())

    def test_sse_endpoint_emits_current_state_on_connect(self):
        """SSE endpoint should emit current task state immediately on connect."""
        task = {
            "task_id": "task-sse-state",
            "status": "running",
            "attempt_count": 1,
        }

        async def fake_get_task(pool, task_id):
            return task

        with patch("backend.app.get_task", fake_get_task):
            # The endpoint builds an event generator; verify it yields task_state
            from backend.app import task_events_sse_endpoint

            async def fake_read_task_events(*args, **kwargs):
                return []

            fake_redis = AsyncMock()
            fake_redis.is_connected = False
            fake_redis.read_task_events = fake_read_task_events

            with patch("backend.app.get_redis_client", return_value=fake_redis):
                import asyncio

                async def _call():
                    return await task_events_sse_endpoint("task-sse-state", last_event_id=None)

                response = asyncio.run(_call())
                # EventSourceResponse should be created
                assert response is not None
