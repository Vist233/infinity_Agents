"""任务状态机：状态枚举与合法迁移校验。

task_run / task_item / export_outbox 三类对象的状态迁移
全部在此集中定义，Repository 层负责在事务中执行迁移。
"""
from __future__ import annotations

from enum import Enum


class RunStatus(str, Enum):
    DRAFT = "DRAFT"
    SCANNING = "SCANNING"
    READY = "READY"
    RUNNING = "RUNNING"
    PAUSED = "PAUSED"
    STOPPING = "STOPPING"
    STOPPED = "STOPPED"
    COMPLETED = "COMPLETED"
    COMPLETED_WITH_ERRORS = "COMPLETED_WITH_ERRORS"
    FAILED = "FAILED"


class ItemStatus(str, Enum):
    PENDING = "PENDING"
    PROCESSING = "PROCESSING"
    SUCCEEDED = "SUCCEEDED"
    RETRY_WAIT = "RETRY_WAIT"
    FAILED = "FAILED"
    SKIPPED = "SKIPPED"
    CANCELLED = "CANCELLED"


class OutboxStatus(str, Enum):
    PENDING = "PENDING"
    PROCESSING = "PROCESSING"
    SYNCED = "SYNCED"
    RETRY_WAIT = "RETRY_WAIT"
    FAILED = "FAILED"


# ---------------------------------------------------------------------------
# 合法迁移表
# ---------------------------------------------------------------------------
RUN_TRANSITIONS: dict[RunStatus, set[RunStatus]] = {
    RunStatus.DRAFT: {RunStatus.SCANNING},
    RunStatus.SCANNING: {RunStatus.READY, RunStatus.FAILED},
    RunStatus.READY: {RunStatus.RUNNING, RunStatus.SCANNING},
    RunStatus.RUNNING: {
        RunStatus.PAUSED,
        RunStatus.STOPPING,
        RunStatus.COMPLETED,
        RunStatus.COMPLETED_WITH_ERRORS,
        RunStatus.FAILED,
    },
    RunStatus.PAUSED: {RunStatus.RUNNING, RunStatus.STOPPING, RunStatus.STOPPED},
    RunStatus.STOPPING: {RunStatus.STOPPED, RunStatus.COMPLETED_WITH_ERRORS},
    RunStatus.STOPPED: {RunStatus.RUNNING},            # 断点续跑
    RunStatus.COMPLETED: set(),
    RunStatus.COMPLETED_WITH_ERRORS: {RunStatus.RUNNING},  # 重试失败项
    RunStatus.FAILED: {RunStatus.RUNNING},
}

ITEM_TRANSITIONS: dict[ItemStatus, set[ItemStatus]] = {
    ItemStatus.PENDING: {
        ItemStatus.PROCESSING,
        ItemStatus.SKIPPED,
        ItemStatus.CANCELLED,
    },
    ItemStatus.PROCESSING: {
        ItemStatus.SUCCEEDED,
        ItemStatus.RETRY_WAIT,
        ItemStatus.FAILED,
        ItemStatus.PENDING,      # 启动恢复回收
        ItemStatus.CANCELLED,
    },
    ItemStatus.SUCCEEDED: set(),
    ItemStatus.RETRY_WAIT: {ItemStatus.PENDING, ItemStatus.FAILED, ItemStatus.CANCELLED},
    ItemStatus.FAILED: {ItemStatus.PENDING},           # 用户“重试失败”
    ItemStatus.SKIPPED: set(),
    ItemStatus.CANCELLED: {ItemStatus.PENDING},        # 续跑时恢复
}

OUTBOX_TRANSITIONS: dict[OutboxStatus, set[OutboxStatus]] = {
    OutboxStatus.PENDING: {OutboxStatus.PROCESSING},
    OutboxStatus.PROCESSING: {OutboxStatus.SYNCED, OutboxStatus.RETRY_WAIT, OutboxStatus.FAILED},
    OutboxStatus.SYNCED: set(),
    OutboxStatus.RETRY_WAIT: {OutboxStatus.PROCESSING, OutboxStatus.FAILED},
    OutboxStatus.FAILED: {OutboxStatus.PROCESSING},
}


def can_transition_run(current: RunStatus, target: RunStatus) -> bool:
    return target in RUN_TRANSITIONS.get(current, set())


def can_transition_item(current: ItemStatus, target: ItemStatus) -> bool:
    return target in ITEM_TRANSITIONS.get(current, set())


def can_transition_outbox(current: OutboxStatus, target: OutboxStatus) -> bool:
    return target in OUTBOX_TRANSITIONS.get(current, set())


class IllegalTransitionError(RuntimeError):
    """非法状态迁移。"""

    def __init__(self, kind: str, current, target):
        super().__init__(f"非法状态迁移 {kind}: {current} -> {target}")
        self.kind = kind
        self.current = current
        self.target = target


# 终止状态
RUN_TERMINAL = {RunStatus.COMPLETED, RunStatus.STOPPED}
ITEM_TERMINAL = {ItemStatus.SUCCEEDED, ItemStatus.FAILED, ItemStatus.SKIPPED, ItemStatus.CANCELLED}
