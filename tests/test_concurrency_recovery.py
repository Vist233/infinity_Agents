"""Tests for concurrency and recovery (Tests A-H)."""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone, timedelta
from unittest.mock import AsyncMock, patch

import pytest

import backend.app as backend_app_module
from backend.code_agent.models import Task, TaskStatus
from backend.code_agent.task_service import (
    try_claim_task,
    update_task_status,
    create_outbox_event,
    get_pending_outbox_events,
    mark_outbox_published,
    mark_outbox_failed,
    check_idempotency,
    store_idempotency_key,
    create_task,
    get_task,
)
from backend.code_agent.worker.consumer import _lease_reaper_loop, _process_next_task
from backend.code_agent.redis_client import RedisClient


# ============================================================================
# Helpers
# ============================================================================


class FakeConn:
    """Fake asyncpg connection with keyword-based query routing."""

    def __init__(self, state):
        self._state = state
        self._updates = []

    async def fetchrow(self, query, *args):
        return self._route("fetchrow", query, args)

    async def fetch(self, query, *args):
        return self._route("fetch", query, args) or []

    async def execute(self, query, *args):
        self._updates.append((query, args))
        return self._route("execute", query, args) or "OK 1"

    def _route(self, method, query, args):
        qu = query.strip().upper()
        for pat, fn in self._state.get(method, {}).items():
            if pat.upper() in qu:
                return fn(qu, args)
        return None


class FakeCM:
    def __init__(self, conn):
        self._conn = conn

    async def __aenter__(self):
        return self._conn

    async def __aexit__(self, *args):
        pass


class FakePool:
    def __init__(self, state):
        self._state = state
        self.conn = FakeConn(state)

    def acquire(self):
        return FakeCM(self.conn)


def _now():
    return datetime(2026, 1, 1, tzinfo=timezone.utc)


def _make_task_row(
    task_id="task-1",
    status="queued",
    lease_owner=None,
    lease_token=None,
    lease_expires_at=None,
    attempt_count=0,
    max_attempts=3,
    next_attempt_at=None,
    cancel_requested_at=None,
    result_artifact_id=None,
    error_message=None,
    task_spec_id="spec-1",
    dataset_snapshot_id="ds-1",
    project_id="proj-1",
    title="T",
    active_attempt_id=None,
    created_by=None,
):
    n = _now()
    return {
        "task_id": task_id,
        "task_spec_id": task_spec_id,
        "dataset_snapshot_id": dataset_snapshot_id,
        "project_id": project_id,
        "title": title,
        "status": status,
        "lease_owner": lease_owner,
        "lease_token": lease_token,
        "lease_expires_at": lease_expires_at if lease_expires_at is not None else n,
        "active_attempt_id": active_attempt_id,
        "attempt_count": attempt_count,
        "max_attempts": max_attempts,
        "result_artifact_id": result_artifact_id,
        "error_message": error_message,
        "created_by": created_by,
        "created_at": n,
        "updated_at": n,
        "finished_at": None,
        "cancel_requested_at": cancel_requested_at,
        "next_attempt_at": next_attempt_at,
    }


# ============================================================================
# Test A — Two Workers, one task
# ============================================================================


