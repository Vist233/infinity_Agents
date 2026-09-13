from __future__ import annotations

import hashlib
import json
import logging
import zipfile

import pytest
from fastapi import HTTPException

from backend.app import _validate_result_archive
from backend.app import _cleanup_worker_staging
from backend.security import (
    ArtifactCollector,
    MAX_SECURITY_DIAGNOSTIC_EVENTS,
    SecurityBoundaryError,
    reject_completion_content,
    reject_secret_content,
)


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


def test_worker_result_archive_allows_non_secret_completion_metadata(tmp_path):
    output = tmp_path / "output"
    output.mkdir()
    (output / "agent_completion.json").write_text(
        json.dumps({
            "status": "completed",
            "summary": "No secret: none; token: not provided",
            "outputs": {},
        }),
        encoding="utf-8",
    )

    collected = ArtifactCollector().collect(output, tmp_path / "result.zip")

    metadata = _validate_result_archive(collected.archive_path)
    assert metadata["file_count"] == 1


def test_worker_result_archive_allows_wrapped_non_secret_completion_status(tmp_path):
    output = tmp_path / "output"
    output.mkdir()
    (output / "agent_completion.json").write_text(
        json.dumps({
            "status": "completed",
            "summary": "No API key, token, password, or secret was used.",
            "api_key": "<not applicable>",
            "token": "",
            "secret": [],
        }),
        encoding="utf-8",
    )

    collected = ArtifactCollector().collect(output, tmp_path / "result.zip")

    assert collected.file_count == 1


def test_worker_result_archive_allows_escaped_safe_completion_summary(tmp_path):
    output = tmp_path / "output"
    output.mkdir()
    (output / "agent_completion.json").write_text(
        json.dumps({
            "status": "completed",
            "summary": 'The metadata record says token: "not applicable".',
            "outputs": {},
        }),
        encoding="utf-8",
    )

    collected = ArtifactCollector().collect(output, tmp_path / "result.zip")

    assert _validate_result_archive(collected.archive_path)["file_count"] == 1


def test_worker_result_archive_allows_explicit_empty_credential_metadata(tmp_path):
    output = tmp_path / "output"
    output.mkdir()
    (output / "agent_completion.json").write_text(
        json.dumps({"status": "completed", "token": None, "api_key": "not applicable"}),
        encoding="utf-8",
    )

    collected = ArtifactCollector().collect(output, tmp_path / "result.zip")

    assert _validate_result_archive(collected.archive_path)["file_count"] == 1


def test_worker_result_archive_still_rejects_secret_in_completion_metadata(tmp_path):
    for summary in ("token: do-not-publish-this", "secret: <not applicable>evil"):
        output = tmp_path / summary.split(":", 1)[0].replace(" ", "-")
        output.mkdir()
        (output / "agent_completion.json").write_text(
            json.dumps({"summary": summary}),
            encoding="utf-8",
        )

        with pytest.raises(SecurityBoundaryError, match="credential-like content"):
            ArtifactCollector().collect(output, tmp_path / f"{output.name}.zip")


def test_worker_result_archive_rejects_credential_in_escaped_completion_summary(tmp_path):
    output = tmp_path / "output"
    output.mkdir()
    (output / "agent_completion.json").write_text(
        json.dumps({"summary": 'token: "do-not-publish-this"'}),
        encoding="utf-8",
    )

    with pytest.raises(SecurityBoundaryError, match="credential-like content"):
        ArtifactCollector().collect(output, tmp_path / "result.zip")


def test_worker_result_archive_rejects_credential_value_in_metadata_field(tmp_path):
    output = tmp_path / "output"
    output.mkdir()
    (output / "agent_completion.json").write_text(
        json.dumps({"status": "completed", "token": "do-not-publish-this"}),
        encoding="utf-8",
    )

    with pytest.raises(SecurityBoundaryError, match="credential-like content"):
        ArtifactCollector().collect(output, tmp_path / "result.zip")


def test_completion_diagnostic_identifies_pattern_without_values(caplog):
    caplog.set_level(logging.WARNING, logger="backend.security")
    payload = json.dumps({"summary": "token: do-not-publish-this"}).encode("utf-8")

    with pytest.raises(SecurityBoundaryError, match="credential-like content"):
        reject_completion_content(payload)

    messages = [record.getMessage() for record in caplog.records]
    assert any(
        "scanner=artifact-secret-scan-v3 rule=completion_metadata category=generic_secret_assignment" in message
        for message in messages
    )
    assert all("do-not-publish-this" not in message for message in messages)
    assert all("summary" not in message for message in messages)


def test_completion_diagnostic_identifies_credential_field_without_values(caplog):
    caplog.set_level(logging.WARNING, logger="backend.security")
    payload = json.dumps({"provider_api_key": "credential-value"}).encode("utf-8")

    with pytest.raises(SecurityBoundaryError, match="credential-like content"):
        reject_completion_content(payload)

    messages = [record.getMessage() for record in caplog.records]
    assert any(
        "scanner=artifact-secret-scan-v3 rule=completion_metadata category=credential_field" in message
        for message in messages
    )
    assert all("provider_api_key" not in message for message in messages)
    assert all("credential-value" not in message for message in messages)


def test_security_diagnostic_telemetry_is_bounded(monkeypatch, caplog):
    import backend.security as security_module

    monkeypatch.setattr(security_module, "_security_diagnostic_events", 0)
    caplog.set_level(logging.WARNING, logger="backend.security")
    for _ in range(MAX_SECURITY_DIAGNOSTIC_EVENTS + 3):
        with pytest.raises(SecurityBoundaryError, match="credential-like content"):
            reject_secret_content(b"token: bounded-test-value")

    messages = [
        record.getMessage()
        for record in caplog.records
        if "artifact security rejection" in record.getMessage()
    ]
    assert len(messages) == MAX_SECURITY_DIAGNOSTIC_EVENTS
    assert all("bounded-test-value" not in message for message in messages)


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
