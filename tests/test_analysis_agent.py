"""Tests for the Analysis Agent (GAP 2)."""

from __future__ import annotations

import pytest

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

    @pytest.mark.asyncio
    async def test_case3_generates_valid_taskspec(self):
        events = []
        async for event in run_analysis_stream("case3 Scanpy single cell"):
            events.append(event)
        draft_events = [e for e in events if e.get("type") == "task_spec_draft"]
        assert len(draft_events) == 1
        spec = draft_events[0]["task_spec"]
        assert spec["analysis_type"] == "scanpy"
        assert validate_task_spec(spec) == []
