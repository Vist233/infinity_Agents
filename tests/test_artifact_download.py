"""Tests for artifact download endpoint (GAP 1)."""

from __future__ import annotations

import os
import zipfile
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

import backend.app as backend_app_module
from backend.code_agent.task_service import create_artifact, get_artifacts_for_task


class _FakeConn:
    def __init__(self, rows):
        self._rows = rows

    async def fetchrow(self, query, *args):
        qu = query.strip().upper()
        if "ARTIFACTS" in qu and "WHERE" in qu:
            for row in self._rows:
                if row.get("artifact_id") == args[0]:
                    return row
        return None

    async def fetch(self, query, *args):
        return self._rows

    async def execute(self, query, *args):
        return "OK 1"


class _FakePool:
    def __init__(self, rows):
        self._rows = rows

    def acquire(self):
        class _CM:
            def __init__(self, rows):
                self._rows = rows
            async def __aenter__(self):
                return _FakeConn(self._rows)
            async def __aexit__(self, *args):
                pass
        return _CM(self._rows)


@pytest.fixture
def client(monkeypatch, tmp_path):
    from datetime import datetime, timezone
    DT = datetime(2026, 1, 1, tzinfo=timezone.utc)

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

    # We will patch pool per test
    yield TestClient(backend_app_module.app)


def _make_artifact_row(artifact_id="art-1", task_id="task-1", storage_path="/tmp/artifact.zip", content_type="application/zip"):
    from datetime import datetime, timezone
    DT = datetime(2026, 1, 1, tzinfo=timezone.utc)
    return {
        "artifact_id": artifact_id,
        "task_id": task_id,
        "task_attempt_id": 1,
        "name": "result",
        "kind": "result_archive",
        "storage_backend": "local",
        "storage_path": storage_path,
        "file_size_bytes": 100,
        "checksum_sha256": "abc123",
        "content_type": content_type,
        "metadata": {},
        "created_at": DT,
    }


class TestArtifactDownloadEndpoint:
    def test_download_existing_artifact(self, client, tmp_path, monkeypatch):
        monkeypatch.setenv("ARTIFACT_DOWNLOAD_ROOT", str(tmp_path))
        zip_path = tmp_path / "result.zip"
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.writestr("test.txt", "hello")
        row = _make_artifact_row(storage_path=str(zip_path))
        monkeypatch.setattr(backend_app_module, "app", backend_app_module.app)
        # Patch pool in app state
        backend_app_module.app.state.db_pool = _FakePool([row])

        r = client.get(f"/api/artifacts/{row['artifact_id']}")
        assert r.status_code == 200, r.text
        assert r.headers["content-type"] == "application/zip"
        assert r.content == zip_path.read_bytes()

    def test_download_missing_artifact_returns_404(self, client, monkeypatch):
        monkeypatch.setenv("ARTIFACT_DOWNLOAD_ROOT", "/tmp/task-outputs")
        monkeypatch.setattr(backend_app_module, "app", backend_app_module.app)
        backend_app_module.app.state.db_pool = _FakePool([])
        r = client.get("/api/artifacts/nonexistent")
        assert r.status_code == 404

    def test_download_rejects_path_traversal(self, client, monkeypatch, tmp_path):
        monkeypatch.setenv("ARTIFACT_DOWNLOAD_ROOT", str(tmp_path))
        # Create a file outside allowed dir to simulate traversal
        secret = tmp_path.parent / "secret.txt"
        secret.write_text("secret")
        row = _make_artifact_row(storage_path=str(secret))
        monkeypatch.setattr(backend_app_module, "app", backend_app_module.app)
        backend_app_module.app.state.db_pool = _FakePool([row])

        r = client.get(f"/api/artifacts/{row['artifact_id']}")
        # Should reject serving files outside the task output area
        assert r.status_code in (400, 403, 404), r.text

    def test_download_rejects_symlink_escape(self, client, monkeypatch, tmp_path):
        monkeypatch.setenv("ARTIFACT_DOWNLOAD_ROOT", str(tmp_path))
        # Target is OUTSIDE the allowed root
        target = tmp_path.parent / "real.txt"
        target.write_text("real")
        link = tmp_path / "link.zip"
        link.symlink_to(target)
        row = _make_artifact_row(storage_path=str(link))
        monkeypatch.setattr(backend_app_module, "app", backend_app_module.app)
        backend_app_module.app.state.db_pool = _FakePool([row])

        r = client.get(f"/api/artifacts/{row['artifact_id']}")
        # Should reject symlinks or resolve and check bounds
        assert r.status_code in (400, 403, 404), r.text
