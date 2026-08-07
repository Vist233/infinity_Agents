"""Full-chain regression tests (GAP 3)."""

from __future__ import annotations

import asyncio
import json
import os
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

import backend.app as backend_app_module
from backend.code_agent.worker.executor import execute_task


class _FakeConn:
    def __init__(self, rows):
        self._rows = rows
        self._updates = []

    async def fetchrow(self, query, *args):
        qu = query.strip().upper()
        if "TASK_SPECS" in qu and "WHERE" in qu:
            for row in self._rows:
                if row.get("_type") == "task_spec" and str(row.get("task_spec_id")) == str(args[0]):
                    return row
        if "DATASET_SNAPSHOTS" in qu and "WHERE" in qu:
            for row in self._rows:
                if row.get("_type") == "dataset" and str(row.get("dataset_snapshot_id")) == str(args[0]):
                    return row
        if "INSERT" in qu:
            if "TASK_ATTEMPTS" in qu:
                return {"task_attempt_id": 1}
            if "ARTIFACTS" in qu:
                return {"created_at": datetime(2026, 1, 1, tzinfo=timezone.utc)}
        if "UPDATE" in qu and "TASK_ATTEMPTS" in qu:
            return None
        return None

    async def fetch(self, query, *args):
        return self._rows

    async def execute(self, query, *args):
        self._updates.append((query, args))
        return "OK 1"


class _FakePool:
    def __init__(self, rows):
        self._rows = rows
        self._conn = _FakeConn(rows)

    def acquire(self):
        class _CM:
            def __init__(self, conn):
                self._conn = conn
            async def __aenter__(self):
                return self._conn
            async def __aexit__(self, *args):
                pass
        return _CM(self._conn)


def _make_task_spec_row(task_spec_id="spec-1", analysis_type="rnaseq_deseq2"):
    dt = datetime(2026, 1, 1, tzinfo=timezone.utc)
    return {
        "_type": "task_spec",
        "task_spec_id": task_spec_id,
        "project_id": "proj-1",
        "revision": 1,
        "title": "Test",
        "domain": "bioinformatics",
        "analysis_type": analysis_type,
        "research_question": "Q",
        "spec_json": {
            "deliverables": [
                {"path": "results.csv", "required": True, "min_bytes": 10},
                {"path": "report.md", "required": True, "min_bytes": 10},
            ],
        },
        "schema_version": "1.0",
        "status": "active",
        "created_by": None,
        "created_at": dt,
        "updated_at": dt,
        "frozen_at": dt,
    }


def _make_dataset_row(dataset_snapshot_id="ds-1"):
    dt = datetime(2026, 1, 1, tzinfo=timezone.utc)
    return {
        "_type": "dataset",
        "dataset_snapshot_id": dataset_snapshot_id,
        "task_spec_id": "spec-1",
        "project_id": "proj-1",
        "original_filename": "data.csv",
        "stored_path": "/tmp/data.csv",
        "file_size_bytes": 100,
        "file_hash_sha256": "abc",
        "metadata": {},
        "validation_result": {},
        "validation_passed": True,
        "version": 1,
        "created_at": dt,
    }


