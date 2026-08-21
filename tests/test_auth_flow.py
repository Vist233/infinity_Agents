"""Tests for the shared-user auth system (L4+).

All users are mapped to the shared local-admin Principal.
No OIDC, no session cookies, no login flow.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

import backend.app as app_module
from backend.auth import require_user, SHARED_PRINCIPAL


def _make_client():
    """Create a test client with mocked DB pools."""

    async def fake_init_db(app):
        app.state.db_pool = None

    async def fake_close_db(_app):
        return None

    # Override lifespan-dependent functions for test isolation
    app_module.init_db = fake_init_db
    app_module.close_db = fake_close_db
    return TestClient(app_module.app)


def test_shared_principal_is_fixed():
    """SHARED_PRINCIPAL must be the local-admin superuser."""
    assert SHARED_PRINCIPAL.user_id == "local-admin"
    assert SHARED_PRINCIPAL.issuer == "local-shared"
    assert SHARED_PRINCIPAL.subject == "local-admin"
    assert "superuser" in SHARED_PRINCIPAL.roles


def test_auth_me_returns_shared_user():
    """GET /auth/me must return the shared user without any login."""
    with _make_client() as client:
        resp = client.get("/auth/me")
        assert resp.status_code == 200
        data = resp.json()
        assert data["user_id"] == "local-admin"
        assert data["issuer"] == "local-shared"


def test_auth_login_redirects_to_task_center():
    """GET /auth/login must redirect (no OIDC flow)."""
    with _make_client() as client:
        resp = client.get("/auth/login", follow_redirects=False)
        assert resp.status_code == 302
        location = resp.headers["location"]
        assert location.startswith("/task-center") or location == "/"


def test_auth_logout_redirects():
    """POST /auth/logout must redirect."""
    with _make_client() as client:
        resp = client.post("/auth/logout", follow_redirects=False)
        assert resp.status_code == 302


def test_health_endpoint_returns_status():
    """GET /health must return without auth."""
    with _make_client() as client:
        resp = client.get("/health")
        assert resp.status_code == 200
        data = resp.json()
        assert "status" in data
        assert "postgres" in data
        assert "redis" in data
