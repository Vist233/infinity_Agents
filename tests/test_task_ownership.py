"""Regression tests for user-private task inputs."""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from backend.code_agent.models import Task
from backend.code_agent.task_service import submit_task_atomically


class _Transaction:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return None


class _Connection:
    def transaction(self):
        return _Transaction()

    async def fetchrow(self, query, *args):
        normalized = " ".join(query.split()).upper()
        if "FROM IDEMPOTENCY_KEYS" in normalized:
            return None
        if "FROM TASK_SPECS TS" in normalized:
            return {
                "spec_project": "project-1",
                "spec_status": "active",
                "spec_created_by": "another-user",
                "dataset_project": "project-1",
                "validation_passed": True,
            }
        raise AssertionError(f"unexpected query: {query}")

    async def fetchval(self, query, *args):
        assert "project_members" in query
        return 1


class _Pool:
    def acquire(self):
        class _Acquire:
            async def __aenter__(self):
                return _Connection()

            async def __aexit__(self, *_args):
                return None

        return _Acquire()


@pytest.mark.asyncio
async def test_submit_rejects_a_task_spec_owned_by_another_user():
    task = Task(
        task_id="task-1",
        task_spec_id="spec-1",
        dataset_snapshot_id="dataset-1",
        project_id="project-1",
        title="private task",
        status="queued",
        created_by="current-user",
        created_at=datetime.now(timezone.utc).isoformat(),
    )

    with pytest.raises(ValueError, match="TaskSpec and Dataset"):
        await submit_task_atomically(
            _Pool(),
            task,
            user_id="current-user",
            idempotency_key="ownership-test",
        )
