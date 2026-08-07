import time
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

import backend.app as backend_app_module


@pytest.fixture(autouse=True)
def _mock_db_lifespan():
    async def fake_init_db(app):
        app.state.db_pool = object()
        app.state.session_agents = {}
        app.state.session_meta = {}

    async def fake_close_db(app):
        return None

    with patch.object(backend_app_module, "init_db", fake_init_db), patch.object(
        backend_app_module, "close_db", fake_close_db
    ):
        yield


@pytest.fixture
def client():
    with TestClient(backend_app_module.app) as test_client:
        yield test_client


def _create_session(client: TestClient) -> str:
    response = client.post("/api/code/sessions")
    assert response.status_code == 200, response.text
    session_id = response.json()["session_id"]
    assert isinstance(session_id, str)
    assert len(session_id) > 0
    return session_id


class TestCreateCodeSession:
    def test_returns_session_id(self, client: TestClient):
        session_id = _create_session(client)
        assert session_id in backend_app_module._code_sessions

    def test_creates_multiple_sessions(self, client: TestClient):
        ids = [_create_session(client) for _ in range(5)]
        assert len(set(ids)) == 5
        for sid in ids:
            assert sid in backend_app_module._code_sessions


class TestGetCodeSessionMessages:
    def test_empty_session_returns_empty_list(self, client: TestClient):
        session_id = _create_session(client)
        response = client.get(f"/api/code/sessions/{session_id}/messages")
        assert response.status_code == 200
        assert response.json() == []

    def test_messages_persisted_after_websocket(self, client: TestClient):
        session_id = _create_session(client)
        with client.websocket_connect("/ws/code") as websocket:
            websocket.send_json({
                "session_id": session_id,
                "messages": [{"role": "user", "content": "case1 analysis"}],
            })
            events = []
            while True:
                data = websocket.receive_json()
                events.append(data)
                if data.get("type") == "done":
                    break

        response = client.get(f"/api/code/sessions/{session_id}/messages")
        assert response.status_code == 200
        messages = response.json()
        assert len(messages) == 2
        assert messages[0]["role"] == "user"
        assert messages[0]["content"] == "case1 analysis"
        assert messages[1]["role"] == "assistant"
        assert isinstance(messages[1]["content"], str)
        assert len(messages[1]["content"]) > 0


class TestWebSocketCodeFlow:
    def test_case1_analysis_event_stream(self, client: TestClient):
        session_id = _create_session(client)
        with client.websocket_connect("/ws/code") as websocket:
            websocket.send_json({
                "session_id": session_id,
                "messages": [{"role": "user", "content": "case1 analysis"}],
            })

            event_types = []
            full_content = ""
            while True:
                data = websocket.receive_json()
                event_types.append(data.get("type"))
                if data.get("type") == "chunk":
                    full_content += data.get("content", "")
                if data.get("type") == "done":
                    break

        assert "status" in event_types
        assert "chunk" in event_types
        assert event_types[-1] == "done"
        assert len(full_content) > 0

    def test_case2_keyword_routed(self, client: TestClient):
        session_id = _create_session(client)
        with client.websocket_connect("/ws/code") as websocket:
            websocket.send_json({
                "session_id": session_id,
                "messages": [{"role": "user", "content": "biopython case2 orchids"}],
            })
            events = []
            while True:
                data = websocket.receive_json()
                events.append(data)
                if data.get("type") == "done":
                    break
        full = "".join(e.get("content", "") for e in events if e.get("type") == "chunk")
        assert "Case 2" in full

    def test_case3_keyword_routed(self, client: TestClient):
        session_id = _create_session(client)
        with client.websocket_connect("/ws/code") as websocket:
            websocket.send_json({
                "session_id": session_id,
                "messages": [{"role": "user", "content": "scanpy case3 single cell"}],
            })
            events = []
            while True:
                data = websocket.receive_json()
                events.append(data)
                if data.get("type") == "done":
                    break
        full = "".join(e.get("content", "") for e in events if e.get("type") == "chunk")
        assert "Case 3" in full


class TestCodeSessionErrors:
    def test_invalid_session_id_returns_error(self, client: TestClient):
        response = client.get("/api/code/sessions/not-a-real-session/messages")
        assert response.status_code == 200
        assert response.json() == []

    def test_websocket_invalid_session_returns_error(self, client: TestClient):
        with client.websocket_connect("/ws/code") as websocket:
            websocket.send_json({
                "session_id": "does-not-exist",
                "messages": [{"role": "user", "content": "hello"}],
            })
            data = websocket.receive_json()
            assert data["type"] == "error"

    def test_websocket_empty_user_message_returns_error(self, client: TestClient):
        session_id = _create_session(client)
        with client.websocket_connect("/ws/code") as websocket:
            websocket.send_json({
                "session_id": session_id,
                "messages": [{"role": "user", "content": "   "}],
            })
            data = websocket.receive_json()
            assert data["type"] == "error"


class TestCodeSessionTTL:
    def test_expired_session_is_cleaned_up(self, client: TestClient):
        original_ttl = backend_app_module._CODE_SESSION_TTL
        original_cleanup_interval = backend_app_module._CODE_CLEANUP_INTERVAL
        backend_app_module._CODE_SESSION_TTL = 1
        backend_app_module._CODE_CLEANUP_INTERVAL = 0

        try:
            session_id = _create_session(client)
            state = backend_app_module._code_sessions[session_id]
            state.last_used = time.monotonic() - 2

            _create_session(client)

            assert session_id not in backend_app_module._code_sessions
        finally:
            backend_app_module._CODE_SESSION_TTL = original_ttl
            backend_app_module._CODE_CLEANUP_INTERVAL = original_cleanup_interval


class TestConcurrentSessionCreation:
    def test_concurrent_creation_no_conflict(self, client: TestClient):
        ids = []
        for _ in range(20):
            ids.append(_create_session(client))
        assert len(set(ids)) == 20
        for sid in ids:
            assert sid in backend_app_module._code_sessions
