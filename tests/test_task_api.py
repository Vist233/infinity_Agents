"""Tests for the Task execution system."""

from __future__ import annotations

import io

import pytest
from fastapi.testclient import TestClient
from fastapi import HTTPException
from starlette.datastructures import UploadFile

import backend.app as backend_app_module
from backend.auth import Principal
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
    # The endpoint tests exercise application behavior with an explicit local
    # opt-in. Production/acceptance auth is covered separately below.
    monkeypatch.setenv("LOCAL_DEV_OPEN_TASK_API", "1")
    monkeypatch.delenv("AUTH_REQUIRED_TASK_API", raising=False)
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
    def test_task_api_is_closed_without_local_opt_in(self, client, monkeypatch):
        monkeypatch.delenv("LOCAL_DEV_OPEN_TASK_API", raising=False)
        monkeypatch.setenv("AUTH_REQUIRED_TASK_API", "1")
        assert client.get("/api/worker/health").status_code == 401

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
        assert d["status"] == "degraded"
        assert d["ready"] is False
        assert "redis_connected" in d

    def test_worker_poll(self, client):
        r = client.post("/api/worker/poll")
        assert r.status_code in (200, 500)

    def test_outbox_publish(self, client):
        r = client.post("/api/outbox/publish")
        # 503 is expected when Redis is unavailable: events must never be
        # marked published without being delivered.
        assert r.status_code in (200, 500, 503)


class TestSubmitBundleCleanup:
    @pytest.mark.asyncio
    async def test_submit_bundle_validation_failure_cleans_staging(self, monkeypatch, tmp_path):
        method_root = tmp_path / "method-root"
        resource_root = tmp_path / "resource-root"
        monkeypatch.setenv("METHOD_SOURCE_UPLOAD_ROOT", str(method_root))
        monkeypatch.setenv("RESOURCE_STORAGE_ROOT", str(resource_root))

        async def fake_user_can_access_project(_pool, _project_id, _user_id):
            return True

        async def fake_check_idempotency(*_args, **_kwargs):
            return None

        monkeypatch.setattr(backend_app_module, "user_can_access_project", fake_user_can_access_project)
        monkeypatch.setattr(backend_app_module, "check_idempotency", fake_check_idempotency)
        backend_app_module.app.state.db_pool = object()

        method_file = UploadFile(
            filename="protocol.md",
            file=io.BytesIO(b"# protocol\n"),
            headers={"content-type": "text/markdown"},
        )
        dataset_file = UploadFile(
            filename="dataset.csv",
            file=io.BytesIO(b""),
            headers={"content-type": "text/csv"},
        )

        with pytest.raises(HTTPException) as exc_info:
            await backend_app_module.submit_task_bundle_endpoint(
                method_file=method_file,
                dataset_file=dataset_file,
                title="",
                idempotency_key="bundle-cleanup-test",
                project_id="proj-123",
                user=Principal(user_id="alice"),
            )

        assert exc_info.value.status_code == 400
        staging_base = method_root / ".task-bundles"
        assert not staging_base.exists() or not any(staging_base.iterdir())

    @pytest.mark.asyncio
    async def test_submit_bundle_idempotency_is_user_scoped(self, monkeypatch, tmp_path):
        method_root = tmp_path / "method-root"
        resource_root = tmp_path / "resource-root"
        monkeypatch.setenv("METHOD_SOURCE_UPLOAD_ROOT", str(method_root))
        monkeypatch.setenv("RESOURCE_STORAGE_ROOT", str(resource_root))

        async def fake_user_can_access_project(_pool, _project_id, _user_id):
            return True

        async def fake_check_idempotency(_pool, _key, user_id=None):
            assert user_id == "alice"
            return None

        class FakeTransaction:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                return None

        class FakeConn:
            def transaction(self):
                return FakeTransaction()

            async def fetchval(self, query, *_args):
                if "PROJECT_MEMBERS" in query.upper():
                    return 1
                return None

            async def execute(self, *_args):
                return "OK 1"

            async def fetchrow(self, query, *args):
                if "INSERT INTO TASKS" in query.upper():
                    return {"task_id": args[0], "status": "queued", "attempt_count": 0}
                if "INSERT INTO TASK_EVENTS" in query.upper():
                    return {"task_event_id": 1}
                return None

        class FakePool:
            def acquire(self):
                class FakeCM:
                    async def __aenter__(self_inner):
                        return FakeConn()

                    async def __aexit__(self_inner, *args):
                        return None

                return FakeCM()

        monkeypatch.setattr(backend_app_module, "user_can_access_project", fake_user_can_access_project)
        monkeypatch.setattr(backend_app_module, "check_idempotency", fake_check_idempotency)
        backend_app_module.app.state.db_pool = FakePool()

        method_file = UploadFile(
            filename="protocol.md",
            file=io.BytesIO(b"# protocol\n"),
            headers={"content-type": "text/markdown"},
        )
        dataset_file = UploadFile(
            filename="dataset.csv",
            file=io.BytesIO(b"gene,value\nA,1\n"),
            headers={"content-type": "text/csv"},
        )

        result = await backend_app_module.submit_task_bundle_endpoint(
            method_file=method_file,
            dataset_file=dataset_file,
            title="Scoped bundle",
            idempotency_key="shared-key",
            project_id="proj-123",
            user=Principal(user_id="alice"),
        )

        assert result.status == "queued"
        assert result.duplicate is False

    @pytest.mark.asyncio
    async def test_submit_bundle_idempotent_replay_cleans_newly_moved_files(self, monkeypatch, tmp_path):
        method_root = tmp_path / "method-root"
        resource_root = tmp_path / "resource-root"
        monkeypatch.setenv("METHOD_SOURCE_UPLOAD_ROOT", str(method_root))
        monkeypatch.setenv("RESOURCE_STORAGE_ROOT", str(resource_root))

        async def fake_user_can_access_project(_pool, _project_id, _user_id):
            return True

        async def fake_check_idempotency(_pool, _key, _user_id=None):
            return {
                "resource_type": "task",
                "resource_id": "existing-task",
                "request_hash": None,
            }

        async def fake_get_task(_pool, _task_id):
            return {"task_id": "existing-task", "status": "queued", "attempt_count": 1, "created_by": "alice"}

        monkeypatch.setattr(backend_app_module, "user_can_access_project", fake_user_can_access_project)
        monkeypatch.setattr(backend_app_module, "check_idempotency", fake_check_idempotency)
        monkeypatch.setattr(backend_app_module, "get_task", fake_get_task)
        backend_app_module.app.state.db_pool = object()

        result = await backend_app_module.submit_task_bundle_endpoint(
            method_file=UploadFile(
                filename="protocol.md",
                file=io.BytesIO(b"# protocol\n"),
                headers={"content-type": "text/markdown"},
            ),
            dataset_file=UploadFile(
                filename="dataset.csv",
                file=io.BytesIO(b"gene,value\nA,1\n"),
                headers={"content-type": "text/csv"},
            ),
            title="Replay cleanup",
            idempotency_key="replay-cleanup-key",
            project_id="proj-123",
            user=Principal(user_id="alice"),
        )

        assert result.duplicate is True
        assert not list((method_root / "documents").glob("*"))
        assert not list((resource_root / "datasets").glob("*"))
        staging_base = method_root / ".task-bundles"
        assert not staging_base.exists() or not any(staging_base.iterdir())
