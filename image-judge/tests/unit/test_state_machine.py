"""状态机合法迁移测试。"""
from __future__ import annotations

from imagejudge.core.state_machine import (
    IllegalTransitionError,
    ItemStatus,
    OutboxStatus,
    RunStatus,
    can_transition_item,
    can_transition_outbox,
    can_transition_run,
)


def test_run_lifecycle_transitions():
    assert can_transition_run(RunStatus.DRAFT, RunStatus.SCANNING)
    assert can_transition_run(RunStatus.SCANNING, RunStatus.READY)
    assert can_transition_run(RunStatus.READY, RunStatus.RUNNING)
    assert can_transition_run(RunStatus.RUNNING, RunStatus.PAUSED)
    assert can_transition_run(RunStatus.PAUSED, RunStatus.RUNNING)
    assert can_transition_run(RunStatus.RUNNING, RunStatus.COMPLETED)
    assert can_transition_run(RunStatus.RUNNING, RunStatus.COMPLETED_WITH_ERRORS)


def test_run_resume_and_retry():
    # 断点续跑与“重试失败”
    assert can_transition_run(RunStatus.STOPPED, RunStatus.RUNNING)
    assert can_transition_run(RunStatus.COMPLETED_WITH_ERRORS, RunStatus.RUNNING)
    assert can_transition_run(RunStatus.FAILED, RunStatus.RUNNING)


def test_run_illegal_transitions():
    assert not can_transition_run(RunStatus.DRAFT, RunStatus.RUNNING)
    assert not can_transition_run(RunStatus.COMPLETED, RunStatus.RUNNING)
    assert not can_transition_run(RunStatus.READY, RunStatus.COMPLETED)


def test_item_transitions():
    assert can_transition_item(ItemStatus.PENDING, ItemStatus.PROCESSING)
    assert can_transition_item(ItemStatus.PROCESSING, ItemStatus.SUCCEEDED)
    assert can_transition_item(ItemStatus.PROCESSING, ItemStatus.RETRY_WAIT)
    assert can_transition_item(ItemStatus.PROCESSING, ItemStatus.FAILED)
    # 启动恢复回收
    assert can_transition_item(ItemStatus.PROCESSING, ItemStatus.PENDING)
    # 重试失败
    assert can_transition_item(ItemStatus.FAILED, ItemStatus.PENDING)
    # 终态不可再迁移
    assert not can_transition_item(ItemStatus.SUCCEEDED, ItemStatus.PENDING)
    assert not can_transition_item(ItemStatus.SKIPPED, ItemStatus.PENDING)


def test_item_retry_wait_transitions():
    assert can_transition_item(ItemStatus.RETRY_WAIT, ItemStatus.PENDING)
    assert can_transition_item(ItemStatus.RETRY_WAIT, ItemStatus.FAILED)
    assert not can_transition_item(ItemStatus.RETRY_WAIT, ItemStatus.SUCCEEDED)


def test_outbox_transitions():
    assert can_transition_outbox(OutboxStatus.PENDING, OutboxStatus.PROCESSING)
    assert can_transition_outbox(OutboxStatus.PROCESSING, OutboxStatus.SYNCED)
    assert can_transition_outbox(OutboxStatus.PROCESSING, OutboxStatus.RETRY_WAIT)
    assert can_transition_outbox(OutboxStatus.RETRY_WAIT, OutboxStatus.PROCESSING)
    assert not can_transition_outbox(OutboxStatus.SYNCED, OutboxStatus.PROCESSING)


def test_illegal_transition_error_fields():
    err = IllegalTransitionError("task_run", RunStatus.COMPLETED, RunStatus.RUNNING)
    assert err.kind == "task_run"
    assert err.current == RunStatus.COMPLETED
    assert err.target == RunStatus.RUNNING
    assert "非法状态迁移" in str(err)
