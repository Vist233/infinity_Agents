import asyncio
import time
import uuid
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

import backend.app as backend_app_module
from backend.auth import Principal, require_user


@pytest.fixture(autouse=True)
def _mock_db_lifespan():
    """CodeAgent 端点不依赖 PostgreSQL，这里统一 mock DB 初始化，避免外部依赖。"""
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
    payload = response.json()
    session_id = payload["session_id"]
    assert isinstance(session_id, str)
    assert len(session_id) > 0
    return session_id


def _receive_until_done(ws):
    """接收 WebSocket 消息直到 done，返回事件列表和完整内容。"""
    events = []
    full_content = ""
    while True:
        data = ws.receive_json()
        events.append(data)
        if data.get("type") == "chunk":
            full_content += data.get("content", "")
        if data.get("type") == "done":
            break
    return events, full_content


class TestWebSocketFullFlow:
    """WebSocket 全流程集成测试：事件流结构、case 路由、关键词、持久化。"""

    def test_event_stream_structure_is_correct(self, client: TestClient):
        session_id = _create_session(client)
        with client.websocket_connect("/ws/code") as ws:
            ws.send_json({
                "session_id": session_id,
                "messages": [{"role": "user", "content": "case1 analysis"}],
            })
            events, _ = _receive_until_done(ws)

        types = [e["type"] for e in events]
        assert "status" in types
        assert "chunk" in types
        assert types[-1] == "done"

        done_event = events[-1]
        assert "token_info" in done_event
        assert "prompt" in done_event["token_info"]
        assert "response" in done_event["token_info"]
        assert "total" in done_event["token_info"]

        for ev in events:
            if ev.get("type") == "status":
                assert "phase" in ev
                assert "elapsed_ms" in ev
                assert "attempt" in ev
                assert "max_attempts" in ev

    def test_case1_returns_rnaseq_keywords(self, client: TestClient):
        session_id = _create_session(client)
        with client.websocket_connect("/ws/code") as ws:
            ws.send_json({
                "session_id": session_id,
                "messages": [{"role": "user", "content": "case1 analysis"}],
            })
            _, full_content = _receive_until_done(ws)

        text = full_content.lower()
        assert any(k in text for k in ["deseq2", "rna-seq", "volcano", "airway", "dexamethasone"])

    def test_case2_returns_biopython_keywords(self, client: TestClient):
        session_id = _create_session(client)
        with client.websocket_connect("/ws/code") as ws:
            ws.send_json({
                "session_id": session_id,
                "messages": [{"role": "user", "content": "case2 orchids biopython"}],
            })
            _, full_content = _receive_until_done(ws)

        text = full_content.lower()
        assert any(k in text for k in ["biopython", "orchid", "gc content", "pairwise"])

    def test_case3_returns_scanpy_keywords(self, client: TestClient):
        session_id = _create_session(client)
        with client.websocket_connect("/ws/code") as ws:
            ws.send_json({
                "session_id": session_id,
                "messages": [{"role": "user", "content": "case3 scanpy single cell"}],
            })
            _, full_content = _receive_until_done(ws)

        text = full_content.lower()
        assert any(k in text for k in ["scanpy", "pbmc", "single cell", "qc", "clustering"])

    def test_messages_persisted_after_websocket(self, client: TestClient):
        session_id = _create_session(client)
        with client.websocket_connect("/ws/code") as ws:
            ws.send_json({
                "session_id": session_id,
                "messages": [{"role": "user", "content": "case1"}],
            })
            _receive_until_done(ws)

        response = client.get(f"/api/code/sessions/{session_id}/messages")
        assert response.status_code == 200
        messages = response.json()
        assert len(messages) == 2
        assert messages[0] == {"role": "user", "content": "case1"}
        assert messages[1]["role"] == "assistant"
        assert len(messages[1]["content"]) > 0

    def test_multiple_messages_in_same_session_accumulate(self, client: TestClient):
        session_id = _create_session(client)

        with client.websocket_connect("/ws/code") as ws:
            ws.send_json({
                "session_id": session_id,
                "messages": [{"role": "user", "content": "case1"}],
            })
            _receive_until_done(ws)

        with client.websocket_connect("/ws/code") as ws:
            ws.send_json({
                "session_id": session_id,
                "messages": [
                    {"role": "user", "content": "case1"},
                    {"role": "assistant", "content": "first answer"},
                    {"role": "user", "content": "case2"},
                ],
            })
            _receive_until_done(ws)

        response = client.get(f"/api/code/sessions/{session_id}/messages")
        messages = response.json()
        assert len(messages) == 4
        assert messages[0]["content"] == "case1"
        assert messages[1]["role"] == "assistant"
        assert messages[2]["content"] == "case2"
        assert messages[3]["role"] == "assistant"

    def test_status_events_emitted_during_stream(self, client: TestClient):
        session_id = _create_session(client)
        with client.websocket_connect("/ws/code") as ws:
            ws.send_json({
                "session_id": session_id,
                "messages": [{"role": "user", "content": "case1"}],
            })
            status_events = []
            while True:
                data = ws.receive_json()
                if data.get("type") == "status":
                    status_events.append(data)
                if data.get("type") == "done":
                    break

        assert len(status_events) >= 1
        for ev in status_events:
            assert ev["phase"] in {"thinking", "tool_running", "responding", "retrying"}
            assert isinstance(ev["elapsed_ms"], int)
            assert ev["elapsed_ms"] >= 0
            assert ev["attempt"] == 1
            assert ev["max_attempts"] == 1


