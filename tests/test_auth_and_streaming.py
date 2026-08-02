import asyncio
import uuid

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

import backend.app as app_module
from backend.auth import Principal, require_user


@pytest.fixture
def isolated_client(monkeypatch: pytest.MonkeyPatch):
    sessions: dict[str, dict] = {}
    messages: dict[str, list[dict]] = {}

    async def fake_init_db(app):
        app.state.db_pool = object()
        app.state.session_agents = {}
        app.state.session_meta = {}
        app.state.token_verifier = object()

    async def fake_close_db(_app):
        return None

    async def fake_insert_session(_pool, session_id, user_id, storage_mode="sandboxed"):
        sessions[session_id] = {"session_id": session_id, "user_id": user_id, "title": "New chat", "storage_mode": storage_mode}

    async def fake_get_all_sessions(_pool, user_id):
        return [{k: v for k, v in session.items() if k != "user_id"} for session in sessions.values() if session["user_id"] == user_id]

    async def fake_get_session(_pool, session_id, user_id=None):
        session = sessions.get(session_id)
        if session and (user_id is None or session["user_id"] == user_id):
            return {k: v for k, v in session.items() if k != "user_id"}
        return None

    async def fake_update_title(_pool, session_id, title, user_id):
        if session_id not in sessions or sessions[session_id]["user_id"] != user_id:
            return False
        sessions[session_id]["title"] = title
        return True

    async def fake_delete(_pool, session_id, user_id):
        if session_id not in sessions or sessions[session_id]["user_id"] != user_id:
            return False
        del sessions[session_id]
        return True

    async def fake_insert_message(_pool, session_id, role, content):
        messages.setdefault(session_id, []).append({"role": role, "content": content})

    async def fake_get_messages(_pool, session_id):
        return messages.get(session_id, [])

    async def fake_get_or_create_agent(_session_id):
        return object()

    monkeypatch.setattr(app_module, "init_db", fake_init_db)
    monkeypatch.setattr(app_module, "close_db", fake_close_db)
    monkeypatch.setattr(app_module, "insert_session", fake_insert_session)
    monkeypatch.setattr(app_module, "get_all_sessions", fake_get_all_sessions)
    monkeypatch.setattr(app_module, "get_session", fake_get_session)
    monkeypatch.setattr(app_module, "update_session_title", fake_update_title)
    monkeypatch.setattr(app_module, "delete_session", fake_delete)
    monkeypatch.setattr(app_module, "insert_message", fake_insert_message)
    monkeypatch.setattr(app_module, "get_session_messages", fake_get_messages)
    monkeypatch.setattr(app_module, "_get_or_create_session_agent", fake_get_or_create_agent)

    current_user = {"id": "alice"}
    async def fake_require_user():
        return Principal(user_id=current_user["id"])
    app_module.app.dependency_overrides[require_user] = fake_require_user

    with TestClient(app_module.app) as client:
        yield client, current_user, sessions, messages
    app_module.app.dependency_overrides.clear()


def test_session_rest_api_requires_authentication():
    # The real dependency is tested at route level by the app below; this
    # assertion guards against accidentally removing it from session routes.
    routes = {route.path: route for route in app_module.app.routes if hasattr(route, "path")}
    assert any(dep.call is require_user for dep in routes["/api/sessions"].dependant.dependencies)


def test_session_rest_rejects_missing_bearer(monkeypatch: pytest.MonkeyPatch):
    async def fake_init_db(app):
        app.state.db_pool = object()

    async def fake_close_db(_app):
        return None

    monkeypatch.setattr(app_module, "init_db", fake_init_db)
    monkeypatch.setattr(app_module, "close_db", fake_close_db)
    with TestClient(app_module.app) as client:
        response = client.get("/api/sessions")
    assert response.status_code == 401
    assert response.headers["www-authenticate"] == "Bearer"


def test_sessions_are_isolated_between_users(isolated_client):
    client, current_user, _sessions, _messages = isolated_client
    created = client.post("/api/sessions")
    assert created.status_code == 200
    session_id = created.json()["session_id"]
    assert client.get("/api/sessions").json() == [{"session_id": session_id, "title": "New chat", "storage_mode": "sandboxed"}]

    current_user["id"] = "bob"
    assert client.get("/api/sessions").json() == []
    assert client.get(f"/api/sessions/{session_id}/messages").status_code == 404
    assert client.patch(f"/api/sessions/{session_id}/title", json={"title": "stolen"}).status_code == 404
    assert client.delete(f"/api/sessions/{session_id}").status_code == 404


def test_websocket_rejects_missing_token(isolated_client):
    client, _current_user, _sessions, _messages = isolated_client
    with client.websocket_connect("/ws/chat") as socket:
        socket.send_json({"session_id": str(uuid.uuid4()), "messages": []})
        assert socket.receive_json()["type"] == "error"


def test_websocket_streams_and_persists_completion(isolated_client, monkeypatch: pytest.MonkeyPatch):
    client, _current_user, sessions, messages = isolated_client
    session_id = str(uuid.uuid4())
    sessions[session_id] = {"session_id": session_id, "user_id": "alice", "title": "New chat", "storage_mode": "sandboxed"}

    async def fake_verify(_websocket, token):
        assert token == "valid-token"
        return Principal(user_id="alice")

    class FakeAgent:
        def run(self, *_args, **_kwargs):
            return iter(["Hello", " world"])

    async def fake_agent(_session_id):
        return FakeAgent()

    async def fake_prompt(**_kwargs):
        return "question", {"estimated_prompt_tokens": 1}

    monkeypatch.setattr(app_module, "verify_websocket_token", fake_verify)
    monkeypatch.setattr(app_module, "_get_or_create_session_agent", fake_agent)
    monkeypatch.setattr(app_module, "_prepare_prompt_with_context_management", fake_prompt)

    with client.websocket_connect("/ws/chat") as socket:
        socket.send_json({
            "session_id": session_id,
            "access_token": "valid-token",
            "messages": [{"role": "user", "content": "question"}],
        })
        events = [socket.receive_json() for _ in range(4)]
    assert [event["type"] for event in events] == ["status", "chunk", "chunk", "done"]
    assert messages[session_id] == [
        {"role": "user", "content": "question"},
        {"role": "assistant", "content": "Hello world"},
    ]
