"""Infinity Agent — Task data models and state machine."""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, Optional


# ============================================================================
# State Machine
# ============================================================================

class TaskStatus(str, Enum):
    DRAFT = "draft"
    QUEUED = "queued"
    CLAIMED = "claimed"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"
    TIMEOUT = "timeout"


class TaskPhase(str, Enum):
    """Sub-state phase for RUNNING tasks."""
    PREPARING = "preparing"
    EXECUTING = "executing"
    VERIFYING = "verifying"
    PACKAGING = "packaging"


TRANSITIONS: Dict[TaskStatus, set[TaskStatus]] = {
    TaskStatus.DRAFT: {TaskStatus.QUEUED, TaskStatus.CANCELLED},
    TaskStatus.QUEUED: {TaskStatus.CLAIMED, TaskStatus.CANCELLED},
    # A Worker may finish before emitting a separate RUNNING heartbeat (for
    # short fixture jobs and fast failures), so terminal transitions from
    # CLAIMED are valid as well as the normal CLAIMED -> RUNNING path.
    TaskStatus.CLAIMED: {
        TaskStatus.RUNNING,
        TaskStatus.QUEUED,
        TaskStatus.SUCCEEDED,
        TaskStatus.FAILED,
        TaskStatus.TIMEOUT,
        TaskStatus.CANCELLED,
    },
    TaskStatus.RUNNING: {TaskStatus.SUCCEEDED, TaskStatus.FAILED, TaskStatus.TIMEOUT, TaskStatus.CANCELLED},
    TaskStatus.SUCCEEDED: set(),
    TaskStatus.FAILED: {TaskStatus.QUEUED},
    TaskStatus.CANCELLED: set(),
    TaskStatus.TIMEOUT: {TaskStatus.QUEUED},
}


def can_transition(from_status: TaskStatus, to_status: TaskStatus) -> bool:
    return to_status in TRANSITIONS.get(from_status, set())


def transition_task(task: "Task", to_status: TaskStatus) -> None:
    """Validate and apply a state transition."""
    if not can_transition(task.status, to_status):
        raise ValueError(
            f"Invalid state transition: {task.status.value} → {to_status.value}"
        )
    task.status = to_status


# ============================================================================
# Data Models
# ============================================================================

@dataclass
class TaskSpec:
    task_spec_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    project_id: str = ""
    revision: int = 1
    title: str = ""
    domain: str = "bioinformatics"
    analysis_type: str = ""
    research_question: str = ""
    spec_json: Dict[str, Any] = field(default_factory=dict)
    schema_version: str = "1.0"
    status: str = "draft"
    created_by: Optional[str] = None
    created_at: str = ""
    updated_at: str = ""
    frozen_at: Optional[str] = None


@dataclass
class DatasetSnapshot:
    dataset_snapshot_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    task_spec_id: str = ""
    project_id: str = ""
    original_filename: str = ""
    stored_path: str = ""
    file_size_bytes: Optional[int] = None
    file_hash_sha256: Optional[str] = None
    metadata: Dict[str, Any] = field(default_factory=dict)
    validation_result: Dict[str, Any] = field(default_factory=dict)
    validation_passed: bool = False
    version: int = 1
    created_at: str = ""


@dataclass
class Task:
    task_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    task_spec_id: str = ""
    dataset_snapshot_id: str = ""
    project_id: str = ""
    # Server-owned scheduling pool. The public pool is the only new Worker
    # execution route; this is not exposed as a client request field.
    execution_pool: str = "public-default"
    method_source_id: Optional[str] = None
    title: str = ""
    status: str = "draft"
    phase: Optional[str] = None
    priority: int = 0
    version: int = 1
    lease_owner: Optional[str] = None
    lease_token: Optional[str] = None
    lease_expires_at: Optional[str] = None
    active_attempt_id: Optional[int] = None
    attempt_count: int = 0
    max_attempts: int = 3
    cancel_requested_at: Optional[str] = None
    result_artifact_id: Optional[str] = None
    error_message: Optional[str] = None
    created_by: Optional[str] = None
    created_at: str = ""
    updated_at: str = ""
    started_at: Optional[str] = None
    finished_at: Optional[str] = None


@dataclass
class TaskAttempt:
    task_attempt_id: Optional[int] = None
    task_id: str = ""
    worker_id: str = ""
    status: str = "running"
    attempt_index: int = 1
    container_id: Optional[str] = None
    executor_image_digest: Optional[str] = None
    docker_container_id: Optional[str] = None
    started_at: str = ""
    finished_at: Optional[str] = None
    exit_code: Optional[int] = None
    error_message: Optional[str] = None
    failure_code: Optional[str] = None
    failure_detail: Optional[str] = None
    token_usage: Dict[str, Any] = field(default_factory=dict)


@dataclass
class TaskEvent:
    task_event_id: Optional[int] = None
    task_id: str = ""
    task_attempt_id: Optional[int] = None
    event_type: str = ""
    event_data: Dict[str, Any] = field(default_factory=dict)
    created_at: str = ""


@dataclass
class OutboxEvent:
    outbox_event_id: Optional[int] = None
    aggregate_type: str = "task"
    aggregate_id: str = ""
    event_type: str = ""
    payload: Dict[str, Any] = field(default_factory=dict)
    status: str = "pending"
    published_at: Optional[str] = None
    retry_count: int = 0
    last_error: Optional[str] = None
    next_attempt_at: Optional[str] = None
    created_at: str = ""


@dataclass
class Artifact:
    artifact_id: str = ""
    task_id: str = ""
    task_attempt_id: Optional[int] = None
    name: str = ""
    kind: str = "result"
    storage_backend: str = "local"
    storage_path: str = ""
    file_size_bytes: Optional[int] = None
    checksum_sha256: Optional[str] = None
    content_type: Optional[str] = None
    metadata: Dict[str, Any] = field(default_factory=dict)
    created_at: str = ""


@dataclass
class Project:
    project_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    name: str = ""
    description: Optional[str] = None
    created_by: Optional[str] = None
    created_at: str = ""


@dataclass
class MethodSource:
    method_source_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    project_id: str = ""
    task_spec_id: Optional[str] = None
    original_filename: str = ""
    stored_path: str = ""
    content_type: Optional[str] = None
    file_size_bytes: Optional[int] = None
    file_hash_sha256: Optional[str] = None
    created_at: str = ""


@dataclass
class IdempotencyKey:
    idempotency_key: str = ""
    user_id: Optional[str] = None
    resource_type: str = ""
    resource_id: Optional[str] = None
    request_hash: Optional[str] = None
    created_at: str = ""
    expires_at: str = ""
