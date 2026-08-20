from __future__ import annotations

import os
from pathlib import Path

import pytest

from backend.auth import Principal, create_session_cookie, principal_from_session_cookie
from backend.resource_broker import EgressDenied, ResourceBroker, ResourceForbidden
from backend.security import (
    ArtifactCollector,
    SecurityBoundaryError,
    safe_relative_path,
    validate_outbound_url,
    validate_runtime_database_url,
    validate_runtime_redis_url,
)
from backend.code_agent.worker.executor import _validated_control_plane_url
from agent.tools.image_analyzer import ImageAnalysisTools


def test_session_cookie_is_signed_and_expires(monkeypatch):
    monkeypatch.setenv("SESSION_COOKIE_SECRET", "test-secret")
    cookie = create_session_cookie(Principal(user_id="alice", issuer="test"), ttl_seconds=60)
    assert principal_from_session_cookie(cookie).user_id == "alice"
    with pytest.raises(Exception):
        principal_from_session_cookie(cookie[:-1] + ("a" if cookie[-1] != "a" else "b"))


@pytest.mark.parametrize("value", ["../secret", "/etc/passwd", "a/../../b", ""])
def test_relative_paths_cannot_escape(value):
    with pytest.raises(SecurityBoundaryError):
        safe_relative_path(value)


def test_ssrf_policy_rejects_loopback_and_credentials():
    with pytest.raises(SecurityBoundaryError):
        validate_outbound_url("http://127.0.0.1/private", allow_http_local=True)
    with pytest.raises(SecurityBoundaryError):
        validate_outbound_url("https://user:password@example.com/data")


def test_worker_control_plane_requires_https_outside_local_acceptance(monkeypatch):
    monkeypatch.setenv("APP_ENV", "production")
    with pytest.raises(SecurityBoundaryError):
        _validated_control_plane_url("http://control.example.com")


def test_worker_control_plane_allows_explicit_local_acceptance_http(monkeypatch):
    monkeypatch.setenv("APP_ENV", "acceptance")
    assert _validated_control_plane_url("http://api:8008") == "http://api:8008"


def test_remote_runtime_connections_require_verified_tls(monkeypatch):
    monkeypatch.setenv("APP_ENV", "production")
    with pytest.raises(SecurityBoundaryError):
        validate_runtime_database_url("postgresql://user:pass@db.example.com/app")
    with pytest.raises(SecurityBoundaryError):
        validate_runtime_redis_url("redis://:pass@redis.example.com:6379/0")
    assert validate_runtime_database_url(
        "postgresql://user:pass@db.example.com/app?sslmode=verify-full"
    )
    assert validate_runtime_redis_url(
        "rediss://:pass@redis.example.com:6380/0?ssl_cert_reqs=required"
    )


def test_runtime_transport_allows_compose_service_names(monkeypatch):
    monkeypatch.setenv("APP_ENV", "acceptance")
    assert validate_runtime_database_url("postgresql://user:pass@postgres/app")
    assert validate_runtime_redis_url("redis://:pass@redis:6379/0")


def test_artifact_collector_rejects_symlink_and_hardlink(tmp_path: Path):
    root = tmp_path / "output"
    root.mkdir()
    (root / "ok.txt").write_text("ok")
    (root / "escape").symlink_to("/etc/hosts")
    with pytest.raises(SecurityBoundaryError):
        ArtifactCollector().collect(root, tmp_path / "result.zip")

    (root / "escape").unlink()
    os.link(root / "ok.txt", root / "hardlink.txt")
    with pytest.raises(SecurityBoundaryError):
        ArtifactCollector().collect(root, tmp_path / "result-2.zip")


def test_artifact_collector_rejects_credential_content(tmp_path: Path):
    root = tmp_path / "output"
    root.mkdir()
    (root / "report.txt").write_text("ANTHROPIC_API_KEY=do-not-publish-this")
    with pytest.raises(SecurityBoundaryError):
        ArtifactCollector().collect(root, tmp_path / "result.zip")


def test_image_analysis_rejects_symlinked_paths(tmp_path: Path):
    root = tmp_path / "images"
    root.mkdir()
    outside = tmp_path / "outside.png"
    outside.write_bytes(b"not-an-image")
    link = root / "linked.png"
    link.symlink_to(outside)

    tools = ImageAnalysisTools(allowed_dirs=[root])
    assert tools._is_path_allowed(link) is False


def test_artifact_archive_is_deterministic(tmp_path: Path):
    root = tmp_path / "output"
    root.mkdir()
    (root / "report.txt").write_text("stable\n")
    first = ArtifactCollector().collect(root, tmp_path / "first.zip")
    second = ArtifactCollector().collect(root, tmp_path / "second.zip")
    assert first.checksum_sha256 == second.checksum_sha256


def test_artifact_collection_can_be_cancelled_mid_stream(tmp_path: Path):
    root = tmp_path / "output"
    root.mkdir()
    (root / "large.bin").write_bytes(b"x" * (4 * 1024 * 1024))
    archive = tmp_path / "cancelled.zip"
    checks = 0

    def cancel_during_collection() -> None:
        nonlocal checks
        checks += 1
        if checks >= 5:
            raise RuntimeError("cancelled during collection")

    with pytest.raises(RuntimeError, match="cancelled during collection"):
        ArtifactCollector().collect(root, archive, progress_check=cancel_during_collection)

    assert checks >= 5
    assert not archive.exists()
    assert not list(tmp_path.glob("artifact-*.zip"))


def test_resource_broker_uses_opaque_ids_and_authorization(tmp_path: Path):
    source = tmp_path / "dataset.csv"
    source.write_text("gene,value\nA,1\n")
    broker = ResourceBroker(tmp_path / "store", authorize=lambda record, user: user == "alice")
    record = broker.register_file(source, project_id="p1")
    assert record.resource_id != record.storage_key
    assert broker.read_bytes(record.resource_id, user_id="alice").startswith(b"gene")
    with pytest.raises(ResourceForbidden):
        broker.read_bytes(record.resource_id, user_id="bob")


def test_resource_broker_requires_provider_allowed_for_egress(tmp_path: Path):
    source = tmp_path / "paper.txt"
    source.write_text("evidence")
    broker = ResourceBroker(tmp_path / "store")
    local = broker.register_file(source, project_id="p1", egress_policy="local_only")
    with pytest.raises(EgressDenied):
        broker.authorize_egress(local.resource_id, user_id="alice", provider_id="analysis-primary", purpose="analysis", content_kind="text")
    allowed = broker.register_file(source, project_id="p1", egress_policy="provider_allowed")
    decision = broker.authorize_egress(allowed.resource_id, user_id="alice", provider_id="analysis-primary", purpose="analysis", content_kind="text")
    assert decision["resource_id"] == allowed.resource_id
    assert "storage_key" not in decision