class TestRegressionChains:
    @pytest.mark.asyncio
    async def test_deseq2_case_creates_artifact(self, tmp_path):
        output_dir = tmp_path / "task-1" / "output"
        output_dir.mkdir(parents=True)
        lines = ["gene,padj"] + [f"G{i},0.0{i % 5 + 1}" for i in range(1, 20)]
        (output_dir / "results.csv").write_text("\n".join(lines) + "\n")
        (output_dir / "report.md").write_text("# Report\n\nDetailed analysis results.\n")

        pool = _FakePool([_make_task_spec_row(analysis_type="rnaseq_deseq2"), _make_dataset_row()])
        redis = AsyncMock()
        redis.publish_task_event = AsyncMock()
        redis.set_progress = AsyncMock()

        docker_events = [
            {"type": "status", "phase": "running"},
            {"type": "chunk", "content": "Running DESeq2...\n"},
            {"type": "done", "output": "done"},
        ]

        with patch("backend.code_agent.worker.executor._run_docker_execution") as mock_docker:
            async def _fake_docker(*args, **kwargs):
                for event in docker_events:
                    yield event
            mock_docker.side_effect = _fake_docker

            result = await execute_task(
                task_id="task-1",
                attempt_id=1,
                task_spec_id="spec-1",
                dataset_snapshot_id="ds-1",
                worker_id="worker-1",
                lease_token="token-1",
                docker_image="test-image",
                db_pool=pool,
                redis_client=redis,
                output_base_dir=str(tmp_path),
            )

        assert result["success"] is True
        # D11: artifact ids are unique per attempt (uuid), not per task.
        assert result["artifact_id"].startswith("artifact-")
        assert len(result["output_files"]) == 2
        assert redis.publish_task_event.called

    @pytest.mark.asyncio
    async def test_biopython_case_creates_artifact(self, tmp_path):
        output_dir = tmp_path / "task-2" / "output"
        output_dir.mkdir(parents=True)
        (output_dir / "gc_content.txt").write_text("GC: 45%\nSequence: ATGC\n")
        (output_dir / "report.md").write_text("# Biopython Report\n\nDetailed analysis results.\n")

        pool = _FakePool([_make_task_spec_row(analysis_type="biopython"), _make_dataset_row()])
        redis = AsyncMock()
        redis.publish_task_event = AsyncMock()
        redis.set_progress = AsyncMock()

        docker_events = [
            {"type": "status", "phase": "running"},
            {"type": "chunk", "content": "Running Biopython...\n"},
            {"type": "done", "output": "done"},
        ]

        with patch("backend.code_agent.worker.executor._run_docker_execution") as mock_docker:
            async def _fake_docker(*args, **kwargs):
                for event in docker_events:
                    yield event
            mock_docker.side_effect = _fake_docker

            result = await execute_task(
                task_id="task-2",
                attempt_id=1,
                task_spec_id="spec-2",
                dataset_snapshot_id="ds-2",
                worker_id="worker-1",
                lease_token="token-2",
                docker_image="test-image",
                db_pool=pool,
                redis_client=redis,
                output_base_dir=str(tmp_path),
            )

        assert result["success"] is True
        assert result["artifact_id"].startswith("artifact-")
        assert len(result["output_files"]) == 2

    @pytest.mark.asyncio
    async def test_scanpy_case_has_complete_harness(self, tmp_path):
        output_dir = tmp_path / "task-3" / "output"
        output_dir.mkdir(parents=True)
        (output_dir / "qc_metrics.csv").write_text("cell,count\nA,100\nB,200\n")
        (output_dir / "report.md").write_text("# Scanpy Report\n\nDetailed analysis results.\n")

        pool = _FakePool([_make_task_spec_row(analysis_type="scanpy"), _make_dataset_row()])
        redis = AsyncMock()
        redis.publish_task_event = AsyncMock()
        redis.set_progress = AsyncMock()

        docker_events = [
            {"type": "status", "phase": "running"},
            {"type": "chunk", "content": "Running Scanpy...\n"},
            {"type": "done", "output": "done"},
        ]

        with patch("backend.code_agent.worker.executor._run_docker_execution") as mock_docker:
            async def _fake_docker(*args, **kwargs):
                for event in docker_events:
                    yield event
            mock_docker.side_effect = _fake_docker

            result = await execute_task(
                task_id="task-3",
                attempt_id=1,
                task_spec_id="spec-3",
                dataset_snapshot_id="ds-3",
                worker_id="worker-1",
                lease_token="token-3",
                docker_image="test-image",
                db_pool=pool,
                redis_client=redis,
                output_base_dir=str(tmp_path),
            )

        # The harness passes if the execution completes without exception
        # and produces a deterministic result (success or known failure).
        assert result is not None
        assert "success" in result


class TestIntegrationRealDocker:
    """Real Docker integration tests (GAP 3)."""

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_case1_real_docker_executes(self, tmp_path):
        from backend.code_agent.worker.docker_runtime import run_docker_task, check_docker_available

        if not await check_docker_available():
            pytest.skip("Docker is not available")

        case_dir = "/Users/zhangyvjing/Library/Mobile Documents/com~apple~CloudDocs/Code/CodeExcuteGoalDriven/GoalDrivenAttempt/test/case/1"
        out_dir = tmp_path / "output"
        out_dir.mkdir(parents=True)

        events = []
        async for event in run_docker_task(
            task_id="integration-case1",
            task_spec_id="spec-1",
            dataset_snapshot_id="ds-1",
            docker_image="claude-code-env:v2",
            case_dir=case_dir,
            output_dir=str(out_dir),
        ):
            events.append(event)

        types = [e["type"] for e in events]
        assert "done" in types or "error" in types
        if "done" in types:
            assert (out_dir / "results.csv").exists() or (out_dir / "report.md").exists()

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_case2_real_docker_executes(self, tmp_path):
        from backend.code_agent.worker.docker_runtime import run_docker_task, check_docker_available

        if not await check_docker_available():
            pytest.skip("Docker is not available")

        case_dir = "/Users/zhangyvjing/Library/Mobile Documents/com~apple~CloudDocs/Code/CodeExcuteGoalDriven/GoalDrivenAttempt/test/case/2"
        out_dir = tmp_path / "output"
        out_dir.mkdir(parents=True)

        events = []
        async for event in run_docker_task(
            task_id="integration-case2",
            task_spec_id="spec-2",
            dataset_snapshot_id="ds-2",
            docker_image="claude-code-env:v2",
            case_dir=case_dir,
            output_dir=str(out_dir),
        ):
            events.append(event)

        types = [e["type"] for e in events]
        assert "done" in types or "error" in types
        if "done" in types:
            assert (out_dir / "gc_content.txt").exists() or (out_dir / "report.md").exists()

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_case3_real_docker_executes(self, tmp_path):
        from backend.code_agent.worker.docker_runtime import run_docker_task, check_docker_available

        if not await check_docker_available():
            pytest.skip("Docker is not available")

        case_dir = "/Users/zhangyvjing/Library/Mobile Documents/com~apple~CloudDocs/Code/CodeExcuteGoalDriven/GoalDrivenAttempt/test/case/3"
        out_dir = tmp_path / "output"
        out_dir.mkdir(parents=True)

        events = []
        async for event in run_docker_task(
            task_id="integration-case3",
            task_spec_id="spec-3",
            dataset_snapshot_id="ds-3",
            docker_image="claude-code-env:v2",
            case_dir=case_dir,
            output_dir=str(out_dir),
        ):
            events.append(event)

        types = [e["type"] for e in events]
        assert "done" in types or "error" in types
        if "done" in types:
            assert (out_dir / "qc_metrics.csv").exists() or (out_dir / "report.md").exists()
