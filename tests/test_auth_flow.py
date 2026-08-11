from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

import backend.app as app_module
from backend.auth import _ensure_session_active, create_session_cookie, principal_from_session_cookie, Principal


def test_local_oidc_stub_completes_pkce_cookie_flow(monkeypatch):
    monkeypatch.setenv("AUTH_DEV_LOGIN_ENABLED", "1")
    monkeypatch.setenv("COOKIE_SECURE", "0")

    async def fake_init_db(app):
        app.state.db_pool = None

    async def fake_close_db(_app):
        return None

    monkeypatch.setattr(app_module, "init_db", fake_init_db)
    monkeypatch.setattr(app_module, "close_db", fake_close_db)

    with TestClient(app_module.app) as client:
        start = client.get("/auth/login?return_to=/analysis", follow_redirects=False)
        assert start.status_code == 307
        assert "/auth/dev/authorize?" in start.headers["location"]
        assert "code_challenge=" in start.headers["location"]
        assert "nonce=" in start.headers["location"]

        authorize = client.get(start.headers["location"], follow_redirects=False)
        assert authorize.status_code == 303
        assert "code=dev%3Aalice" in authorize.headers["location"]

        callback = client.get(authorize.headers["location"], follow_redirects=False)
        assert callback.status_code == 303
        assert callback.headers["location"] == "/analysis"
        assert "infinity_session=" in callback.headers.get("set-cookie", "")
        assert "infinity_csrf=" in callback.headers.get("set-cookie", "")

        me = client.get("/auth/me")
        assert me.status_code == 200
        assert me.json()["user_id"] == "alice"

        bad_return = client.get("/auth/login?return_to=https://evil.example/", follow_redirects=False)
        bad_authorize = client.get(bad_return.headers["location"], follow_redirects=False)
        bad_callback = client.get(bad_authorize.headers["location"], follow_redirects=False)
        assert bad_callback.headers["location"] == "/"

        logout = client.post(
            "/auth/logout",
            headers={"x-csrf-token": client.cookies["infinity_csrf"]},
            follow_redirects=False,
        )
        assert logout.status_code == 303
        assert "infinity_session=\"\"" in logout.headers.get("set-cookie", "")
        assert client.get("/auth/me").status_code == 401

        assert client.get("/auth/logout", follow_redirects=False).status_code == 405


def test_cookie_state_change_requires_csrf_token(monkeypatch):
    monkeypatch.setenv("AUTH_DEV_LOGIN_ENABLED", "1")
    monkeypatch.setenv("COOKIE_SECURE", "0")

    async def fake_init_db(app):
        app.state.db_pool = None

    async def fake_close_db(_app):
        return None

    monkeypatch.setattr(app_module, "init_db", fake_init_db)
    monkeypatch.setattr(app_module, "close_db", fake_close_db)

    with TestClient(app_module.app) as client:
        client.get("/auth/dev/login?user_id=alice", follow_redirects=False)
        response = client.post("/auth/logout", follow_redirects=False)
        assert response.status_code == 403


def test_websocket_rejects_foreign_browser_origin(monkeypatch):
    async def fake_init_db(app):
        app.state.db_pool = None

    async def fake_close_db(_app):
        return None

    monkeypatch.setattr(app_module, "init_db", fake_init_db)
    monkeypatch.setattr(app_module, "close_db", fake_close_db)

    with TestClient(app_module.app) as client:
        with pytest.raises(WebSocketDisconnect) as exc_info:
            with client.websocket_connect("/ws/chat", headers={"origin": "https://evil.example"}):
                pass
        assert exc_info.value.code == 1008


@pytest.mark.asyncio
async def test_cookie_websocket_session_checks_durable_revocation(monkeypatch):
    monkeypatch.setenv("SESSION_COOKIE_SECRET", "test-secret")

    class Conn:
        async def fetchrow(self, *_args):
            return None

    class Acquire:
        async def __aenter__(self):
            return Conn()

        async def __aexit__(self, *_args):
            return None

    class Pool:
        def acquire(self):
            return Acquire()

    principal = principal_from_session_cookie(
        create_session_cookie(Principal(user_id="alice", session_id="session-id"))
    )
    app = SimpleNamespace(state=SimpleNamespace(db_pool=Pool()))

    with pytest.raises(Exception) as exc_info:
        await _ensure_session_active(app, principal)
    assert exc_info.value.status_code == 401
