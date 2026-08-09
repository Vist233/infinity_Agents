from __future__ import annotations

from fastapi.testclient import TestClient

import backend.app as app_module


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

        logout = client.get("/auth/logout", follow_redirects=False)
        assert logout.status_code == 303
        assert "infinity_session=\"\"" in logout.headers.get("set-cookie", "")
        assert client.get("/auth/me").status_code == 401


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