class TestSessionLifecycle:
    """Session 生命周期测试：创建、发消息、获取、空 session、无效 ID。"""

    def test_create_send_get_messages(self, client: TestClient):
        session_id = _create_session(client)
        assert session_id in backend_app_module._code_sessions

        with client.websocket_connect("/ws/code") as ws:
            ws.send_json({
                "session_id": session_id,
                "messages": [{"role": "user", "content": "hello"}],
            })
            _receive_until_done(ws)

        response = client.get(f"/api/code/sessions/{session_id}/messages")
        assert response.status_code == 200
        msgs = response.json()
        assert len(msgs) == 2
        assert msgs[0] == {"role": "user", "content": "hello"}
        assert msgs[1]["role"] == "assistant"

    def test_create_no_message_get_returns_empty(self, client: TestClient):
        session_id = _create_session(client)
        response = client.get(f"/api/code/sessions/{session_id}/messages")
        assert response.status_code == 200
        assert response.json() == []

    def test_invalid_session_id_returns_empty_list(self, client: TestClient):
        response = client.get("/api/code/sessions/not-a-real-session/messages")
        assert response.status_code == 200
        assert response.json() == []

    def test_websocket_invalid_session_returns_error(self, client: TestClient):
        with client.websocket_connect("/ws/code") as ws:
            ws.send_json({
                "session_id": "does-not-exist",
                "messages": [{"role": "user", "content": "hello"}],
            })
            data = ws.receive_json()
            assert data["type"] == "error"

    def test_websocket_empty_user_message_returns_error(self, client: TestClient):
        session_id = _create_session(client)
        with client.websocket_connect("/ws/code") as ws:
            ws.send_json({
                "session_id": session_id,
                "messages": [{"role": "user", "content": "   "}],
            })
            data = ws.receive_json()
            assert data["type"] == "error"

    def test_websocket_missing_session_id_returns_error(self, client: TestClient):
        with client.websocket_connect("/ws/code") as ws:
            ws.send_json({"messages": [{"role": "user", "content": "hello"}]})
            data = ws.receive_json()
            assert data["type"] == "error"

    def test_session_last_used_updated_on_get_messages(self, client: TestClient):
        session_id = _create_session(client)
        state = backend_app_module._code_sessions[session_id]
        initial_last_used = state.last_used

        time.sleep(0.05)
        client.get(f"/api/code/sessions/{session_id}/messages")

        assert state.last_used > initial_last_used

    def test_session_last_used_updated_on_websocket(self, client: TestClient):
        session_id = _create_session(client)
        state = backend_app_module._code_sessions[session_id]
        initial_last_used = state.last_used

        time.sleep(0.05)
        with client.websocket_connect("/ws/code") as ws:
            ws.send_json({
                "session_id": session_id,
                "messages": [{"role": "user", "content": "case1"}],
            })
            _receive_until_done(ws)

        assert state.last_used > initial_last_used


