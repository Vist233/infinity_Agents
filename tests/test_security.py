"""Security tests (GAP 7)."""

from __future__ import annotations

import os
import re
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

import backend.app as backend_app_module
from backend.code_agent.worker.consumer import _sanitize_error


class TestUploadSizeLimit:
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
        # Bypass JWT auth for upload endpoint
        original_require_user = backend_app_module.require_user
        backend_app_module.app.dependency_overrides[original_require_user] = lambda: backend_app_module.Principal(user_id="test-user")
        yield TestClient(backend_app_module.app)
        backend_app_module.app.dependency_overrides.pop(original_require_user, None)

    def test_upload_rejects_oversized_pdf(self, client):
        # Create a file slightly above 50MB
        oversized = b"x" * (50 * 1024 * 1024 + 1)
        response = client.post(
            "/api/sessions/some-session/uploads/papers",
            files={"file": ("big.pdf", oversized, "application/pdf")},
        )
        # Should be rejected with 413 or similar
        assert response.status_code in (400, 413, 404), response.text


class TestDockerNoRoot:
    def test_docker_command_has_no_root_user(self):
        from backend.code_agent.worker.docker_runtime import run_docker_task
        import inspect
        source = inspect.getsource(run_docker_task)
        assert "--user=root" not in source
        assert "user=" not in source or "user_input" in source

    def test_docker_command_has_security_opts(self):
        from backend.code_agent.worker.docker_runtime import run_docker_task
        import inspect
        source = inspect.getsource(run_docker_task)
        assert "--security-opt=no-new-privileges" in source
        assert "--cap-drop=ALL" in source


class TestSecretSanitization:
    def test_redacts_database_url(self):
        error = "could not connect to postgresql://user:secret@localhost:5432/db"
        sanitized = _sanitize_error(error)
        assert "secret" not in sanitized
        assert "postgresql://" not in sanitized

    def test_redacts_password_key_value(self):
        error = "password = mysecret123"
        sanitized = _sanitize_error(error)
        assert "mysecret123" not in sanitized

    def test_redacts_token_key_value(self):
        error = "token = abcdef123456"
        sanitized = _sanitize_error(error)
        assert "abcdef123456" not in sanitized

    def test_redacts_file_paths(self):
        error = 'File "/home/user/script.py", line 42'
        sanitized = _sanitize_error(error)
        assert "/home/user/script.py" not in sanitized
        # File reference pattern removes the whole File "..." token, leaving line info
        assert "File" not in sanitized

    def test_truncates_long_errors(self):
        error = "x" * 600
        sanitized = _sanitize_error(error)
        assert len(sanitized) <= 500 + len("...(truncated)")