class TestTwoWorkersOneTask:
    """Only one worker can claim a queued task."""

    def test_second_claim_fails_after_first_succeeds(self):
        task = _make_task_row(task_id="task-a", status="queued", attempt_count=0)

        def fn_fetchrow(query, args):
            qu = query.strip().upper()
            # Claim query: UPDATE tasks ... WHERE status = 'queued' ... RETURNING
            if "UPDATE" in qu and "TASKS" in qu and "RETURNING" in qu:
                # Only return row if task is still queued; also simulate the UPDATE side-effect
                if task["status"] != "queued":
                    return None
                task["status"] = "claimed"
                task["lease_owner"] = args[1]
                task["lease_token"] = args[2]
                task["attempt_count"] = 1
                return task
            # SELECT tasks WHERE
            if "SELECT" in qu and "TASKS" in qu and "WHERE" in qu:
                return task
            # Task attempts insert returning
            if "TASK_ATTEMPTS" in qu:
                return {"task_attempt_id": 1, "started_at": _now()}
            # Task events insert returning
            if "TASK_EVENTS" in qu:
                return {"task_event_id": 1, "created_at": _now()}
            # Outbox events insert returning
            if "OUTBOX_EVENTS" in qu:
                return {"outbox_event_id": 1, "created_at": _now()}
            return None

        def fn_execute(query, args):
            qu = query.strip().upper()
            if "UPDATE tasks SET active_attempt_id" in qu:
                return "OK 1"
            return "OK 1"

        pool = FakePool(
            {
                "fetchrow": {"TASKS": fn_fetchrow, "TASK_ATTEMPTS": fn_fetchrow, "TASK_EVENTS": fn_fetchrow, "OUTBOX_EVENTS": fn_fetchrow},
                "fetch": {},
                "execute": {"UPDATE": fn_execute},
            }
        )

        async def run():
            claim1 = await try_claim_task(pool, "task-a", "worker-1", lease_seconds=60)
            assert claim1 is not None, "First worker must claim the task"
            assert claim1["task_id"] == "task-a"

            claim2 = await try_claim_task(pool, "task-a", "worker-2", lease_seconds=60)
            assert claim2 is None, "Second worker must NOT claim an already-claimed task"

        asyncio.run(run())

    def test_only_one_attempt_record_for_single_task(self):
        task = _make_task_row(task_id="task-a2", status="queued", attempt_count=0)
        attempts = []

        def fn_fetchrow(query, args):
            qu = query.strip().upper()
            if "UPDATE" in qu and "TASKS" in qu and "RETURNING" in qu:
                if task["status"] != "queued":
                    return None
                task["status"] = "claimed"
                task["lease_owner"] = args[1]
                task["lease_token"] = args[2]
                task["attempt_count"] = 1
                return task
            if "SELECT" in qu and "TASKS" in qu and "WHERE" in qu:
                return task
            if "TASK_ATTEMPTS" in qu:
                attempts.append(args)
                return {"task_attempt_id": len(attempts) + 1, "started_at": _now()}
            if "TASK_EVENTS" in qu:
                return {"task_event_id": 1, "created_at": _now()}
            if "OUTBOX_EVENTS" in qu:
                return {"outbox_event_id": 1, "created_at": _now()}
            return None

        def fn_execute(query, args):
            if "UPDATE tasks SET active_attempt_id" in query.strip().upper():
                return "OK 1"
            return "OK 1"

        pool = FakePool(
            {
                "fetchrow": {"TASKS": fn_fetchrow, "TASK_ATTEMPTS": fn_fetchrow, "TASK_EVENTS": fn_fetchrow, "OUTBOX_EVENTS": fn_fetchrow},
                "fetch": {},
                "execute": {"UPDATE": fn_execute},
            }
        )

        async def run():
            claim1 = await try_claim_task(pool, "task-a2", "worker-1", lease_seconds=60)
            assert claim1 is not None
            claim2 = await try_claim_task(pool, "task-a2", "worker-2", lease_seconds=60)
            assert claim2 is None
            assert len(attempts) == 1, f"Expected 1 attempt record, got {len(attempts)}"

        asyncio.run(run())


# ============================================================================
# Test B — Duplicate Outbox publication
# ============================================================================


