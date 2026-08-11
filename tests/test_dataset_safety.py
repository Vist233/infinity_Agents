from __future__ import annotations

import zipfile

import pytest

import backend.app as app_module
from backend.code_agent.worker.executor import _stage_dataset
from backend.security import SecurityBoundaryError


def _write_zip(path, payload: bytes, name: str = "data.bin") -> None:
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(name, payload)


def test_csv_validation_reads_a_bounded_sample(tmp_path, monkeypatch):
    monkeypatch.setattr(app_module, "MAX_DATASET_VALIDATION_SAMPLE_BYTES", 1024)
    path = tmp_path / "large.csv"
    path.write_bytes(b"value\n" + (b"x\n" * 2048))

    result = app_module._validate_dataset_file(path)

    assert result["passed"] is True
    assert result["size_bytes"] == path.stat().st_size


def test_dataset_zip_rejects_unsafe_compression_ratio(tmp_path, monkeypatch):
    path = tmp_path / "ratio.zip"
    _write_zip(path, b"0" * 100_000)
    monkeypatch.setattr(app_module, "MAX_DATASET_ZIP_COMPRESSION_RATIO", 2.0)

    result = app_module._validate_dataset_file(path)

    assert result == {
        "passed": False,
        "code": "zip_compression_ratio",
        "message": "ZIP compression ratio is unsafe",
    }


def test_worker_rejects_zip_bomb_before_extracting(tmp_path, monkeypatch):
    upload_root = tmp_path / "uploads"
    upload_root.mkdir()
    path = upload_root / "ratio.zip"
    _write_zip(path, b"0" * 100_000)
    monkeypatch.setenv("DATASET_UPLOAD_ROOT", str(upload_root))
    monkeypatch.setenv("DATASET_ZIP_MAX_COMPRESSION_RATIO", "2")

    with pytest.raises(SecurityBoundaryError, match="compression ratio"):
        _stage_dataset(path, tmp_path / "input")

    assert not (tmp_path / "input" / "data.bin").exists()
