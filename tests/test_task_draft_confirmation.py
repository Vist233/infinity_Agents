from __future__ import annotations

import uuid
import zipfile

import pytest

import backend.app as backend_app
from backend.auth import Principal


class _Transaction:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return None


class _Connection:
    def __init__(self, task_id: str):
        self.task_id = task_id
        self.idempotency = None
        self.statements: list[tuple[str, tuple[object, ...]]] = []

    def transaction(self):
        return _Transaction()

    async def fetchrow(self, query, *args):
        normalized = " ".join(query.upper().split())
        self.statements.append((normalized, args))
        if "FROM IDEMPOTENCY_KEYS" in normalized:
            if self.idempotency:
                return self.idempotency
            return None
        if "SELECT TASK_ID, STATUS, ATTEMPT_COUNT FROM TASKS" in normalized:
            return {"task_id": self.idempotency["resource_id"], "status": "queued", "attempt_count": 0}
        if "INSERT INTO TASKS" in normalized:
            return {"task_id": args[0], "status": "queued", "attempt_count": 0}
        if "INSERT INTO TASK_EVENTS" in normalized:
            return {"task_event_id": 1}
        return None

    async def execute(self, query, *args):
        normalized = " ".join(query.upper().split())
        self.statements.append((normalized, args))
        if "INSERT INTO IDEMPOTENCY_KEYS" in normalized:
            self.idempotency = {
                "resource_id": args[2],
                "request_hash": args[3],
            }
        return "INSERT 0 1"


class _Pool:
    def __init__(self, connection):
        self.connection = connection

    def acquire(self):
        pool = self

        class _Acquire:
            async def __aenter__(self):
                return pool.connection

            async def __aexit__(self, *args):
                return None

        return _Acquire()


@pytest.mark.asyncio
async def test_confirm_task_draft_freezes_inputs_once_and_replays_idempotently(monkeypatch, tmp_path):
    draft_id = str(uuid.uuid4())
    session_id = str(uuid.uuid4())
    resource_id = str(uuid.uuid4())
    task_id = str(uuid.uuid4())
    session_root = tmp_path / "session"
    method_path = session_root / "task-drafts" / draft_id / "revisions" / "1" / "method.md"
    method_path.parent.mkdir(parents=True)
    method_path.write_text("# Frozen method\n")
    resource_root = tmp_path / "resources"
    dataset_path = resource_root / "datasets" / resource_id
    dataset_path.parent.mkdir(parents=True)
    with zipfile.ZipFile(dataset_path, "w") as archive:
        archive.writestr("counts.csv", "sample,value\nA,1\n")

    draft = {
        "draft_id": draft_id,
        "session_id": session_id,
        "project_id": str(uuid.uuid4()),
        "revision": 1,
        "status": "awaiting_user_confirmation",
        "title": "Frozen method",
        "goal_summary": "Run the method",
        "method_path": str(method_path.relative_to(session_root)),
        "method_filename": "method.md",
        "method_preview": "# Frozen method",
        "method_size_bytes": method_path.stat().st_size,
        "method_hash_sha256": None,
        "dataset_resource_id": resource_id,
        "dataset_filename": "dataset.zip",
        "dataset_size_bytes": dataset_path.stat().st_size,
        "dataset_hash_sha256": None,
        "task_spec": {"analysis_type": "biopython"},
        "missing_inputs": [],
    }
    resource = {
        "resource_id": resource_id,
        "project_id": draft["project_id"],
        "kind": "dataset",
        "logical_name": "dataset.zip",
        "storage_key": f"datasets/{resource_id}",
        "file_size_bytes": dataset_path.stat().st_size,
        "checksum_sha256": None,
    }
    connection = _Connection(task_id)
    monkeypatch.setenv("RESOURCE_STORAGE_ROOT", str(resource_root))
    monkeypatch.setenv("METHOD_SOURCE_UPLOAD_ROOT", str(tmp_path / "methods"))
    monkeypatch.setattr(backend_app, "_get_session_root", lambda _session_id: session_root)
    async def get_draft(_pool, _draft_id, _user_id):
        current = dict(draft)
        if connection.idempotency:
            current["status"] = "confirmed"
        return current

    monkeypatch.setattr(backend_app, "get_task_draft", get_draft)
    monkeypatch.setattr(backend_app, "_get_project_resource", lambda *_args: _async_value(resource))
    monkeypatch.setattr(backend_app, "app", type("App", (), {"state": type("State", (), {"db_pool": _Pool(connection)})()})())

    request = backend_app.TaskDraftConfirmRequest(idempotency_key="confirm-once")
    first = await backend_app.confirm_task_draft_endpoint(draft_id, request, Principal(user_id="alice"))
    second = await backend_app.confirm_task_draft_endpoint(draft_id, request, Principal(user_id="alice"))

    assert first.task_id == second.task_id
    assert first.duplicate is False
    assert second.duplicate is True
    assert sum("INSERT INTO TASKS" in statement for statement, _ in connection.statements) == 1
    assert sum("INSERT INTO OUTBOX_EVENTS" in statement for statement, _ in connection.statements) == 1
    assert sum("INSERT INTO IDEMPOTENCY_KEYS" in statement for statement, _ in connection.statements) == 1


async def _async_value(value):
    return value
