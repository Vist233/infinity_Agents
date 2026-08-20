"""Shared security boundaries for local and acceptance execution.

This module intentionally contains no FastAPI or database code.  Keeping path,
URL, secret, and artifact policy in one small module makes it possible to test
the dangerous edges without booting the whole application.
"""

from __future__ import annotations

import hashlib
import ipaddress
import json
import logging
import os
import re
import socket
import stat
import tempfile
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable, Iterator, Optional
from urllib.parse import parse_qs, urlparse

logger = logging.getLogger(__name__)


class SecurityBoundaryError(ValueError):
    """Raised when an input crosses a local security boundary."""


_SECRET_PATTERNS = (
    re.compile(r"(?:sk|pk)-[A-Za-z0-9_-]{16,}"),
    re.compile(r"(?i)\b(?:anthropic|stepfun|openai|aws|github)_[A-Z0-9_]*\s*=\s*[^\s]+"),
    re.compile(r"(?i)\b(?:api[_-]?key|token|password|secret)\s*[:=]\s*[^\s]+"),
    re.compile(r"(?i)\b(?:postgres(?:ql)?|redis|mysql|mongodb)://[^\s]+"),
)


def redact_secrets(value: object, *, max_chars: int = 2000) -> str:
    """Return a bounded, log-safe representation of *value*."""

    text = str(value or "")
    for pattern in _SECRET_PATTERNS:
        text = pattern.sub("[REDACTED]", text)
    if len(text) > max_chars:
        text = text[:max_chars] + "...(truncated)"
    return text


def reject_secret_content(data: bytes, *, label: str = "output") -> None:
    """Reject a byte payload that appears to contain a long-lived secret."""

    sample = data[:2 * 1024 * 1024].decode("utf-8", errors="ignore")
    for pattern in _SECRET_PATTERNS:
        if pattern.search(sample):
            raise SecurityBoundaryError(f"{label} contains credential-like content")


def reject_secret_file(
    path: Path,
    *,
    label: str = "output",
    chunk_size: int = 1024 * 1024,
    progress_check: Optional[Callable[[], None]] = None,
) -> None:
    """Scan an entire file for credential-like content without loading it all."""

    check = progress_check or (lambda: None)
    overlap = b""
    try:
        with path.open("rb") as handle:
            while True:
                check()
                chunk = handle.read(chunk_size)
                if not chunk:
                    break
                window = overlap + chunk
                # The overlap catches tokens split at a chunk boundary; the
                # regular function is bounded because ``window`` is bounded.
                reject_secret_content(window, label=label)
                overlap = window[-8192:]
    except OSError as exc:
        raise SecurityBoundaryError(f"unable to inspect artifact: {label}") from exc


def ensure_within(root: Path, candidate: Path, *, resolve: bool = True) -> Path:
    """Return *candidate* only when it is contained by *root*."""

    root_path = root.resolve()
    candidate_path = candidate.resolve() if resolve else candidate.absolute()
    try:
        candidate_path.relative_to(root_path)
    except ValueError as exc:
        raise SecurityBoundaryError("path is outside the allowed root") from exc
    return candidate_path


def safe_relative_path(value: str, *, allow_empty: bool = False) -> str:
    """Normalize a relative resource/output path and reject traversal."""

    raw = str(value or "").replace("\\", "/")
    if not raw and allow_empty:
        return ""
    if not raw or raw.startswith("/") or "\x00" in raw:
        raise SecurityBoundaryError("path must be a non-empty relative path")
    parts = [part for part in raw.split("/") if part not in {"", "."}]
    if not parts or any(part == ".." for part in parts):
        raise SecurityBoundaryError("path traversal is not allowed")
    normalized = "/".join(parts)
    if normalized.startswith("../") or normalized == "..":
        raise SecurityBoundaryError("path traversal is not allowed")
    return normalized


