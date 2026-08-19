from __future__ import annotations

import hashlib
from pathlib import Path

import pytest
from fastapi import HTTPException

from backend.app import (
    _assemble_multipart_archive,
    _multipart_limits,
    _worker_artifact_destination,
    _validate_upload_staging_path,
)


def test_multipart_limits_are_bounded_by_server_configuration(monkeypatch):
    monkeypatch.setenv("ARTIFACT_MULTIPART_THRESHOLD_BYTES", "300")
    monkeypatch.setenv("ARTIFACT_MULTIPART_PART_BYTES", "100")
    monkeypatch.setenv("ARTIFACT_MULTIPART_MIN_PART_BYTES", "64")
    monkeypatch.setenv("ARTIFACT_MULTIPART_MAX_PART_BYTES", "80")
    monkeypatch.setenv("ARTIFACT_MULTIPART_MAX_PARTS", "7")

    assert _multipart_limits() == (300, 64, 80, 7)


def test_multipart_assembly_streams_parts_and_checks_archive_hash(tmp_path):
    staging = tmp_path / ".worker-staging" / "upload"
    staging.mkdir(parents=True)
    first = b"first\n"
    second = b"second\n"
    first_path = staging / "part-00000000.bin"
    second_path = staging / "part-00000001.bin"
    first_path.write_bytes(first)
    second_path.write_bytes(second)
    payload = first + second
    destination = staging / "assembled.result.zip"

    size, checksum = _assemble_multipart_archive(
        staging,
        [
            {
                "storage_path": str(first_path),
                "file_size_bytes": len(first),
                "checksum_sha256": hashlib.sha256(first).hexdigest(),
            },
            {
                "storage_path": str(second_path),
                "file_size_bytes": len(second),
                "checksum_sha256": hashlib.sha256(second).hexdigest(),
            },
        ],
        destination,
        len(payload),
        hashlib.sha256(payload).hexdigest(),
    )

    assert size == len(payload)
    assert checksum == hashlib.sha256(payload).hexdigest()
    assert destination.read_bytes() == payload


def test_multipart_assembly_rejects_symlink_parts(tmp_path):
    staging = tmp_path / "staging"
    staging.mkdir()
    target = staging / "real.bin"
    target.write_bytes(b"part")
    link = staging / "part-00000000.bin"
    link.symlink_to(target)

    with pytest.raises(HTTPException) as exc_info:
        _assemble_multipart_archive(
            staging,
            [{
                "storage_path": str(link),
                "file_size_bytes": 4,
                "checksum_sha256": hashlib.sha256(b"part").hexdigest(),
            }],
            staging / "assembled.result.zip",
            4,
            hashlib.sha256(b"part").hexdigest(),
        )

    assert exc_info.value.status_code == 422


def test_multipart_assembly_rejects_part_checksum_change(tmp_path):
    staging = tmp_path / "staging"
    staging.mkdir()
    part = staging / "part-00000000.bin"
    part.write_bytes(b"actual")

    with pytest.raises(HTTPException) as exc_info:
        _assemble_multipart_archive(
            staging,
            [{
                "storage_path": str(part),
                "file_size_bytes": len(b"actual"),
                "checksum_sha256": hashlib.sha256(b"different").hexdigest(),
            }],
            staging / "assembled.result.zip",
            len(b"actual"),
            hashlib.sha256(b"actual").hexdigest(),
        )

    assert exc_info.value.status_code == 422


def test_multipart_staging_path_rejects_symlink_root(tmp_path):
    staging_root = tmp_path / ".worker-staging"
    staging_root.mkdir()
    target = staging_root / "real-upload"
    target.mkdir()
    link = staging_root / "upload-id"
    link.symlink_to(target, target_is_directory=True)

    with pytest.raises(HTTPException) as exc_info:
        _validate_upload_staging_path(staging_root, str(link), "upload-id")

    assert exc_info.value.status_code == 409


def test_artifact_destination_rejects_directory_symlink(tmp_path, monkeypatch):
    monkeypatch.setenv("ARTIFACT_DOWNLOAD_ROOT", str(tmp_path))
    outside = tmp_path / "outside"
    outside.mkdir()
    (tmp_path / "remote").symlink_to(outside, target_is_directory=True)

    with pytest.raises(HTTPException) as exc_info:
        _worker_artifact_destination(
            "4350c45b-fd0c-4771-b654-c6df32e95f9c",
            "artifact-12345678901234567890",
        )

    assert exc_info.value.status_code == 503


def test_multipart_schema_has_lease_bound_worker_policies():
    schema = Path("backend/db.py").read_text(encoding="utf-8")
    rls = Path("scripts/rls_roles.sql").read_text(encoding="utf-8")

    assert "CREATE TABLE IF NOT EXISTS artifact_uploads" in schema
    assert "CREATE TABLE IF NOT EXISTS artifact_upload_parts" in schema
    assert "GRANT UPDATE (status, updated_at, completed_at) ON artifact_uploads TO infinity_worker" in rls
    assert "GRANT UPDATE (expected_file_size_bytes" not in rls
    assert "CREATE POLICY artifact_upload_worker_policy" in rls
    assert "CREATE POLICY artifact_upload_parts_worker_policy" in rls
    assert "CREATE OR REPLACE FUNCTION app.worker_has_active_attempt" in rls
    assert "artifact_uploads.task_id, artifact_uploads.task_attempt_id" in rls
    assert "app.worker_has_active_attempt(u.task_id" in rls


def test_multipart_finalize_is_single_sql_transaction():
    source = Path("backend/app.py").read_text(encoding="utf-8")

    assert "WITH inserted AS (" in source
    assert "SET status = 'completed', updated_at = NOW(), completed_at = NOW()" in source
    assert "async with conn.transaction():" in source