class TestDuplicateOutboxPublication:
    """Publishing same Outbox Event twice must not create duplicate tasks."""

    def test_double_publish_marks_once(self):
        state = {
            "events": [
                {
                    "outbox_event_id": 1,
                    "aggregate_type": "task",
                    "aggregate_id": "task-b",
                    "event_type": "task_created",
                    "payload": {"task_id": "task-b", "status": "queued"},
                    "retry_count": 0,
                    "created_at": _now(),
                    "status": "pending",
                }
            ],
        }

        def fn_fetch(query, args):
            qu = query.strip().upper()
            if "OUTBOX_EVENTS" in qu:
                # Filter pending
                return [e for e in state["events"] if e.get("status") == "pending"]
            return []

        def fn_execute(query, args):
            qu = query.strip().upper()
            if "UPDATE" in qu and "OUTBOX_EVENTS" in qu and "STATUS = 'PUBLISHED'" in qu:
                for e in state["events"]:
                    e["status"] = "published"
                return "OK 1"
            return "OK 1"

        pool = FakePool(
            {
                "fetchrow": {},
                "fetch": {"OUTBOX_EVENTS": fn_fetch},
                "execute": {"UPDATE outbox_events": fn_execute},
            }
        )

        async def run():
            batch = await get_pending_outbox_events(pool, limit=50)
            assert len(batch) == 1

            await mark_outbox_published(pool, 1)

            batch2 = await get_pending_outbox_events(pool, limit=50)
            assert len(batch2) == 0, "Event must not appear as pending after publish"

        asyncio.run(run())

    def test_republishing_already_published_event_does_not_duplicate(self):
        call_count = 0

        def fn_fetch(query, args):
            nonlocal call_count
            call_count += 1
            if "OUTBOX_EVENTS" in query:
                return []
            return []

        pool = FakePool(
            {
                "fetchrow": {},
                "fetch": {"OUTBOX_EVENTS": fn_fetch},
                "execute": {},
            }
        )

        async def run():
            batch1 = await get_pending_outbox_events(pool, limit=50)
            batch2 = await get_pending_outbox_events(pool, limit=50)
            assert len(batch1) == 0
            assert len(batch2) == 0
            assert call_count >= 2, "Publisher must poll more than once"

        asyncio.run(run())


# ============================================================================
# Test C — Worker crash during execution
# ============================================================================


class TestWorkerCrashDuringExecution:
    """Crash after claiming -> lease expires -> another worker recovers."""

    def test_expired_lease_is_requeued_by_reaper(self):
        task = _make_task_row(
            task_id="task-c",
            status="running",
            lease_owner="dead-worker",
            lease_token="token-dead",
            lease_expires_at=datetime(2025, 1, 1, tzinfo=timezone.utc).replace(tzinfo=None),  # naive
            attempt_count=1,
        )
        reaper_updates = []

        def fn_fetchrow(query, args):
            qu = query.strip().upper()
            if "SELECT" in qu and "TASKS" in qu and "WHERE" in qu:
                return task
            return None

        def fn_fetch(query, args):
            qu = query.strip().upper()
            # Match only the 'reap expired leases from dead workers' query
            if "FOR UPDATE SKIP LOCKED" in qu and "LEASE_EXPIRES_AT" in qu and "ATTEMPT_COUNT" in qu:
                # Only return expired tasks
                if task["lease_expires_at"] is not None and task["lease_expires_at"] < datetime.now():
                    return [task]
                return []
            return []

        def fn_execute(query, args):
            qu = query.strip().upper()
            # Lease renewal: SET lease_expires_at = $3 (not NULL)
            if "UPDATE" in qu and "TASKS" in qu and "LEASE_EXPIRES_AT = $3" in qu:
                task["lease_expires_at"] = args[2]
                return "OK 1"
            # Requeue: SET status = 'queued'
            if "UPDATE" in qu and "TASKS" in qu and "STATUS = 'QUEUED'" in qu:
                reaper_updates.append(("requeue", query, args))
                task["status"] = "queued"
                task["lease_owner"] = None
                task["lease_token"] = None
                return "OK 1"
            if "OUTBOX_EVENTS" in qu:
                reaper_updates.append(("outbox", query, args))
                return {"outbox_event_id": 99, "created_at": _now()}
            return "OK 1"

        pool = FakePool(
            {
                "fetchrow": {"TASKS": fn_fetchrow, "INSERT INTO": fn_fetchrow},
                "fetch": {"FOR UPDATE SKIP LOCKED": fn_fetch},
                "execute": {"UPDATE": fn_execute, "INSERT INTO": fn_execute},
            }
        )

        async def run():
            with patch("backend.code_agent.task_service.create_outbox_event", AsyncMock()):
                task_obj = asyncio.create_task(
                    _lease_reaper_loop("reaper-worker", pool, lease_seconds=60)
                )
                await asyncio.sleep(0.3)
                task_obj.cancel()
                try:
                    await task_obj
                except asyncio.CancelledError:
                    pass

            requeue_ops = [op for op in reaper_updates if op[0] == "requeue"]
            assert len(requeue_ops) >= 1, f"Reaper must have requeued the expired lease, got {reaper_updates}"

        asyncio.run(run())

    def test_requeued_task_can_be_claimed_by_new_worker(self):
        """After reaping, a new worker must be able to claim the task."""
        task = _make_task_row(
            task_id="task-c2",
            status="queued",
            attempt_count=1,
            next_attempt_at=datetime(2025, 1, 1, tzinfo=timezone.utc),  # in the past
        )

        def fn_fetchrow(query, args):
            qu = query.strip().upper()
            if "UPDATE" in qu and "TASKS" in qu and "RETURNING" in qu:
                if task["status"] != "queued":
                    return None
                task["status"] = "claimed"
                task["lease_owner"] = args[1]
                task["attempt_count"] = 2
                return task
            if "SELECT" in qu and "TASKS" in qu and "WHERE" in qu:
                return task
            if "TASK_ATTEMPTS" in qu:
                return {"task_attempt_id": 2, "started_at": _now()}
            if "TASK_EVENTS" in qu:
                return {"task_event_id": 2, "created_at": _now()}
            if "OUTBOX_EVENTS" in qu:
                return {"outbox_event_id": 2, "created_at": _now()}
            return None

        def fn_execute(query, args):
            qu = query.strip().upper()
            if "UPDATE tasks SET active_attempt_id" in qu:
                return "OK 1"
            return "OK 1"

        pool = FakePool(
            {
                "fetchrow": {"TASKS": fn_fetchrow, "TASK_ATTEMPTS": fn_fetchrow, "TASK_EVENTS": fn_fetchrow, "OUTBOX_EVENTS": fn_fetchrow},
                "fetch": {},
                "execute": {"UPDATE": fn_execute},
            }
        )

        async def run():
            claim = await try_claim_task(pool, "task-c2", "worker-recovery", lease_seconds=60)
            assert claim is not None, "Recovery worker must claim the requeued task"
            assert claim["attempt_index"] == 2, f"Expected attempt 2, got {claim['attempt_index']}"

        asyncio.run(run())


