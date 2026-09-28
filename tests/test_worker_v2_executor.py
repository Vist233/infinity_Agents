from __future__ import annotations

import hashlib
import asyncio
import os
from pathlib import Path

import pytest

from backend.code_agent.worker.control_plane import ClaimedTask
from backend.code_agent.worker import executor_v2


class FakeWorkerClient:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.finished: list[dict[str, object]] = []
        self.uploaded: list[tuple[int, int]] = []

    async def spec(self, _claim: ClaimedTask):
        return {
            "task_spec": {"title": "Case 2", "goal": "Run the goal", "analysis_type": "biopython"},
            "inputs": {
                "method": {"logical_name": "method.md", "file_size_bytes": 7, "sha256": hashlib.sha256(b"method\n").hexdigest()},
                "dataset": None,
            },
            "cancel_requested": False,
        }

    async def download_input(self, _claim, _kind, destination: Path, _expected):
        destination.write_bytes(b"method\n")
        return destination

    async def renew(self, _claim):
        return {"status": "running"}

    async def start_artifact(self, _claim, **kwargs):
        self._checksum = str(kwargs["sha256"])
        self._size = int(kwargs["size"])
        return {"upload_id": "upload-1", "part_size_bytes": 16 * 1024 * 1024}

    async def upload_artifact_part(self, _claim, _upload_id, part_number, _path, _offset, length, *, progress_check=None):
        if progress_check:
            progress_check()
        self.uploaded.append((part_number, length))
        return {"etag": f"etag-{part_number}"}

    async def complete_artifact(self, _claim, _upload_id, _parts):
        return {"artifact_id": "artifact-1", "checksum_sha256": self._checksum, "file_size_bytes": self._size}

    async def finish(self, _claim, **kwargs):
        self.finished.append(kwargs)
        return {"status": "failed"}


@pytest.mark.asyncio
async def test_d1_executor_uploads_result_and_clears_attempt_directory(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    work_root = tmp_path / "work"
    artifact_root = tmp_path / "artifacts"
    monkeypatch.setenv("WORKER_WORK_ROOT", str(work_root))
    monkeypatch.setenv("WORKER_ARTIFACT_ROOT", str(artifact_root))

    async def fake_runtime(*_args, case_dir, output_dir, **_kwargs):
        input_dir = Path(case_dir)
        spec_dir = input_dir.parent / "spec"
        nested_input = input_dir / "nested"
        nested_spec = spec_dir / "method_sources"
        nested_input.mkdir(parents=True, exist_ok=True)
        nested_spec.mkdir(parents=True, exist_ok=True)
        (nested_input / "method.md").write_text("method", encoding="utf-8")
        (nested_spec / "task_spec.json").write_text("{}", encoding="utf-8")
        if os.name != "nt":
            for directory in (input_dir, nested_input, spec_dir, nested_spec):
                directory.chmod(0o555)
            for file_path in (nested_input / "method.md", nested_spec / "task_spec.json"):
                file_path.chmod(0o444)
        output = Path(output_dir)
        output.mkdir(parents=True, exist_ok=True)
        (output / "report.md").write_text("Case 2 complete\n", encoding="utf-8")
        yield {"type": "done", "output": "done"}

    monkeypatch.setattr(executor_v2, "run_claude_task", fake_runtime)
    client = FakeWorkerClient(tmp_path)
    claim = ClaimedTask(
        task_id="task-2",
        task_spec_id="spec-2",
        dataset_snapshot_id="dataset-2",
        method_source_id="method-2",
        title="Case 2",
        attempt_id="attempt-2",
        lease_token="lease-2",
        fencing_epoch=1,
        lease_expires_at=100,
    )
    result = await executor_v2.execute_claim(client, claim)  # type: ignore[arg-type]
    assert result["success"] is True
    assert result["artifact_id"] == "artifact-1"
    assert client.uploaded
    assert client.finished == []
    assert not (work_root / claim.task_id / claim.attempt_id).exists()

    next_claim = ClaimedTask(
        task_id="task-3",
        task_spec_id="spec-3",
        dataset_snapshot_id="dataset-3",
        method_source_id="method-3",
        title="Case 3",
        attempt_id="attempt-3",
        lease_token="lease-3",
        fencing_epoch=1,
        lease_expires_at=100,
    )
    next_result = await executor_v2.execute_claim(client, next_claim)  # type: ignore[arg-type]
    assert next_result["success"] is True
    assert not (work_root / next_claim.task_id / next_claim.attempt_id).exists()


@pytest.mark.asyncio
async def test_artifact_publish_stops_before_start_when_cancelled(tmp_path: Path) -> None:
    archive = tmp_path / "result.zip"
    archive.write_bytes(b"result")
    client = FakeWorkerClient(tmp_path)
    claim = ClaimedTask(
        task_id="task-cancel", task_spec_id="spec", dataset_snapshot_id="dataset",
        method_source_id=None, title="Cancel", attempt_id="attempt-cancel",
        lease_token="lease", fencing_epoch=1, lease_expires_at=100,
    )
    cancel = asyncio.Event()
    cancel.set()
    with pytest.raises(executor_v2.TaskCancelledDuringPublish):
        await executor_v2._upload_result(
            client,
            claim,
            archive,
            {},
            hashlib.sha256(archive.read_bytes()).hexdigest(),
            cancel,
            asyncio.Event(),
        )
    assert not hasattr(client, "_checksum")
    assert client.uploaded == []
