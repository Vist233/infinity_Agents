from __future__ import annotations

import hashlib
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

    async def upload_artifact_part(self, _claim, _upload_id, part_number, _path, _offset, length):
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

    async def fake_runtime(*_args, output_dir, **_kwargs):
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
    archive = next((path for path in work_root.rglob("*.zip")), None)
    assert result["success"] is True
    assert result["artifact_id"] == "artifact-1"
    assert client.uploaded
    assert client.finished == []
    assert not (work_root / claim.task_id / claim.attempt_id).exists()
    assert archive is None
