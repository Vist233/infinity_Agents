import uuid

import pytest
from fastapi.testclient import TestClient

import backend.app as backend_app_module


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch):
    async def fake_init_db(app):
        app.state.db_pool = object()
        app.state.session_agents = {}
        app.state.session_meta = {}

    async def fake_close_db(app):
        return None

    async def fake_get_all_sessions(_pool):
        return []

    async def fake_insert_session(_pool, _session_id, storage_mode="sandboxed"):
        return storage_mode

    async def fake_get_or_create_session_agent(_session_id):
        return object()

    async def fake_get_session(_pool, _session_id):
        return {
            "session_id": _session_id,
            "title": "New chat",
            "created_at": "2026-01-01T00:00:00+00:00",
            "updated_at": "2026-01-01T00:00:00+00:00",
            "storage_mode": "sandboxed",
        }

    async def fake_resolve_global_paper_id_by_path(_pool, _file_path):
        return None

    async def fake_session_can_access_paper(_pool, _session_id, _paper_id):
        return True

    monkeypatch.setattr(backend_app_module, "init_db", fake_init_db)
    monkeypatch.setattr(backend_app_module, "close_db", fake_close_db)
    monkeypatch.setattr(backend_app_module, "get_all_sessions", fake_get_all_sessions)
    monkeypatch.setattr(backend_app_module, "insert_session", fake_insert_session)
    monkeypatch.setattr(backend_app_module, "_get_or_create_session_agent", fake_get_or_create_session_agent)
    monkeypatch.setattr(backend_app_module, "get_session", fake_get_session)
    monkeypatch.setattr(backend_app_module, "resolve_global_paper_id_by_path", fake_resolve_global_paper_id_by_path)
    monkeypatch.setattr(backend_app_module, "session_can_access_paper", fake_session_can_access_paper)

    with TestClient(backend_app_module.app) as test_client:
        yield test_client


def test_list_sessions_returns_json_list(client: TestClient):
    response = client.get("/api/sessions")
    assert response.status_code == 200
    assert isinstance(response.json(), list)


def test_create_session_returns_uuid(client: TestClient):
    response = client.post("/api/sessions")
    assert response.status_code == 200
    payload = response.json()
    session_id = payload.get("session_id")
    assert isinstance(session_id, str)
    uuid.UUID(session_id)


def test_get_session_messages_invalid_uuid_returns_400(client: TestClient):
    response = client.get("/api/sessions/not-a-uuid/messages")
    assert response.status_code == 400
    assert response.json().get("detail") == "Invalid session ID format"


def test_update_title_empty_returns_400(client: TestClient):
    session_id = str(uuid.uuid4())
    response = client.patch(f"/api/sessions/{session_id}/title", json={"title": "   "})
    assert response.status_code == 400
    assert response.json().get("detail") == "Title cannot be empty"


def test_shared_cache_file_requires_session_access(client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path):
    session_id = str(uuid.uuid4())
    shared_root = tmp_path / "cache"
    file_path = shared_root / "downloads" / "2103_03404.pdf"
    file_path.parent.mkdir(parents=True, exist_ok=True)
    file_path.write_bytes(b"pdf")

    monkeypatch.setattr(backend_app_module, "_SHARED_PAPERS_CACHE_ROOT", shared_root)
    monkeypatch.setattr(backend_app_module, "_SESSIONS_ROOT", tmp_path / "sessions")

    async def fake_resolve_global_paper_id_by_path(_pool, _file_path):
        return "2103_03404"

    async def fake_session_can_access_paper(_pool, _session_id, _paper_id):
        return False

    monkeypatch.setattr(backend_app_module, "resolve_global_paper_id_by_path", fake_resolve_global_paper_id_by_path)
    monkeypatch.setattr(backend_app_module, "session_can_access_paper", fake_session_can_access_paper)

    response = client.get(f"/api/sessions/{session_id}/files/downloads/2103_03404.pdf")
    assert response.status_code == 403

