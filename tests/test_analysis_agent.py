"""Tests for the Analysis Agent (GAP 2)."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

import backend.app as backend_app_module
from backend.code_agent.analysis_agent import validate_task_spec, run_analysis_stream


class TestValidateTaskSpec:
    def test_valid_spec_passes(self):
        spec = {
            "domain": "bioinformatics",
            "analysis_type": "rnaseq_deseq2",
            "research_question": "Q",
            "spec_json": {
                "deliverables": [
                    {"path": "results.csv", "required": True, "min_bytes": 100},
                ],
            },
        }
        assert validate_task_spec(spec) == []

    def test_missing_domain_fails(self):
        spec = {
            "analysis_type": "rnaseq_deseq2",
            "research_question": "Q",
            "spec_json": {},
        }
        errors = validate_task_spec(spec)
        assert any("domain" in e for e in errors)

    def test_invalid_deliverable_type_fails(self):
        spec = {
            "domain": "bioinformatics",
            "analysis_type": "rnaseq_deseq2",
            "research_question": "Q",
            "spec_json": {
                "deliverables": ["bad"],
            },
        }
        errors = validate_task_spec(spec)
        assert any("Deliverable 0 must be an object" in e for e in errors)

    def test_non_dict_spec_fails(self):
        assert validate_task_spec("not a dict") == ["TaskSpec must be a JSON object"]


class TestAnalysisStream:
    @pytest.fixture(autouse=True)
    def _no_api_key(self, monkeypatch):
        monkeypatch.delenv("STEPFUN_API_KEY", raising=False)
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)

    @pytest.mark.asyncio
    async def test_generic_input_asks_for_clarification(self):
        events = []
        async for event in run_analysis_stream("do some analysis"):
            events.append(event)
        types = [e["type"] for e in events]
        assert "chunk" in types
        assert any("control groups" in e.get("content", "").lower() for e in events if e.get("type") == "chunk")
        assert "done" in types

    @pytest.mark.asyncio
    async def test_case1_generates_valid_taskspec(self):
        events = []
        async for event in run_analysis_stream("case1 RNA-seq DESeq2"):
            events.append(event)
        draft_events = [e for e in events if e.get("type") == "task_spec_draft"]
        assert len(draft_events) == 1
        spec = draft_events[0]["task_spec"]
        assert spec["analysis_type"] == "rnaseq_deseq2"
        assert validate_task_spec(spec) == []

    @pytest.mark.asyncio
    async def test_case2_generates_valid_taskspec(self):
        events = []
        async for event in run_analysis_stream("case2 biopython orchids"):
            events.append(event)
        draft_events = [e for e in events if e.get("type") == "task_spec_draft"]
        assert len(draft_events) == 1
        spec = draft_events[0]["task_spec"]
        assert spec["analysis_type"] == "biopython"
        assert validate_task_spec(spec) == []


class TestAnalysisWebSocket:
    @pytest.fixture(autouse=True)
    def _mock_db(self, monkeypatch):
        async def fake_init_db(app):
            app.state.db_pool = object()
            app.state.session_agents = {}
            app.state.session_meta = {}

        async def fake_close_db(app):
            return None

        monkeypatch.setattr(backend_app_module, "init_db", fake_init_db)
        monkeypatch.setattr(backend_app_module, "close_db", fake_close_db)

    @pytest.fixture(autouse=True)
    def _no_api_key(self, monkeypatch):
        monkeypatch.delenv("STEPFUN_API_KEY", raising=False)
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)

    def test_analysis_ws_returns_task_spec_draft(self):
        client = TestClient(backend_app_module.app)
        with client.websocket_connect("/ws/analysis") as ws:
            ws.send_json({
                "session_id": "analysis-session",
                "messages": [{"role": "user", "content": "case1 RNA-seq"}],
            })
            events = []
            while True:
                data = ws.receive_json()
                events.append(data)
                if data.get("type") == "done":
                    break
        types = [e["type"] for e in events]
        assert "task_spec_draft" in types
        draft = next(e for e in events if e.get("type") == "task_spec_draft")
        assert "task_spec" in draft
        assert draft["task_spec"]["analysis_type"] == "rnaseq_deseq2"
