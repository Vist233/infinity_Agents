"""Tests for the five-level verifier."""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from backend.code_agent.verifier import FiveLevelVerifier, verify_outputs


def _make_spec(deliverables=None, execution=None, reproducibility=None):
    return {
        "spec_json": {
            "deliverables": deliverables or [],
            "execution": execution or {},
            "reproducibility": reproducibility or {},
        }
    }


class TestFileLevelVerification:
    def test_missing_required_file_fails(self, tmp_path):
        spec = _make_spec([{"path": "results.csv", "required": True, "min_bytes": 10}])
        result = verify_outputs(tmp_path, spec)
        assert not result["passed"]
        assert any(f["level"] == "file" for f in result["failures"])

    def test_empty_file_fails(self, tmp_path):
        (tmp_path / "results.csv").write_text("")
        spec = _make_spec([{"path": "results.csv", "required": True}])
        result = verify_outputs(tmp_path, spec)
        assert not result["passed"]

    def test_file_too_small_fails(self, tmp_path):
        (tmp_path / "results.csv").write_text("a,b\n")
        spec = _make_spec([{"path": "results.csv", "required": True, "min_bytes": 100}])
        result = verify_outputs(tmp_path, spec)
        assert not result["passed"]

    def test_valid_file_passes(self, tmp_path):
        (tmp_path / "results.csv").write_text("a,b\n1,2\n")
        spec = _make_spec([{"path": "results.csv", "required": True, "min_bytes": 5}])
        result = verify_outputs(tmp_path, spec)
        assert result["passed"]

    def test_path_traversal_blocked(self, tmp_path):
        spec = _make_spec([{"path": "../../etc/passwd", "required": True}])
        result = verify_outputs(tmp_path, spec)
        assert not result["passed"]
        assert any("traversal" in f["message"].lower() for f in result["failures"])


class TestFormatLevelVerification:
    def test_invalid_json_fails(self, tmp_path):
        (tmp_path / "data.json").write_text("{invalid}")
        spec = _make_spec([{"path": "data.json", "required": True}])
        result = verify_outputs(tmp_path, spec)
        assert any(f["level"] == "format" for f in result["failures"])

    def test_valid_json_passes(self, tmp_path):
        (tmp_path / "data.json").write_text('{"key": "value"}')
        spec = _make_spec([{"path": "data.json", "required": True}])
        result = verify_outputs(tmp_path, spec)
        fmt_failures = [f for f in result["failures"] if f["level"] == "format"]
        assert len(fmt_failures) == 0

    def test_invalid_csv_fails(self, tmp_path):
        (tmp_path / "data.csv").write_text("")
        spec = _make_spec([{"path": "data.csv", "required": True}])
        result = verify_outputs(tmp_path, spec)
        assert any(f["level"] == "format" for f in result["failures"])

    def test_valid_csv_passes(self, tmp_path):
        (tmp_path / "data.csv").write_text("col1,col2\n1,2\n")
        spec = _make_spec([{"path": "data.csv", "required": True}])
        result = verify_outputs(tmp_path, spec)
        fmt_failures = [f for f in result["failures"] if f["level"] == "format"]
        assert len(fmt_failures) == 0


class TestContentLevelVerification:
    def test_min_rows_check(self, tmp_path):
        (tmp_path / "data.csv").write_text("col1,col2\n1,2\n")
        spec = _make_spec([{"path": "data.csv", "required": True, "min_rows": 5}])
        result = verify_outputs(tmp_path, spec)
        assert any("rows" in f["message"] and "need" in f["message"] for f in result["failures"])

    def test_required_columns_check(self, tmp_path):
        (tmp_path / "data.csv").write_text("col1,col2\n1,2\n")
        spec = _make_spec([{"path": "data.csv", "required": True, "required_columns": ["gene", "padj"]}])
        result = verify_outputs(tmp_path, spec)
        assert any("missing required column" in f["message"] for f in result["failures"])

    def test_content_passes_when_ok(self, tmp_path):
        (tmp_path / "data.csv").write_text("gene,padj\nA,0.01\nB,0.05\n")
        spec = _make_spec([{"path": "data.csv", "required": True, "min_rows": 1, "required_columns": ["gene", "padj"]}])
        result = verify_outputs(tmp_path, spec)
        content_failures = [f for f in result["failures"] if f["level"] == "content"]
        assert len(content_failures) == 0


class TestExecutionLevelVerification:
    def test_missing_execution_events_fails(self, tmp_path):
        spec = _make_spec(execution={"required_stages": ["preparing", "executing"]})
        result = verify_outputs(tmp_path, spec)
        assert any(f["level"] == "execution" for f in result["failures"])

    def test_execution_events_present_passes(self, tmp_path):
        events = [{"type": "preparing"}, {"type": "executing"}, {"type": "verifying"}]
        (tmp_path / "execution_events.json").write_text(json.dumps(events))
        spec = _make_spec(execution={"required_stages": ["preparing", "executing"]})
        result = verify_outputs(tmp_path, spec)
        exec_failures = [f for f in result["failures"] if f["level"] == "execution"]
        assert len(exec_failures) == 0


class TestReproducibilityLevelVerification:
    def test_missing_manifest_field_fails(self, tmp_path):
        spec = _make_spec(reproducibility={"required_fields": ["task_id_hash", "dataset_hash"]})
        result = verify_outputs(tmp_path, spec)
        assert any(f["level"] == "reproducibility" for f in result["failures"])

    def test_manifest_present_passes(self, tmp_path):
        manifest = {"task_id_hash": "abc", "dataset_hash": "def"}
        (tmp_path / "manifest.json").write_text(json.dumps(manifest))
        spec = _make_spec(reproducibility={"required_fields": ["task_id_hash", "dataset_hash"]})
        result = verify_outputs(tmp_path, spec)
        repro_failures = [f for f in result["failures"] if f["level"] == "reproducibility"]
        assert len(repro_failures) == 0