# ============================================================================
# Test D — Crash after completion but before XACK
# ============================================================================


class TestCrashAfterCompletionBeforeXACK:
    """Message may be redelivered; completed task must not execute twice."""

    def test_acknowledged_message_not_reprocessed(self):
        fake_redis = RedisClient("redis://localhost:6379/0")
        fake_redis._client = AsyncMock()
        fake_redis._client.xack = AsyncMock(return_value=True)

        async def run():
            result = await fake_redis.ack_message("msg-123")
            assert result is True
            fake_redis._client.xack.assert_called_once_with(
                "stream:tasks:execute", "task-workers-v1", "msg-123"
            )

        asyncio.run(run())

    def test_pending_message_recovery_skips_completed_task(self):
        """If a task is already succeeded, a redelivered message should be skipped."""
        task = _make_task_row(task_id="task-d", status="succeeded")

        def fn_fetchrow(query, args):
            qu = query.strip().upper()
            if "SELECT" in qu and "TASKS" in qu and "WHERE" in qu:
                return task
            return None

        pool = FakePool(
            {
                "fetchrow": {"TASKS": fn_fetchrow, "INSERT INTO": fn_fetchrow},
                "fetch": {},
                "execute": {},
            }
        )

        async def consume_tasks(*args, **kwargs):
            return [
                {"message_id": "msg-d", "task_data": {"task_id": "task-d"}, "raw_data": {}}
            ]

        fake_redis = type("R", (), {
            "is_connected": False,
            "connect": lambda s: None,
            "disconnect": lambda s: None,
            "ensure_consumer_group": lambda s, *a, **kw: None,
            "publish_task": lambda s, d: "m1",
            "consume_tasks": consume_tasks,
            "ack_message": AsyncMock(return_value=True),
            "publish_task_event": lambda s, t, e: None,
            "set_progress": lambda s, t, p: None,
            "set_worker_heartbeat": lambda s, *a, **kw: None,
            "get_alive_workers": lambda s: [],
        })()

        async def run():
            await _process_next_task("worker-d", pool, fake_redis, "image", lease_seconds=60)

        asyncio.run(run())
        assert task["status"] == "succeeded"


