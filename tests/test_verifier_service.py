"""Tests for the independent Cloudflare artifact verifier."""

from __future__ import annotations

import hashlib
import zipfile
from pathlib import Path

import pytest

from backend.code_agent.verifier_service import ArtifactVerificationError, verify_zip_archive


def _write_zip(path: Path, name: str = "report.txt", content: bytes = b"verified") -> None:
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(name, content)


def test_verify_zip_archive_checks_checksum_and_members(tmp_path: Path) -> None:
    archive = tmp_path / "result.zip"
    _write_zip(archive)
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()

    result = verify_zip_archive(archive, archive.stat().st_size, digest)

    assert result["archive_integrity"] is True
    assert result["paths_safe"] is True
    assert result["archive_members"] == 1


def test_verify_zip_archive_rejects_path_traversal(tmp_path: Path) -> None:
    archive = tmp_path / "unsafe.zip"
    _write_zip(archive, "../outside.txt")
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()

    with pytest.raises(ArtifactVerificationError, match="unsafe path"):
        verify_zip_archive(archive, archive.stat().st_size, digest)


def test_verify_zip_archive_rejects_checksum_mismatch(tmp_path: Path) -> None:
    archive = tmp_path / "result.zip"
    _write_zip(archive)

    with pytest.raises(ArtifactVerificationError, match="checksum"):
        verify_zip_archive(archive, archive.stat().st_size, "0" * 64)
