"""Tests for cancellation handling (GAP 4)."""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from unittest.mock import AsyncMock, Mock, patch

import pytest
from fastapi.testclient import TestClient

import backend.app as backend_app_module
from backend.code_agent.worker.consumer import _process_next_task
from backend.code_agent.worker.docker_runtime import run_docker_task


# ===========================================================================
# Sync API tests for cancel endpoint
# ===========================================================================


class _CancelFakeConn:
    def __init__(self, rows):
        self._rows = rows
        self._updates = []

    async def fetchrow(self, query, *args):
        qu = query.strip().upper()
        if qu.startswith("UPDATE"):
            self._updates.append((query, args))
        if "TASKS" in qu and "WHERE" in qu:
            for row in self._rows:
                if str(row.get("task_id")) == str(args[0]):
                    return row
        if "INSERT" in qu:
            if "TASK_ATTEMPTS" in qu:
                return {"task_attempt_id": 1}
            if "TASK_EVENTS" in qu:
                return {"task_event_id": 1, "created_at": datetime(2026, 1, 1, tzinfo=timezone.utc)}
            if "OUTBOX_EVENTS" in qu:
                return {"outbox_event_id": 1, "created_at": datetime(2026, 1, 1, tzinfo=timezone.utc)}
        if "UPDATE tasks" in qu and "RETURNING" in qu:
            for row in self._rows:
                if str(row.get("task_id")) == str(args[0]):
                    return row
        return None

    async def fetch(self, query, *args):
        return self._rows

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


class _CancelFakePool:
    def __init__(self, rows):
        self._rows = rows
        self.conn = _CancelFakeConn(rows)

    def acquire(self):
        class _CM:
            def __init__(self, conn):
                self._conn = conn
            async def __aenter__(self):
                return self._conn
            async def __aexit__(self, *args):
                pass
        return _CM(self.conn)


def _make_task_row(task_id="task-1", status="running", cancel_requested_at=None):
    return {
        "task_id": task_id,
        "task_spec_id": "spec-1",
        "dataset_snapshot_id": "ds-1",
        "project_id": "proj-1",
        "title": "T",
        "status": status,
        "lease_owner": "worker-1",
        "lease_token": "token-1",
        "lease_expires_at": datetime(2026, 1, 2, tzinfo=timezone.utc),
        "active_attempt_id": None,
        "attempt_count": 1,
        "max_attempts": 3,
        "result_artifact_id": None,
        "error_message": None,
        "created_by": None,
        "created_at": datetime(2026, 1, 1, tzinfo=timezone.utc),
        "updated_at": datetime(2026, 1, 1, tzinfo=timezone.utc),
        "finished_at": None,
        "cancel_requested_at": cancel_requested_at,
    }


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("LOCAL_DEV_OPEN_TASK_API", "1")
    monkeypatch.delenv("AUTH_REQUIRED_TASK_API", raising=False)
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
    client = TestClient(backend_app_module.app)
    try:
        yield client
    finally:
        client.close()


class TestCancelEndpoint:
    def test_cancel_running_task_sets_cancel_requested_at(self, client, monkeypatch):
        rows = [_make_task_row(status="running", cancel_requested_at=None)]
        pool = _CancelFakePool(rows)
        backend_app_module.app.state.db_pool = pool

        r = client.post("/api/tasks/task-1/cancel")
        assert r.status_code == 200, r.text
        data = r.json()
        assert data.get("cancel_requested") is True
        assert data["status"] == "running"

        # Verify cancel_requested_at was set
        queries = [q for q, _ in pool.conn._updates]
        assert any("cancel_requested_at" in q for q in queries), queries

    def test_cancel_queued_task_sets_status_directly(self, client, monkeypatch):
        rows = [_make_task_row(status="queued", cancel_requested_at=None)]
        pool = _CancelFakePool(rows)
        backend_app_module.app.state.db_pool = pool

        r = client.post("/api/tasks/task-1/cancel")
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["status"] == "cancelled"

        # Verify status was updated to cancelled
        queries = [q for q, _ in pool.conn._updates]
        args_list = [a for _, a in pool.conn._updates]
        assert any("UPDATE tasks" in q and "status" in q for q in queries), queries
        assert any(a[1] == "cancelled" for a in args_list), args_list


# ===========================================================================
# Async tests for docker runtime cancellation
# ===========================================================================


class TestDockerRuntimeCancellation:
    @pytest.mark.asyncio
    async def test_run_docker_task_stops_on_cancel_event(self):
        cancel_event = asyncio.Event()

        proc_mock = AsyncMock()
        # AsyncMock's default pid coerces to 1 on Linux. Keep the test from
        # ever signalling a real process group while exercising cancellation.
        proc_mock.pid = 99999999
        proc_mock.stdout.readline = AsyncMock(side_effect=[b"line1\n", b""])
        proc_mock.wait = AsyncMock(return_value=None)
        proc_mock.returncode = 0
        proc_mock.terminate = Mock()
        proc_mock.kill = Mock()

        with patch("backend.code_agent.worker.docker_runtime.asyncio.create_subprocess_exec", AsyncMock(return_value=proc_mock)):
            events = []
            async for event in run_docker_task(
                task_id="task-1",
                task_spec_id="spec-1",
                dataset_snapshot_id="ds-1",
                cancel_event=cancel_event,
            ):
                events.append(event)
                if event.get("type") == "chunk":
                    cancel_event.set()

        assert any(e.get("type") == "cancelled" for e in events), events
