from __future__ import annotations

import hashlib
import json
import zipfile

import pytest
from fastapi import HTTPException

from backend.app import _validate_result_archive
from backend.app import _cleanup_worker_staging
from backend.security import ArtifactCollector


def test_worker_result_archive_requires_matching_manifest(tmp_path):
    output = tmp_path / "output"
    output.mkdir()
    (output / "summary.md").write_text("result\n", encoding="utf-8")
    collected = ArtifactCollector().collect(output, tmp_path / "result.zip")

    metadata = _validate_result_archive(collected.archive_path)

    assert metadata["file_count"] == 1
    assert metadata["byte_count"] == len(b"result\n")
    assert metadata["manifest_version"] == 1


def test_worker_result_archive_rejects_missing_manifest(tmp_path):
    archive_path = tmp_path / "missing-manifest.zip"
    with zipfile.ZipFile(archive_path, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("summary.md", "result\n")

    with pytest.raises(HTTPException) as exc_info:
        _validate_result_archive(archive_path)

    assert exc_info.value.status_code == 422


def test_worker_result_archive_rejects_checksum_mismatch(tmp_path):
    archive_path = tmp_path / "bad-manifest.zip"
    payload = b"result\n"
    manifest = {
        "version": 1,
        "files": [{
            "path": "summary.md",
            "size": len(payload),
            "sha256": hashlib.sha256(b"tampered\n").hexdigest(),
        }],
    }
    with zipfile.ZipFile(archive_path, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("summary.md", payload)
        archive.writestr("manifest.json", json.dumps(manifest))

    with pytest.raises(HTTPException) as exc_info:
        _validate_result_archive(archive_path)

    assert exc_info.value.status_code == 422


def test_worker_result_archive_rejects_secret_content(tmp_path):
    archive_path = tmp_path / "secret-output.zip"
    payload = b"api_key=long-lived-secret-value\n"
    manifest = {
        "version": 1,
        "files": [{
            "path": "summary.md",
            "size": len(payload),
            "sha256": hashlib.sha256(payload).hexdigest(),
        }],
    }
    with zipfile.ZipFile(archive_path, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("summary.md", payload)
        archive.writestr("manifest.json", json.dumps(manifest))

    with pytest.raises(HTTPException) as exc_info:
        _validate_result_archive(archive_path)

    assert exc_info.value.status_code == 422


def test_worker_staging_cleanup_only_removes_stale_entries(tmp_path, monkeypatch):
    staging = tmp_path / ".worker-staging"
    staging.mkdir()
    stale = staging / "stale-upload"
    stale.write_bytes(b"old")
    fresh = staging / "fresh-upload"
    fresh.write_bytes(b"new")
    monkeypatch.setenv("ARTIFACT_STAGING_TTL_SECONDS", "300")
    import os
    import time
    os.utime(stale, (time.time() - 600, time.time() - 600))

    assert _cleanup_worker_staging(tmp_path) == 1
    assert not stale.exists()
    assert fresh.exists()


def test_worker_staging_cleanup_does_not_follow_staging_symlink(tmp_path, monkeypatch):
    target = tmp_path / "outside"
    target.mkdir()
    stale = target / "stale-upload"
    stale.write_bytes(b"old")
    (tmp_path / ".worker-staging").symlink_to(target, target_is_directory=True)
    monkeypatch.setenv("ARTIFACT_STAGING_TTL_SECONDS", "300")
    import os
    import time
    os.utime(stale, (time.time() - 600, time.time() - 600))

    assert _cleanup_worker_staging(tmp_path) == 0
    assert stale.exists()
