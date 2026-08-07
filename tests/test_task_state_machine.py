"""Tests for Task state machine transitions."""

from __future__ import annotations

import pytest
from backend.code_agent.models import TaskStatus, can_transition, Task, TaskSpec


class TestStateMachineTransitions:
    """Test all valid state transitions."""

    def test_draft_to_queued(self):
        assert can_transition(TaskStatus.DRAFT, TaskStatus.QUEUED)

    def test_draft_to_cancelled(self):
        assert can_transition(TaskStatus.DRAFT, TaskStatus.CANCELLED)

    def test_draft_cannot_go_to_running(self):
        assert not can_transition(TaskStatus.DRAFT, TaskStatus.RUNNING)

    def test_queued_to_claimed(self):
        assert can_transition(TaskStatus.QUEUED, TaskStatus.CLAIMED)

    def test_queued_to_cancelled(self):
        assert can_transition(TaskStatus.QUEUED, TaskStatus.CANCELLED)

    def test_claimed_to_running(self):
        assert can_transition(TaskStatus.CLAIMED, TaskStatus.RUNNING)

    def test_claimed_back_to_queued(self):
        assert can_transition(TaskStatus.CLAIMED, TaskStatus.QUEUED)

    def test_claimed_to_cancelled(self):
        assert can_transition(TaskStatus.CLAIMED, TaskStatus.CANCELLED)

    def test_running_to_succeeded(self):
        assert can_transition(TaskStatus.RUNNING, TaskStatus.SUCCEEDED)

    def test_running_to_failed(self):
        assert can_transition(TaskStatus.RUNNING, TaskStatus.FAILED)

    def test_running_to_cancelled(self):
        assert can_transition(TaskStatus.RUNNING, TaskStatus.CANCELLED)

    def test_failed_can_retry(self):
        assert can_transition(TaskStatus.FAILED, TaskStatus.QUEUED)

    def test_timeout_can_retry(self):
        assert can_transition(TaskStatus.TIMEOUT, TaskStatus.QUEUED)

    def test_timeout_cannot_go_to_succeeded(self):
        assert not can_transition(TaskStatus.TIMEOUT, TaskStatus.SUCCEEDED)


class TestTaskModels:
    """Test data model creation."""

    def test_task_defaults(self):
        task = Task()
        assert task.status == "draft"
        assert task.attempt_count == 0
        assert task.max_attempts == 3

    def test_task_spec_defaults(self):
        spec = TaskSpec()
        assert spec.domain == "bioinformatics"
        assert spec.schema_version == "1.0"
        assert spec.status == "draft"

    def test_task_status_enum_values(self):
        expected = {"draft", "queued", "claimed", "running", "succeeded", "failed", "cancelled", "timeout"}
        actual = {s.value for s in TaskStatus}
        assert actual == expected