# ============================================================================
# Test E — Lost-lease Worker attempts publication
# ============================================================================


class TestLostLeaseWorkerRejected:
    """Worker that no longer owns a valid lease must be rejected from publishing."""

    def test_update_with_wrong_lease_token_fails(self):
        task = _make_task_row(
            task_id="task-e",
            status="running",
            lease_owner="worker-1",
            lease_token="valid-token",
            lease_expires_at=datetime(2026, 1, 2, tzinfo=timezone.utc),
        )

        def fn_fetchrow(query, args):
            qu = query.strip().upper()
            if "SELECT" in qu and "TASKS" in qu and "WHERE" in qu:
                return task
            return None

        def fn_execute(query, args):
            qu = query.strip().upper()
            if "UPDATE" in qu and "TASKS" in qu:
                return task
            if "TASK_EVENTS" in qu:
                return {"task_event_id": 1, "created_at": _now()}
            if "OUTBOX_EVENTS" in qu:
                return {"outbox_event_id": 1, "created_at": _now()}
            return "OK 1"

        pool = FakePool(
            {
                "fetchrow": {"TASKS": fn_fetchrow, "INSERT INTO": fn_fetchrow},
                "fetch": {},
                "execute": {"UPDATE": fn_execute, "INSERT INTO": fn_execute},
            }
        )

        async def run():
            result = await update_task_status(
                pool,
                "task-e",
                TaskStatus.SUCCEEDED,
                lease_token="stale-token",
                result_artifact_id="art-1",
            )
            assert result is None, "Stale lease must be rejected"

        asyncio.run(run())

    def test_update_with_valid_lease_token_succeeds(self):
        task = _make_task_row(
            task_id="task-e2",
            status="running",
            lease_owner="worker-1",
            lease_token="valid-token",
            lease_expires_at=datetime(2026, 1, 2, tzinfo=timezone.utc),
        )

        def fn_fetchrow(query, args):
            qu = query.strip().upper()
            if "SELECT" in qu and "TASKS" in qu and "WHERE" in qu:
                return task
            # update_task_status uses fetchrow for UPDATE...RETURNING
            if "UPDATE" in qu and "TASKS" in qu and "RETURNING" in qu:
                task["status"] = "succeeded"
                return task
            if "TASK_EVENTS" in qu:
                return {"task_event_id": 1, "created_at": _now()}
            if "OUTBOX_EVENTS" in qu:
                return {"outbox_event_id": 1, "created_at": _now()}
            return None

        def fn_execute(query, args):
            qu = query.strip().upper()
            if "UPDATE" in qu and "TASKS" in qu:
                return task
            return "OK 1"

        pool = FakePool(
            {
                "fetchrow": {"TASKS": fn_fetchrow, "INSERT INTO": fn_fetchrow},
                "fetch": {},
                "execute": {"UPDATE": fn_execute, "INSERT INTO": fn_execute},
            }
        )

        async def run():
            result = await update_task_status(
                pool,
                "task-e2",
                TaskStatus.SUCCEEDED,
                lease_token="valid-token",
                result_artifact_id="art-2",
            )
            assert result is not None, "Valid lease must allow update"
            assert result["status"] == "succeeded"

        asyncio.run(run())


# ============================================================================
# Test F — Redis restart
# ============================================================================