def _resolved_addresses(hostname: str) -> Iterator[ipaddress.IPv4Address | ipaddress.IPv6Address]:
    try:
        literal = ipaddress.ip_address(hostname)
        yield literal
        return
    except ValueError:
        pass
    try:
        infos = socket.getaddrinfo(hostname, None, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise SecurityBoundaryError("URL host could not be resolved") from exc
    seen: set[str] = set()
    for info in infos:
        address = info[4][0]
        if address in seen:
            continue
        seen.add(address)
        try:
            yield ipaddress.ip_address(address)
        except ValueError as exc:
            raise SecurityBoundaryError("URL resolved to an invalid address") from exc


def validate_outbound_url(
    url: str,
    *,
    allow_hosts: Optional[Iterable[str]] = None,
    allow_http_local: bool = False,
) -> str:
    """Validate a provider/paper URL against the SSRF policy.

    Redirects are deliberately handled by callers with ``follow_redirects``
    disabled and revalidated one hop at a time.
    """

    parsed = urlparse(str(url or "").strip())
    if parsed.scheme not in ({"https", "http"} if allow_http_local else {"https"}):
        raise SecurityBoundaryError("only approved HTTP schemes are allowed")
    if not parsed.hostname or parsed.username or parsed.password:
        raise SecurityBoundaryError("URL credentials and empty hosts are forbidden")
    try:
        port = parsed.port
    except ValueError as exc:
        raise SecurityBoundaryError("URL port is invalid") from exc
    hostname = parsed.hostname.rstrip(".").lower()
    allowed = {h.lower().strip() for h in (allow_hosts or ()) if h.strip()}
    allowed_local = allow_http_local and hostname in allowed
    if port not in (None, 80, 443) and not allowed_local:
        raise SecurityBoundaryError("non-standard URL ports require an explicit local allowlist")
    if hostname in allowed:
        return parsed.geturl()
    for address in _resolved_addresses(hostname):
        if address.is_private or address.is_loopback or address.is_link_local or address.is_reserved or address.is_multicast:
            raise SecurityBoundaryError("private, loopback, link-local, or reserved URL targets are forbidden")
    if parsed.scheme == "http" and not allow_http_local:
        raise SecurityBoundaryError("plain HTTP is allowed only for explicit local acceptance endpoints")
    return parsed.geturl()


_RUNTIME_INTERNAL_HOSTS = frozenset({
    "localhost",
    "127.0.0.1",
    "::1",
    "redis",
    "postgres",
})


def _runtime_transport_is_strict() -> bool:
    environment = os.getenv("APP_ENV", "development").lower()
    return environment in {"acceptance", "production", "prod"}


def validate_runtime_database_url(url: str) -> str:
    """Require PostgreSQL TLS for remote runtime connections.

    Compose service names are an explicit local-network exception. Any other
    host in acceptance/production must opt into certificate-verified TLS so a
    remote Worker cannot silently send database credentials and task data over
    plaintext.
    """
    value = str(url or "").strip()
    if not _runtime_transport_is_strict():
        return value
    parsed = urlparse(value)
    if parsed.scheme not in {"postgres", "postgresql"} or not parsed.hostname:
        raise SecurityBoundaryError("a valid PostgreSQL DSN is required")
    if parsed.hostname.lower().rstrip(".") in _RUNTIME_INTERNAL_HOSTS:
        return value
    query = parse_qs(parsed.query)
    if query.get("sslmode", [""])[-1].lower() != "verify-full":
        raise SecurityBoundaryError("remote PostgreSQL connections require sslmode=verify-full")
    return value


def validate_runtime_redis_url(url: str) -> str:
    """Require Redis TLS for remote runtime connections."""
    value = str(url or "").strip()
    if not _runtime_transport_is_strict():
        return value
    parsed = urlparse(value)
    if parsed.scheme not in {"redis", "rediss"} or not parsed.hostname:
        raise SecurityBoundaryError("a valid Redis URL is required")
    if parsed.hostname.lower().rstrip(".") in _RUNTIME_INTERNAL_HOSTS:
        return value
    if parsed.scheme != "rediss":
        raise SecurityBoundaryError("remote Redis connections require rediss://")
    query = parse_qs(parsed.query)
    if query.get("ssl_cert_reqs", [""])[-1].lower() not in {"required", "cert_required"}:
        raise SecurityBoundaryError("remote Redis connections require certificate verification")
    return value


@dataclass(frozen=True)
class CollectedArtifact:
    archive_path: Path
    manifest: dict
    checksum_sha256: str
    file_count: int
    byte_count: int


class ArtifactCollector:
    """Collect only ordinary files under an output root into a safe ZIP."""

    def __init__(
        self,
        *,
        max_files: int = 5000,
        max_file_bytes: int = 512 * 1024 * 1024,
        max_total_bytes: int = 2 * 1024 * 1024 * 1024,
    ) -> None:
        self.max_files = max_files
        self.max_file_bytes = max_file_bytes
        self.max_total_bytes = max_total_bytes

    def _iter_files(
        self,
        output_root: Path,
        *,
        progress_check: Optional[Callable[[], None]] = None,
    ) -> list[tuple[Path, str]]:
        check = progress_check or (lambda: None)
        root = output_root.resolve()
        if not root.is_dir() or root.is_symlink():
            raise SecurityBoundaryError("output root must be a real directory")
        files: list[tuple[Path, str]] = []
        for path in sorted(root.rglob("*")):
            check()
            relative = path.relative_to(root)
            safe_relative_path(relative.as_posix())
            info = path.lstat()
            if stat.S_ISLNK(info.st_mode):
                raise SecurityBoundaryError(f"unsupported output entry: {relative}")
            if stat.S_ISDIR(info.st_mode):
                continue
            if not stat.S_ISREG(info.st_mode):
                raise SecurityBoundaryError(f"unsupported output entry: {relative}")
            if info.st_nlink != 1:
                raise SecurityBoundaryError(f"hard-linked output is not allowed: {relative}")
            ensure_within(root, path)
            if info.st_size > self.max_file_bytes:
                raise SecurityBoundaryError(f"output file exceeds size limit: {relative}")
            files.append((path, relative.as_posix()))
            if len(files) > self.max_files:
                raise SecurityBoundaryError("output file count exceeds limit")
        return files

    def collect(
        self,
        output_root: Path,
        archive_path: Path,
        *,
        metadata: Optional[dict] = None,
        progress_check: Optional[Callable[[], None]] = None,
    ) -> CollectedArtifact:
        check = progress_check or (lambda: None)
        check()
        files = self._iter_files(output_root, progress_check=check)
        total = sum(path.stat().st_size for path, _ in files)
        if total > self.max_total_bytes:
            raise SecurityBoundaryError("total output size exceeds limit")
        manifest = {"version": 1, "files": [], "metadata": metadata or {}}
        archive_path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(prefix="artifact-", suffix=".zip", dir=archive_path.parent, delete=False) as tmp:
            temporary = Path(tmp.name)
        try:
            with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                for path, relative in files:
                    check()
                    reject_secret_file(path, label=relative, progress_check=check)
                    digest_hasher = hashlib.sha256()
                    size = 0
                    info = zipfile.ZipInfo(relative)
                    info.date_time = (1980, 1, 1, 0, 0, 0)
                    info.compress_type = zipfile.ZIP_DEFLATED
                    with path.open("rb") as source, archive.open(info, "w") as destination:
                        while True:
                            check()
                            chunk = source.read(1024 * 1024)
                            if not chunk:
                                break
                            size += len(chunk)
                            digest_hasher.update(chunk)
                            destination.write(chunk)
                    manifest["files"].append({"path": relative, "size": size, "sha256": digest_hasher.hexdigest()})
                manifest_data = json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode("utf-8")
                manifest_info = zipfile.ZipInfo("manifest.json")
                manifest_info.date_time = (1980, 1, 1, 0, 0, 0)
                manifest_info.compress_type = zipfile.ZIP_DEFLATED
                archive.writestr(manifest_info, manifest_data)
            temporary.replace(archive_path)
        except Exception:
            temporary.unlink(missing_ok=True)
            raise
        checksum_hasher = hashlib.sha256()
        with archive_path.open("rb") as archive_file:
            for chunk in iter(lambda: archive_file.read(1024 * 1024), b""):
                check()
                checksum_hasher.update(chunk)
        checksum = checksum_hasher.hexdigest()
        return CollectedArtifact(archive_path, manifest, checksum, len(files), total)