class TestConcurrentSessions:
    """并发测试：同时创建多个 session，每个发不同 case，验证不混淆。"""

    def test_ten_sessions_with_different_cases_no_mixing(self, client: TestClient):
        cases = [
            "case1 analysis",
            "case2 orchids biopython",
            "case3 scanpy single cell",
            "case1 rna-seq",
            "case2 biopython",
            "case3",
            "case1",
            "case2",
            "case3",
            "case1",
        ]

        session_ids = []
        session_outputs = {}

        for case in cases:
            session_id = _create_session(client)
            session_ids.append(session_id)

            with client.websocket_connect("/ws/code") as ws:
                ws.send_json({
                    "session_id": session_id,
                    "messages": [{"role": "user", "content": case}],
                })
                _, full_content = _receive_until_done(ws)
                session_outputs[session_id] = full_content

        # 验证 ID 唯一
        assert len(set(session_ids)) == 10

        # 验证每个 session 的消息不混淆
        for session_id, case in zip(session_ids, cases):
            msgs = client.get(f"/api/code/sessions/{session_id}/messages").json()
            assert len(msgs) == 2
            assert msgs[0]["role"] == "user"
            assert msgs[0]["content"] == case
            assert msgs[1]["role"] == "assistant"
            assert len(msgs[1]["content"]) > 0

            content = session_outputs[session_id].lower()
            if "case1" in case or "rna-seq" in case:
                assert any(k in content for k in ["case 1", "deseq2", "rna-seq", "airway"])
            elif "case2" in case or "biopython" in case:
                assert any(k in content for k in ["case 2", "biopython", "orchid"])
            elif "case3" in case or "scanpy" in case:
                assert any(k in content for k in ["case 3", "scanpy", "pbmc"])

    def test_twenty_sessions_created_without_conflict(self, client: TestClient):
        ids = []
        for _ in range(20):
            ids.append(_create_session(client))
        assert len(set(ids)) == 20
        for sid in ids:
            assert sid in backend_app_module._code_sessions


class TestTTLCleanup:
    """TTL 清理测试：过期 session 自动清理。"""

    def test_expired_session_is_cleaned_up(self, client: TestClient):
        original_ttl = backend_app_module._CODE_SESSION_TTL
        original_interval = backend_app_module._CODE_CLEANUP_INTERVAL
        backend_app_module._CODE_SESSION_TTL = 3600
        backend_app_module._CODE_CLEANUP_INTERVAL = 0

        try:
            session_id = _create_session(client)
            state = backend_app_module._code_sessions[session_id]
            # 手动把 last_used 设为 2 小时前
            state.last_used = time.monotonic() - 7200

            # 再次创建 session 触发清理
            _create_session(client)

            assert session_id not in backend_app_module._code_sessions
        finally:
            backend_app_module._CODE_SESSION_TTL = original_ttl
            backend_app_module._CODE_CLEANUP_INTERVAL = original_interval

    def test_get_messages_returns_empty_after_ttl_expiry(self, client: TestClient):
        original_ttl = backend_app_module._CODE_SESSION_TTL
        original_interval = backend_app_module._CODE_CLEANUP_INTERVAL
        backend_app_module._CODE_SESSION_TTL = 3600
        backend_app_module._CODE_CLEANUP_INTERVAL = 0

        try:
            session_id = _create_session(client)
            state = backend_app_module._code_sessions[session_id]
            state.last_used = time.monotonic() - 7200

            # GET messages 会触发 _cleanup_code_sessions
            response = client.get(f"/api/code/sessions/{session_id}/messages")
            assert response.status_code == 200
            assert response.json() == []
            assert session_id not in backend_app_module._code_sessions
        finally:
            backend_app_module._CODE_SESSION_TTL = original_ttl
            backend_app_module._CODE_CLEANUP_INTERVAL = original_interval

    def test_active_session_survives_cleanup(self, client: TestClient):
        original_ttl = backend_app_module._CODE_SESSION_TTL
        original_interval = backend_app_module._CODE_CLEANUP_INTERVAL
        backend_app_module._CODE_SESSION_TTL = 60
        backend_app_module._CODE_CLEANUP_INTERVAL = 0

        try:
            session_id = _create_session(client)
            # last_used 是创建时间，非常新
            _create_session(client)
            assert session_id in backend_app_module._code_sessions
        finally:
            backend_app_module._CODE_SESSION_TTL = original_ttl
            backend_app_module._CODE_CLEANUP_INTERVAL = original_interval

    def test_websocket_after_ttl_expiry_returns_error(self, client: TestClient):
        original_ttl = backend_app_module._CODE_SESSION_TTL
        original_interval = backend_app_module._CODE_CLEANUP_INTERVAL
        backend_app_module._CODE_SESSION_TTL = 3600
        backend_app_module._CODE_CLEANUP_INTERVAL = 0

        try:
            session_id = _create_session(client)
            state = backend_app_module._code_sessions[session_id]
            state.last_used = time.monotonic() - 7200

            # 先清理
            _create_session(client)
            assert session_id not in backend_app_module._code_sessions

            with client.websocket_connect("/ws/code") as ws:
                ws.send_json({
                    "session_id": session_id,
                    "messages": [{"role": "user", "content": "hello"}],
                })
                data = ws.receive_json()
                assert data["type"] == "error"
        finally:
            backend_app_module._CODE_SESSION_TTL = original_ttl
            backend_app_module._CODE_CLEANUP_INTERVAL = original_interval