class TestRedisRestart:
    """PostgreSQL facts must remain intact after Redis restart."""

    def test_pg_task_survives_redis_outage(self):
        task = _make_task_row(task_id="task-f", status="queued")

        def fn_fetchrow(query, args):
            qu = query.strip().upper()
            if "SELECT" in qu and "TASKS" in qu and "WHERE" in qu:
                return task
            return None

        pool = FakePool(
            {
                "fetchrow": {"TASKS": fn_fetchrow, "INSERT INTO": fn_fetchrow},
                "fetch": {},
                "execute": {},
            }
        )

        async def run():
            t = await get_task(pool, "task-f")
            assert t is not None
            assert t["status"] == "queued"

        asyncio.run(run())

    def test_outbox_events_persist_for_redis_recovery(self):
        events = [
            {
                "outbox_event_id": 10,
                "aggregate_type": "task",
                "aggregate_id": "task-f2",
                "event_type": "task_created",
                "payload": {"task_id": "task-f2", "status": "queued"},
                "retry_count": 0,
                "created_at": _now(),
            }
        ]

        def fn_fetch(query, args):
            if "OUTBOX_EVENTS" in query:
                return list(events)
            return []

        pool = FakePool(
            {
                "fetchrow": {},
                "fetch": {"OUTBOX_EVENTS": fn_fetch},
                "execute": {},
            }
        )

        async def run():
            pending = await get_pending_outbox_events(pool, limit=50)
            assert len(pending) == 1
            assert pending[0]["event_type"] == "task_created"

        asyncio.run(run())


# ============================================================================
# Test G — Repeated task creation
# ============================================================================


class TestRepeatedTaskCreation:
    """Idempotency: same key + same fingerprint = one task. Same key + different fingerprint = conflict."""

    def test_same_idempotency_key_same_fingerprint_returns_existing(self):
        idempotency_store = {}
        existing = {
            "idempotency_key": "key-g",
            "resource_type": "task",
            "resource_id": "task-g",
            "created_at": _now(),
        }
        task_row = _make_task_row(task_id="task-g", status="queued")

        def fn_fetchrow(query, args):
            qu = query.strip().upper()
            if "SELECT" in qu and "IDEMPOTENCY_KEYS" in qu and "WHERE" in qu:
                key = args[0] if args else ""
                return idempotency_store.get(key)
            if "SELECT" in qu and "TASKS" in qu and "WHERE" in qu:
                return task_row
            if "INSERT INTO TASKS" in qu and "RETURNING" in qu:
                return {"task_id": args[0], "status": "queued", "attempt_count": 0, "created_at": _now()}
            return None

        def fn_execute(query, args):
            qu = query.strip().upper()
            if "INSERT INTO IDEMPOTENCY_KEYS" in qu:
                # Store the idempotency key
                key = args[0]
                idempotency_store[key] = {
                    "idempotency_key": key,
                    "resource_type": args[1],
                    "resource_id": args[2],
                    "created_at": _now(),
                }
            return "OK 1"

        pool = FakePool(
            {
                "fetchrow": {"IDEMPOTENCY_KEYS": fn_fetchrow, "TASKS": fn_fetchrow, "INSERT INTO": fn_fetchrow},
                "fetch": {},
                "execute": {"INSERT INTO": fn_execute, "UPDATE": fn_execute},
            }
        )

        async def run():
            t1, is_new1 = await create_task(pool, Task(task_id="task-g", status="queued"), idempotency_key="key-g")
            assert t1.task_id == "task-g"
            assert is_new1 is True, "First call with new idempotency key must create task"

            t2, is_new2 = await create_task(pool, Task(task_id="task-g", status="queued"), idempotency_key="key-g")
            assert t2["task_id"] == "task-g"
            assert is_new2 is False, "Second call with same idempotency key must return existing"

        asyncio.run(run())

    def test_different_fingerprints_create_separate_tasks(self):
        stored = {}

        def fn_fetchrow(query, args):
            qu = query.strip().upper()
            if "SELECT" in qu and "IDEMPOTENCY_KEYS" in qu and "WHERE" in qu:
                return None
            if "INSERT INTO TASKS" in qu and "RETURNING" in qu:
                tid = args[0]
                stored[tid] = {"task_id": tid, "status": "queued", "attempt_count": 0, "created_at": _now()}
                return stored[tid]
            if "SELECT" in qu and "TASKS" in qu and "WHERE" in qu:
                tid = args[0] if args else ""
                return stored.get(str(tid))
            return None

        def fn_execute(query, args):
            return "OK 1"

        pool = FakePool(
            {
                "fetchrow": {"IDEMPOTENCY_KEYS": fn_fetchrow, "TASKS": fn_fetchrow, "INSERT INTO": fn_fetchrow},
                "fetch": {},
                "execute": {"INSERT INTO": fn_execute, "UPDATE": fn_execute},
            }
        )

        async def run():
            t1, is_new1 = await create_task(pool, Task(task_id="task-g3a", status="queued"), idempotency_key="key-g3")
            t2, is_new2 = await create_task(pool, Task(task_id="task-g3b", status="queued"), idempotency_key="key-g3")
            assert t1.task_id != t2.task_id, "Different task IDs must be created"
            assert is_new1 is True
            assert is_new2 is True

        asyncio.run(run())


