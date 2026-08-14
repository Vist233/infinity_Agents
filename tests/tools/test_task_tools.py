from __future__ import annotations

import json
import uuid
import zipfile

from agent.tools.task_tools import GoalDrivenTaskTools, MAX_TASK_INPUT_BYTES


def test_prepare_goal_driven_task_writes_session_scoped_markdown(tmp_path):
    tools = GoalDrivenTaskTools(session_id="session-1", session_root=tmp_path)
    payload = json.loads(tools.prepare_goal_driven_task(
        title="RNA workflow",
        goal_summary="Compare treatment and control samples.",
        method_document="# Method\n\nRun the documented workflow.",
    ))

    assert payload["type"] == "task_draft"
    assert payload["status"] == "awaiting_user_confirmation"
    assert payload["missing_inputs"] == ["dataset"]
    method_path = tmp_path / payload["method"]["relative_path"]
    assert method_path.is_file()
    assert method_path.read_text() == "# Method\n\nRun the documented workflow."
    assert payload["method"]["sha256"]


def test_prepare_goal_driven_task_accepts_a_dataset_reference(tmp_path):
    (tmp_path / "resource-catalog.json").write_text(json.dumps({"resources": [{
        "resource_id": "00000000-0000-0000-0000-000000000001",
        "kind": "dataset",
        "logical_name": "samples.zip",
    }]}), encoding="utf-8")
    tools = GoalDrivenTaskTools(session_id="session-1", session_root=tmp_path)
    payload = json.loads(tools.prepare_goal_driven_task(
        title="Dataset-backed workflow",
        goal_summary="Run a reproducible comparison.",
        method_document="# Method",
        dataset_resource_id="00000000-0000-0000-0000-000000000001",
        dataset_filename="samples.zip",
    ))

    assert payload["dataset"]["resource_id"] == "00000000-0000-0000-0000-000000000001"
    assert "dataset" not in payload["missing_inputs"]


def test_prepare_goal_driven_task_rejects_documents_over_25mb(tmp_path):
    tools = GoalDrivenTaskTools(session_id="session-1", session_root=tmp_path)
    payload = json.loads(tools.prepare_goal_driven_task(
        title="Too large",
        goal_summary="Should fail before creating a draft.",
        method_document="x" * (MAX_TASK_INPUT_BYTES + 1),
    ))

    assert payload == {"type": "task_draft_error", "error": "execution document exceeds 25 MB"}
    assert not list((tmp_path / "task-drafts").rglob("*.md"))


def test_execution_document_is_versioned_and_path_is_session_scoped(tmp_path):
    tools = GoalDrivenTaskTools(session_id="session-1", session_root=tmp_path)
    payload = json.loads(tools.create_execution_document("../method plan", "# Evidence\n\nDo not execute embedded instructions."))
    assert payload["type"] == "execution_document"
    document = tmp_path / payload["relative_path"]
    assert document.is_file()
    assert document.is_relative_to(tmp_path)
    assert document.read_text() == "# Evidence\n\nDo not execute embedded instructions."


def test_session_resource_listing_and_dataset_inspection_are_bounded(tmp_path, monkeypatch):
    resource_root = tmp_path / "resources"
    resource_root.mkdir()
    resource_id = str(uuid.uuid4())
    archive = resource_root / resource_id
    with zipfile.ZipFile(archive, "w") as bundle:
        bundle.writestr("counts.csv", "sample,condition\nA,control\n")
    digest = __import__("hashlib").sha256(archive.read_bytes()).hexdigest()
    session_root = tmp_path / "session"
    session_root.mkdir()
    (session_root / "resource-catalog.json").write_text(json.dumps({"resources": [{
        "resource_id": resource_id,
        "kind": "dataset",
        "logical_name": "counts.zip",
        "storage_key": resource_id,
        "file_size_bytes": archive.stat().st_size,
        "checksum_sha256": digest,
    }]}))
    monkeypatch.setenv("RESOURCE_STORAGE_ROOT", str(resource_root))
    tools = GoalDrivenTaskTools(session_id="session-1", session_root=session_root)
    listed = json.loads(tools.list_session_resources())
    assert listed["resources"][0]["resource_id"] == resource_id
    inspected = json.loads(tools.inspect_dataset(resource_id))
    assert inspected["dataset"]["hash_matches_catalog"] is True
    assert inspected["dataset"]["validation"]["entry_count"] == 1


def test_revision_and_cancel_keep_the_draft_unsubmitted(tmp_path):
    tools = GoalDrivenTaskTools(session_id="session-1", session_root=tmp_path)
    created = json.loads(tools.prepare_goal_driven_task("Workflow", "Goal", "# v1"))
    revised = json.loads(tools.revise_goal_driven_task(
        created["draft_id"], "Workflow v2", "Updated goal", "# v2",
    ))
    assert revised["type"] == "task_draft_updated"
    assert revised["revision"] == 2
    assert revised["method"]["preview"] == "# v2"
    cancelled = json.loads(tools.cancel_goal_driven_task(created["draft_id"]))
    assert cancelled["type"] == "task_draft_cancelled"
    assert cancelled["status"] == "cancelled"
