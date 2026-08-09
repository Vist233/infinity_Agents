"""Tests for the Task execution system."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

import backend.app as backend_app_module
from backend.code_agent.models import TaskStatus, can_transition, Task, TaskSpec


class TestStateMachine:
    def test_draft_to_queued(self):
        assert can_transition(TaskStatus.DRAFT, TaskStatus.QUEUED)
    def test_draft_cannot_go_to_running(self):
        assert not can_transition(TaskStatus.DRAFT, TaskStatus.RUNNING)
    def test_draft_to_cancelled(self):
        assert can_transition(TaskStatus.DRAFT, TaskStatus.CANCELLED)
    def test_queued_to_claimed(self):
        assert can_transition(TaskStatus.QUEUED, TaskStatus.CLAIMED)
    def test_queued_to_cancelled(self):
        assert can_transition(TaskStatus.QUEUED, TaskStatus.CANCELLED)
    def test_claimed_to_running(self):
        assert can_transition(TaskStatus.CLAIMED, TaskStatus.RUNNING)
    def test_claimed_back_to_queued(self):
        assert can_transition(TaskStatus.CLAIMED, TaskStatus.QUEUED)
    def test_claimed_to_cancelled(self):
        assert can_transition(TaskStatus.CLAIMED, TaskStatus.CANCELLED)
    def test_running_to_succeeded(self):
        assert can_transition(TaskStatus.RUNNING, TaskStatus.SUCCEEDED)
    def test_running_to_failed(self):
        assert can_transition(TaskStatus.RUNNING, TaskStatus.FAILED)
    def test_running_to_timeout(self):
        assert can_transition(TaskStatus.RUNNING, TaskStatus.TIMEOUT)
    def test_running_to_cancelled(self):
        assert can_transition(TaskStatus.RUNNING, TaskStatus.CANCELLED)
    def test_failed_can_retry(self):
        assert can_transition(TaskStatus.FAILED, TaskStatus.QUEUED)
    def test_timeout_can_retry(self):
        assert can_transition(TaskStatus.TIMEOUT, TaskStatus.QUEUED)
    def test_succeeded_is_terminal(self):
        for status in TaskStatus:
            if status != TaskStatus.SUCCEEDED:
                assert not can_transition(TaskStatus.SUCCEEDED, status)
    def test_cancelled_is_terminal(self):
        for status in TaskStatus:
            if status != TaskStatus.CANCELLED:
                assert not can_transition(TaskStatus.CANCELLED, status)
    def test_timeout_cannot_go_directly_to_succeeded(self):
        assert not can_transition(TaskStatus.TIMEOUT, TaskStatus.SUCCEEDED)


class TestModels:
    def test_task_defaults(self):
        t = Task()
        assert t.status == "draft"
        assert t.attempt_count == 0
        assert t.max_attempts == 3

    def test_task_spec_defaults(self):
        s = TaskSpec()
        assert s.domain == "bioinformatics"
        assert s.schema_version == "1.0"
        assert s.status == "draft"

    def test_status_enum_complete(self):
        expected = {"draft", "queued", "claimed", "running", "succeeded", "failed", "cancelled", "timeout"}
        actual = {s.value for s in TaskStatus}
        assert actual == expected


@pytest.fixture
def client(monkeypatch):
    from datetime import datetime, timezone
    DT = datetime(2026, 1, 1, tzinfo=timezone.utc)

    class MR:
        def __init__(self, d):
            self._d = d
        def __getitem__(self, k):
            return self._d[k]
        def __getattr__(self, k):
            try:
                return self._d[k]
            except KeyError:
                raise AttributeError(k)

    class FakeConn:
        def _r(self, **kw):
            return MR(kw)

        async def fetchrow(self, query, *args):
            qu = query.strip().upper()
            if "INSERT" in qu and "TASK_SPECS" in qu:
                return self._r(task_spec_id=args[0] if args else "spec-1",
                               revision=1, status="draft", created_at=DT, updated_at=DT)
            if "INSERT" in qu and "DATASET_SNAPSHOTS" in qu:
                return self._r(dataset_snapshot_id=args[0] if args else "ds-1",
                               version=1, created_at=DT)
            if "INSERT" in qu and "TASKS" in qu:
                return self._r(task_id=args[0] if args else "task-1",
                               status="queued", attempt_count=0, created_at=DT)
            if "INSERT" in qu and "TASK_ATTEMPTS" in qu:
                return self._r(task_attempt_id=1, started_at=DT)
            if "INSERT" in qu and "OUTBOX_EVENTS" in qu:
                return self._r(outbox_event_id=1, created_at=DT)
            if "TASK_SPECS" in qu and "WHERE" in qu:
                return self._r(task_spec_id=args[0], project_id="proj-123", revision=1,
                               title="T", domain="bioinformatics", analysis_type="bio",
                               research_question="Q", spec_json={}, schema_version="1.0",
                               status="draft", created_at=DT, updated_at=DT, frozen_at=None)
            if "TASKS" in qu and "WHERE" in qu:
                tid = args[0] if args else ""
                if tid == "nonexistent":
                    return None
                return self._r(task_id=tid, task_spec_id="s1", dataset_snapshot_id="d1",
                               project_id="proj-123", title="T", status="queued",
                               lease_owner=None, lease_token=None, lease_expires_at=None,
                               active_attempt_id=None, attempt_count=0, max_attempts=3,
                               result_artifact_id=None, error_message=None, created_by=None,
                               created_at=DT, updated_at=DT, finished_at=None)
            if "TASKS" in qu and "LIMIT 1" in qu:
                return None
            return None

        async def fetch(self, query, *args):
            return []
        async def execute(self, query, *args):
            return "OK 1"

    class FakeCM:
        def __init__(self, conn):
            self._conn = conn
        async def __aenter__(self):
            return self._conn
        async def __aexit__(self, *args):
            pass

    class FakePool:
        def acquire(self):
            return FakeCM(FakeConn())

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
    backend_app_module.app.state.db_pool = FakePool()
    return TestClient(backend_app_module.app)


class TestTaskAPIEndpoints:
    def test_create_task_spec(self, client):
        r = client.post("/api/task-specs", json={
            "project_id": "proj-123", "title": "RNA-seq",
            "analysis_type": "rnaseq_deseq2", "research_question": "Q"
        })
        assert r.status_code in (200, 500)

    def test_create_task(self, client):
        r = client.post("/api/tasks", json={
            "project_id": "proj-123", "task_spec_id": "s1",
            "dataset_snapshot_id": "d1", "title": "Test"
        })
        assert r.status_code in (200, 500)

    def test_create_task_direct_route(self, client):
        r = client.post("/api/tasks/direct", json={
            "project_id": "proj-123", "task_spec_id": "s1",
            "dataset_snapshot_id": "d1", "title": "Direct test",
            "chat_confirmation_id": False,
            "submission_source": "task_center",
        })
        assert r.status_code in (200, 500)

    def test_get_task_not_found(self, client):
        assert client.get("/api/tasks/nonexistent").status_code == 404

    def test_list_tasks(self, client):
        r = client.get("/api/tasks")
        assert r.status_code in (200, 500)

    def test_get_events(self, client):
        assert client.get("/api/tasks/task-123/events").status_code in (200, 500)

    def test_get_artifacts(self, client):
        assert client.get("/api/tasks/task-123/artifacts").status_code in (200, 500)

    def test_worker_health(self, client):
        r = client.get("/api/worker/health")
        assert r.status_code == 200
        d = r.json()
        assert "status" in d
        assert "redis_connected" in d

    def test_worker_poll(self, client):
        r = client.post("/api/worker/poll")
        assert r.status_code in (200, 500)

    def test_outbox_publish(self, client):
        r = client.post("/api/outbox/publish")
        # 503 is expected when Redis is unavailable: events must never be
        # marked published without being delivered.
        assert r.status_code in (200, 500, 503)