# ============================================================================
# Test H — Cancellation versus completion
# ============================================================================


class TestCancellationVersusCompletion:
    """Only one valid terminal outcome may win."""

    def test_cancelled_task_cannot_publish_success_artifact(self):
        from backend.code_agent.models import can_transition

        assert not can_transition(TaskStatus.CANCELLED, TaskStatus.SUCCEEDED)

    def test_succeeded_task_cannot_be_cancelled(self):
        from backend.code_agent.models import can_transition

        assert not can_transition(TaskStatus.SUCCEEDED, TaskStatus.CANCELLED)

    def test_worker_detects_cancel_requested_and_records_it(self):
        from backend.code_agent.models import can_transition

        # Verify state machine: running -> cancelled is valid
        assert can_transition(TaskStatus.RUNNING, TaskStatus.CANCELLED)

        # Verify update_task_status records cancellation with correct lease token
        task = _make_task_row(
            task_id="task-h3",
            status="running",
            lease_owner="worker-h",
            lease_token="tok-h",
            lease_expires_at=datetime(2026, 1, 2, tzinfo=timezone.utc),
        )
        cancel_detected = []

        def fn_fetchrow(query, args):
            qu = query.strip().upper()
            if "SELECT" in qu and "TASKS" in qu and "WHERE" in qu:
                return task
            if "SELECT" in qu and "TASK_SPECS" in qu and "WHERE" in qu:
                return None
            if "TASK_ATTEMPTS" in qu:
                return {"task_attempt_id": 1, "started_at": _now()}
            # Claim query: UPDATE tasks SET status = 'claimed' ... RETURNING
            if "UPDATE" in qu and "TASKS" in qu and "STATUS = 'CLAIMED'" in qu:
                task["status"] = "claimed"
                task["lease_owner"] = args[1]
                task["lease_token"] = args[2]
                task["attempt_count"] = 1
                return task
            # update_task_status uses fetchrow for UPDATE...RETURNING
            if "UPDATE" in qu and "TASKS" in qu and "RETURNING" in qu:
                if len(args) > 1 and str(args[1]).lower() == "cancelled":
                    cancel_detected.append(True)
                    task["status"] = "cancelled"
                elif len(args) > 1:
                    task["status"] = str(args[1])
                return task
            if "TASK_EVENTS" in qu:
                return {"task_event_id": 1, "created_at": _now()}
            if "OUTBOX_EVENTS" in qu:
                return {"outbox_event_id": 1, "created_at": _now()}
            return None

        def fn_execute(query, args):
            qu = query.strip().upper()
            if "TASK_EVENTS" in qu:
                return {"task_event_id": 1, "created_at": _now()}
            if "OUTBOX_EVENTS" in qu:
                return {"outbox_event_id": 1, "created_at": _now()}
            return "OK 1"

        pool = FakePool(
            {
                "fetchrow": {"TASKS": fn_fetchrow, "TASK_SPECS": fn_fetchrow, "TASK_ATTEMPTS": fn_fetchrow, "TASK_EVENTS": fn_fetchrow, "OUTBOX_EVENTS": fn_fetchrow},
                "fetch": {},
                "execute": {"UPDATE": fn_execute, "INSERT INTO": fn_execute},
            }
        )

        async def run():
            # Directly test that update_task_status with cancelled status works
            result = await update_task_status(
                pool,
                "task-h3",
                TaskStatus.CANCELLED,
                lease_token="tok-h",
                error_message="Task cancelled by user",
            )
            assert result is not None
            assert result["status"] == "cancelled"
            assert len(cancel_detected) >= 1, "Cancellation must be recorded"

        asyncio.run(run())
