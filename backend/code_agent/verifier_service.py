"""Independent Docker verifier for Cloudflare Worker result artifacts.

The execution Worker is intentionally unable to publish a user-visible result.
This small service owns the separate verifier credential, reads quarantine
artifacts through the verifier-only control API, checks the downloaded archive,
and then asks the control plane to publish it.  It never receives a Worker
credential, a provider key, Redis credentials, or a Docker socket.
"""

from __future__ import annotations

import hashlib
import logging
import os
import re
import stat
import time
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any, Dict, Iterable

import requests

logger = logging.getLogger(__name__)

_CHUNK_SIZE = 1024 * 1024
_MAX_ARTIFACT_ID_LENGTH = 160
_SAFE_ID = re.compile(r"[^A-Za-z0-9._-]+")


class ArtifactVerificationError(RuntimeError):
    """Raised when a quarantine artifact fails the independent checks."""


def _required(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise SystemExit(f"{name} is required")
    return value


def _safe_artifact_filename(artifact_id: str) -> str:
    safe = _SAFE_ID.sub("_", artifact_id)[:_MAX_ARTIFACT_ID_LENGTH].strip(".")
    return safe or "artifact"


def _safe_member_name(name: str) -> None:
    normalized = name.replace("\\", "/")
    path = PurePosixPath(normalized)
    if normalized.startswith("/") or path.is_absolute() or ".." in path.parts:
        raise ArtifactVerificationError(f"archive contains an unsafe path: {name!r}")


def verify_zip_archive(path: Path, expected_size: int, expected_sha256: str) -> Dict[str, Any]:
    """Validate size, SHA-256, CRCs, and archive member safety without extracting."""
    digest = hashlib.sha256()
    actual_size = 0
    with path.open("rb") as source:
        while True:
            chunk = source.read(_CHUNK_SIZE)
            if not chunk:
                break
            digest.update(chunk)
            actual_size += len(chunk)
    actual_sha256 = digest.hexdigest()
    if actual_size != int(expected_size):
        raise ArtifactVerificationError(
            f"artifact size mismatch: expected {expected_size}, got {actual_size}"
        )
    if actual_sha256 != str(expected_sha256).lower():
        raise ArtifactVerificationError("artifact checksum mismatch")

    try:
        with zipfile.ZipFile(path) as archive:
            members = archive.infolist()
            if not members:
                raise ArtifactVerificationError("artifact archive is empty")
            seen: set[str] = set()
            for member in members:
                _safe_member_name(member.filename)
                if member.filename in seen:
                    raise ArtifactVerificationError(
                        f"archive contains a duplicate member: {member.filename!r}"
                    )
                seen.add(member.filename)
                mode = (member.external_attr >> 16) & 0xFFFF
                if stat.S_ISLNK(mode):
                    raise ArtifactVerificationError(
                        f"archive contains a symbolic link: {member.filename!r}"
                    )
            corrupt_member = archive.testzip()
            if corrupt_member:
                raise ArtifactVerificationError(
                    f"archive CRC check failed for {corrupt_member!r}"
                )
    except zipfile.BadZipFile as exc:
        raise ArtifactVerificationError("artifact is not a valid ZIP archive") from exc

    return {
        "size_bytes": actual_size,
        "sha256": actual_sha256,
        "archive_members": len(members),
        "archive_integrity": True,
        "paths_safe": True,
        "symlinks_rejected": True,
    }


class CloudflareArtifactVerifier:
    def __init__(
        self,
        control_url: str,
        token: str,
        work_dir: Path,
        poll_interval: float = 5.0,
        session: requests.Session | None = None,
    ) -> None:
        self.control_url = control_url.rstrip("/")
        self.token = token
        self.work_dir = work_dir
        self.poll_interval = max(1.0, poll_interval)
        self.session = session or requests.Session()
        self.session.headers.update({"x-worker-verifier-token": token})
        self.work_dir.mkdir(parents=True, exist_ok=True)

    def _get_pending(self) -> Iterable[Dict[str, Any]]:
        response = self.session.get(
            f"{self.control_url}/api/worker/v1/verifier/pending",
            params={"limit": 10},
            timeout=(10, 30),
        )
        response.raise_for_status()
        payload = response.json()
        artifacts = payload.get("artifacts", []) if isinstance(payload, dict) else []
        return artifacts if isinstance(artifacts, list) else []

    def _download(self, artifact: Dict[str, Any], destination: Path) -> None:
        artifact_id = str(artifact.get("artifact_id", "")).strip()
        if not artifact_id:
            raise ArtifactVerificationError("pending artifact has no id")
        response = self.session.get(
            f"{self.control_url}/api/worker/v1/verifier/artifacts/{artifact_id}",
            stream=True,
            timeout=(10, 300),
        )
        response.raise_for_status()
        with destination.open("wb") as target:
            for chunk in response.iter_content(chunk_size=_CHUNK_SIZE):
                if chunk:
                    target.write(chunk)

    def _publish(self, artifact: Dict[str, Any], checks: Dict[str, Any]) -> None:
        artifact_id = str(artifact["artifact_id"])
        attempt_id = str(artifact["attempt_id"])
        response = self.session.post(
            f"{self.control_url}/api/worker/v1/verifier/attempts/{attempt_id}/publish",
            json={"artifact_id": artifact_id, "passed": True, "checks": checks},
            timeout=(10, 30),
        )
        response.raise_for_status()
        logger.info(
            "published artifact %s for attempt %s",
            artifact_id,
            attempt_id,
        )

    def verify_one(self, artifact: Dict[str, Any]) -> Dict[str, Any]:
        artifact_id = str(artifact.get("artifact_id", "")).strip()
        expected_size = int(artifact.get("file_size_bytes", 0))
        expected_sha256 = str(artifact.get("checksum_sha256", "")).strip().lower()
        if expected_size <= 0 or len(expected_sha256) != 64:
            raise ArtifactVerificationError("pending artifact metadata is invalid")
        destination = self.work_dir / f"{_safe_artifact_filename(artifact_id)}.zip"
        try:
            self._download(artifact, destination)
            checks = verify_zip_archive(destination, expected_size, expected_sha256)
            self._publish(artifact, checks)
            return checks
        finally:
            try:
                destination.unlink()
            except FileNotFoundError:
                pass

    def poll_once(self) -> int:
        published = 0
        for artifact in self._get_pending():
            try:
                self.verify_one(artifact)
                published += 1
            except Exception as exc:  # keep the verifier alive for later artifacts
                artifact_id = str(artifact.get("artifact_id", "unknown"))[:80]
                logger.warning("artifact %s was not published: %s", artifact_id, exc)
        return published

    def run_forever(self) -> None:
        while True:
            try:
                self.poll_once()
            except Exception as exc:
                logger.warning("verifier poll failed: %s", exc)
            time.sleep(self.poll_interval)


def main() -> None:
    logging.basicConfig(
        level=os.getenv("LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    verifier = CloudflareArtifactVerifier(
        control_url=_required("CONTROL_BASE_URL"),
        token=_required("WORKER_VERIFIER_TOKEN"),
        work_dir=Path(os.getenv("VERIFIER_WORK_ROOT", "/verifier-work")),
        poll_interval=float(os.getenv("VERIFIER_POLL_INTERVAL", "5")),
    )
    if os.getenv("VERIFIER_RUN_ONCE", "").strip().lower() in {"1", "true", "yes"}:
        verifier.poll_once()
        return
    verifier.run_forever()


if __name__ == "__main__":
    main()
