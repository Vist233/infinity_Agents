"""Safe source admission and deterministic PDF extraction for PAPER-07.

This module is deliberately independent of the public Worker and of all
platform databases. It accepts only canonical arXiv/PMC references, streams a
bounded response into a private temporary workspace, and produces manifest
metadata without local paths or source URL credentials.
"""

from __future__ import annotations

import hashlib
import ipaddress
import json
import logging
import math
import os
import re
import signal
import shutil
import socket
import sys
import tempfile
import threading
import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterator, Protocol
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin, urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener

try:
    import resource as _resource
except ImportError:  # pragma: no cover - only non-Unix runtimes
    _resource = None


import fitz
from pypdf import PdfReader


LOGGER = logging.getLogger("infinity.paper_processor")


class ProcessorError(RuntimeError):
    """A safe, machine-readable processing failure."""

    def __init__(self, code: str, message: str):
        self.code = code
        super().__init__(f"{code}: {message}")


class AdmissionError(ProcessorError):
    pass


class DownloadError(ProcessorError):
    pass


@dataclass(frozen=True)
class SourceDescriptor:
    source_kind: str
    canonical_ref: str
    url: str | None


@dataclass(frozen=True)
class ExtractionLimits:
    max_pdf_bytes: int = 64 * 1024 * 1024
    max_pages: int = 1_000
    max_images: int = 2_000
    max_image_dimension: int = 10_000
    max_image_bytes: int = 8 * 1024 * 1024
    max_total_image_bytes: int = 64 * 1024 * 1024
    max_redirects: int = 3
    max_resident_memory_bytes: int | None = 192 * 1024 * 1024


@dataclass(frozen=True)
class ProcessorRuntimeLimits:
    """Wall-clock, lease-heartbeat, and memory limits for one grant."""

    attempt_timeout_seconds: float = 240.0
    download_timeout_seconds: float = 90.0
    extraction_timeout_seconds: float = 120.0
    upload_timeout_seconds: float = 90.0
    heartbeat_interval_seconds: float = 30.0
    max_resident_memory_bytes: int = 192 * 1024 * 1024

    def __post_init__(self) -> None:
        numeric = (
            self.attempt_timeout_seconds,
            self.download_timeout_seconds,
            self.extraction_timeout_seconds,
            self.upload_timeout_seconds,
            self.heartbeat_interval_seconds,
        )
        if any(not math.isfinite(value) or value < 0 for value in numeric):
            raise ValueError("processor runtime timeouts must be finite and non-negative")
        if any(value > self.attempt_timeout_seconds for value in numeric[1:4] if self.attempt_timeout_seconds > 0):
            raise ValueError("processor stage timeout cannot exceed the attempt timeout")
        if not isinstance(self.max_resident_memory_bytes, int) or self.max_resident_memory_bytes <= 0:
            raise ValueError("processor memory budget must be positive")

    @classmethod
    def from_environment(cls) -> "ProcessorRuntimeLimits":
        defaults = cls()

        def read_float(name: str, default: float, maximum: float) -> float:
            raw = os.environ.get(name, "").strip()
            try:
                value = float(raw)
            except ValueError:
                return default
            return value if math.isfinite(value) and 0 < value <= maximum else default

        def read_int(name: str, default: int, minimum: int, maximum: int) -> int:
            raw = os.environ.get(name, "").strip()
            try:
                value = int(raw)
            except ValueError:
                return default
            return value if minimum <= value <= maximum else default

        attempt = read_float("PAPER_PROCESSOR_ATTEMPT_TIMEOUT_SECONDS", defaults.attempt_timeout_seconds, 240.0)
        download = read_float("PAPER_PROCESSOR_DOWNLOAD_TIMEOUT_SECONDS", min(defaults.download_timeout_seconds, attempt), attempt)
        extraction = read_float("PAPER_PROCESSOR_EXTRACTION_TIMEOUT_SECONDS", min(defaults.extraction_timeout_seconds, attempt), attempt)
        upload = read_float("PAPER_PROCESSOR_UPLOAD_TIMEOUT_SECONDS", min(defaults.upload_timeout_seconds, attempt), attempt)
        heartbeat = read_float("PAPER_PROCESSOR_HEARTBEAT_INTERVAL_SECONDS", min(defaults.heartbeat_interval_seconds, attempt), min(120.0, attempt))
        memory = read_int(
            "PAPER_PROCESSOR_MAX_RESIDENT_MEMORY_BYTES",
            defaults.max_resident_memory_bytes,
            64 * 1024 * 1024,
            240 * 1024 * 1024,
        )
        return cls(attempt, download, extraction, upload, heartbeat, memory)


@dataclass(frozen=True)
class DownloadedPdf:
    path: Path
    size_bytes: int
    sha256: str


class ProcessingDeadline:
    """A monotonic attempt/stage budget with stable public error codes."""

    _STAGE_LIMITS = {
        "downloading": ("download_timeout_seconds", "PAPER_PROCESSOR_DOWNLOAD_TIMEOUT"),
        "extracting": ("extraction_timeout_seconds", "PAPER_PROCESSOR_EXTRACTION_TIMEOUT"),
        "uploading": ("upload_timeout_seconds", "PAPER_PROCESSOR_UPLOAD_TIMEOUT"),
    }

    def __init__(self, limits: ProcessorRuntimeLimits, *, clock: Callable[[], float] = time.monotonic) -> None:
        self._limits = limits
        self._clock = clock
        self._started_at = clock()
        self._stage_started_at: dict[str, float] = {}

    def start_stage(self, stage: str) -> None:
        if stage not in self._STAGE_LIMITS:
            raise ValueError("unsupported processor stage")
        self._stage_started_at[stage] = self._clock()

    def check(self, stage: str) -> None:
        stage_setting = self._STAGE_LIMITS.get(stage)
        if stage_setting is None:
            raise ValueError("unsupported processor stage")
        now = self._clock()
        if self._limits.attempt_timeout_seconds == 0 or now - self._started_at >= self._limits.attempt_timeout_seconds:
            raise ProcessorError("PAPER_PROCESSOR_TIMEOUT", "paper processing exceeded the attempt deadline")
        stage_started_at = self._stage_started_at.setdefault(stage, now)
        stage_limit = getattr(self._limits, stage_setting[0])
        if stage_limit == 0 or now - stage_started_at >= stage_limit:
            raise ProcessorError(stage_setting[1], "paper processing exceeded the stage deadline")


def _resident_memory_bytes() -> int | None:
    """Return resident memory without relying on a platform-specific daemon."""
    try:
        with open("/proc/self/status", encoding="ascii") as status_file:
            for line in status_file:
                if line.startswith("VmRSS:"):
                    return int(line.split()[1]) * 1024
    except (OSError, ValueError):
        pass
    if _resource is None:
        return None
    try:
        value = int(_resource.getrusage(_resource.RUSAGE_SELF).ru_maxrss)
        return value if sys.platform == "darwin" else value * 1024
    except (OSError, ValueError):
        return None


def _check_memory(limits: ExtractionLimits, *, stage: str) -> None:
    maximum = limits.max_resident_memory_bytes
    if maximum is None:
        return
    current = _resident_memory_bytes()
    if current is not None and current > maximum:
        raise ProcessorError("PAPER_PROCESSOR_MEMORY_LIMIT", "paper processing memory budget exceeded")


class LeaseHeartbeat:
    """Renew one D1 lease in the background while a synchronous parse runs."""

    def __init__(self, client: Any, grant: Any, *, interval_seconds: float) -> None:
        self._client = client
        self._grant = grant
        self._interval_seconds = interval_seconds
        self._stop_event = threading.Event()
        self._lock = threading.Lock()
        self._failure: str | None = None
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if self._interval_seconds <= 0:
            return
        self._thread = threading.Thread(target=self._run, name="paper-processor-heartbeat", daemon=True)
        self._thread.start()

    def _run(self) -> None:
        while not self._stop_event.wait(self._interval_seconds):
            try:
                renewed = self._client.renew(self._grant)
                if not isinstance(renewed, dict):
                    raise RuntimeError("heartbeat response was invalid")
            except Exception:
                with self._lock:
                    self._failure = "PAPER_PROCESSOR_HEARTBEAT_FAILED"
                self._stop_event.set()
                return

    def raise_if_failed(self) -> None:
        with self._lock:
            failure = self._failure
        if failure:
            raise ProcessorError(failure, "paper processing lease renewal failed")

    def stop(self) -> None:
        self._stop_event.set()
        thread = self._thread
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=1.0)


def _runtime_checkpoint(deadline: ProcessingDeadline, heartbeat: LeaseHeartbeat | None, stage: str) -> None:
    deadline.check(stage)
    if heartbeat is not None:
        heartbeat.raise_if_failed()


@contextmanager
def _attempt_alarm(seconds: float) -> Iterator[None]:
    """Interrupt a stuck synchronous parser on Unix; checkpoints cover fallback runtimes."""
    if seconds <= 0 or threading.current_thread() is not threading.main_thread() or not hasattr(signal, "setitimer"):
        yield
        return
    previous_handler: Any | None = None
    previous_timer = (0.0, 0.0)
    try:
        previous_handler = signal.getsignal(signal.SIGALRM)
        previous_timer = signal.setitimer(signal.ITIMER_REAL, 0)

        def timeout_handler(_signum: int, _frame: Any) -> None:
            raise ProcessorError("PAPER_PROCESSOR_TIMEOUT", "paper processing exceeded the attempt deadline")

        signal.signal(signal.SIGALRM, timeout_handler)
        signal.setitimer(signal.ITIMER_REAL, seconds)
    except (AttributeError, OSError, ValueError):
        try:
            signal.setitimer(signal.ITIMER_REAL, 0)
            if previous_handler is not None:
                signal.signal(signal.SIGALRM, previous_handler)
            if previous_timer != (0.0, 0.0):
                signal.setitimer(signal.ITIMER_REAL, *previous_timer)
        except (AttributeError, OSError, ValueError):
            pass
        yield
        return
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous_handler)
        if previous_timer != (0.0, 0.0):
            signal.setitimer(signal.ITIMER_REAL, *previous_timer)


@dataclass
class ExtractionResult:
    pages: list[dict[str, Any]]
    images: list[dict[str, Any]]
    manifest: dict[str, Any]
    has_text: bool
    source_size_bytes: int
    source_sha256: str

    def text_pages_jsonl(self) -> bytes:
        rows = []
        for page in self.pages:
            rows.append(json.dumps({"page": page["page"], "text": page["text"]}, ensure_ascii=False, separators=(",", ":")))
        return ("\n".join(rows) + ("\n" if rows else "")).encode("utf-8")

    def image_manifest_json(self) -> bytes:
        return json.dumps({"resource_id": self.manifest["resource_id"], "images": self.manifest["images"]}, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def _invalid(kind: str, message: str) -> AdmissionError:
    return AdmissionError(kind, message)


def _canonical_arxiv(value: str) -> str | None:
    value = value.strip()
    match = re.fullmatch(r"(\d{4}\.\d{4,5}(?:v\d+)?)", value)
    if match:
        return match.group(1)
    match = re.fullmatch(r"([a-z-]+/\d{7}(?:v\d+)?)", value, flags=re.IGNORECASE)
    return match.group(1) if match else None


def _arxiv_from_url(value: str) -> str | None:
    parsed = urlparse(value)
    if parsed.scheme != "https" or parsed.hostname != "arxiv.org" or parsed.username or parsed.password or parsed.query or parsed.fragment:
        return None
    match = re.fullmatch(r"/(?:pdf|abs)/((?:\d{4}\.\d{4,5}|[a-z-]+/\d{7})(?:v\d+)?)(?:\.pdf)?", parsed.path, flags=re.IGNORECASE)
    return match.group(1) if match else None


def _canonical_pmc(value: str) -> str | None:
    value = value.strip().upper()
    return value if re.fullmatch(r"PMC\d+", value) else None


def _pmc_from_url(value: str) -> str | None:
    parsed = urlparse(value)
    if parsed.scheme != "https" or parsed.hostname not in {"www.ncbi.nlm.nih.gov", "ncbi.nlm.nih.gov", "pmc.ncbi.nlm.nih.gov"} or parsed.username or parsed.password or parsed.query or parsed.fragment:
        return None
    match = re.fullmatch(r"/(?:pmc/articles|articles)/(PMC\d+)/pdf/?", parsed.path, flags=re.IGNORECASE)
    return match.group(1).upper() if match else None


def admit_source(source_kind: str, source_ref: str, canonical_ref: str | None = None) -> SourceDescriptor:
    if not isinstance(source_kind, str) or not isinstance(source_ref, str) or not source_ref.strip():
        raise _invalid("SOURCE_REFERENCE_INVALID", "source reference is required")
    if source_kind == "arxiv":
        identifier = _canonical_arxiv(source_ref) or _arxiv_from_url(source_ref)
        if not identifier:
            raise _invalid("SOURCE_REFERENCE_INVALID", "arXiv reference is not canonical")
        if canonical_ref and (_canonical_arxiv(canonical_ref) or _arxiv_from_url(canonical_ref)) != identifier:
            raise _invalid("SOURCE_REFERENCE_INVALID", "arXiv canonical reference mismatch")
        return SourceDescriptor(source_kind, identifier, f"https://arxiv.org/pdf/{identifier}.pdf")
    if source_kind == "pubmed_pmc":
        identifier = _canonical_pmc(source_ref) or _pmc_from_url(source_ref)
        if not identifier:
            raise _invalid("SOURCE_REFERENCE_INVALID", "PMC reference is not canonical")
        if canonical_ref and (_canonical_pmc(canonical_ref) or _pmc_from_url(canonical_ref)) != identifier:
            raise _invalid("SOURCE_REFERENCE_INVALID", "PMC canonical reference mismatch")
        return SourceDescriptor(source_kind, identifier, f"https://www.ncbi.nlm.nih.gov/pmc/articles/{identifier}/pdf")
    if source_kind == "user_upload":
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,254}", source_ref.strip()):
            raise _invalid("SOURCE_REFERENCE_INVALID", "upload reference is not an opaque resource reference")
        return SourceDescriptor(source_kind, source_ref.strip(), None)
    raise _invalid("SOURCE_NOT_ALLOWED", "only arXiv, eligible PMC, and private upload references are admitted")


def _public_ip(address: str) -> bool:
    try:
        ip = ipaddress.ip_address(address)
    except ValueError:
        return False
    return not (ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_reserved or ip.is_unspecified)


def _resolve_addresses(host: str) -> list[str]:
    return [item[4][0] for item in socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)]


def _validate_public_url(url: str, resolve_host: Callable[[str], list[str]]) -> str:
    parsed = urlparse(url)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise DownloadError("REDIRECT_URL_INVALID", "source URL must be HTTPS without credentials")
    try:
        addresses = resolve_host(parsed.hostname)
    except (OSError, socket.gaierror):
        raise DownloadError("DNS_RESOLUTION_FAILED", "source host did not resolve")
    if not addresses or not all(_public_ip(address) for address in addresses):
        raise DownloadError("REDIRECT_PRIVATE_ADDRESS", "source host resolved to a non-public address")
    return parsed.hostname.lower()


ALLOWED_SOURCE_HOSTS = {"arxiv.org", "export.arxiv.org", "www.ncbi.nlm.nih.gov", "ncbi.nlm.nih.gov", "pmc.ncbi.nlm.nih.gov"}


class Opener(Protocol):
    def open(self, request: Request, timeout: int = ...) -> Any: ...


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *_args: Any, **_kwargs: Any) -> None:
        return None


def download_pdf(
    source: SourceDescriptor,
    destination: Path,
    *,
    opener: Opener | None = None,
    resolve_host: Callable[[str], list[str]] = _resolve_addresses,
    limits: ExtractionLimits | None = None,
    deadline: ProcessingDeadline | None = None,
    heartbeat: LeaseHeartbeat | None = None,
) -> DownloadedPdf:
    limits = limits or ExtractionLimits()
    if source.url is None:
        raise DownloadError("UPLOAD_INPUT_REQUIRED", "private upload bytes must be served by the Edge attempt endpoint")
    current_url = source.url
    redirects = 0
    opener = opener or build_opener(NoRedirect())
    destination.parent.mkdir(parents=True, exist_ok=True)
    try:
        while True:
            if deadline is not None:
                _runtime_checkpoint(deadline, heartbeat, "downloading")
            host = _validate_public_url(current_url, resolve_host)
            if host not in ALLOWED_SOURCE_HOSTS:
                raise DownloadError("REDIRECT_HOST_NOT_ALLOWED", "redirect host is outside the admitted source set")
            request = Request(current_url, headers={"Accept": "application/pdf", "User-Agent": "Infinity-Paper-Processor/1"})
            try:
                response = opener.open(request, timeout=30)
            except HTTPError as error:
                response = error
            except URLError as error:
                raise DownloadError("SOURCE_FETCH_FAILED", "source fetch failed") from error
            status = int(getattr(response, "status", None) or response.getcode())
            if status in {301, 302, 303, 307, 308}:
                location = response.headers.get("Location")
                if not location:
                    raise DownloadError("REDIRECT_INVALID", "redirect did not provide a location")
                redirects += 1
                if redirects > limits.max_redirects:
                    raise DownloadError("REDIRECT_LIMIT", "source redirect chain exceeded the limit")
                next_url = urljoin(current_url, location)
                next_host = _validate_public_url(next_url, resolve_host)
                if next_host not in ALLOWED_SOURCE_HOSTS:
                    raise DownloadError("REDIRECT_HOST_NOT_ALLOWED", "redirect host is outside the admitted source set")
                current_url = next_url
                continue
            if status < 200 or status >= 300:
                raise DownloadError("SOURCE_HTTP_STATUS", "source returned a non-success status")
            content_length = response.headers.get("Content-Length")
            if content_length:
                try:
                    if int(content_length) > limits.max_pdf_bytes:
                        raise DownloadError("PDF_TOO_LARGE", "declared source size exceeds the limit")
                except ValueError:
                    pass
            digest = hashlib.sha256()
            total = 0
            prefix = bytearray()
            with response, destination.open("wb") as handle:
                while True:
                    if deadline is not None:
                        _runtime_checkpoint(deadline, heartbeat, "downloading")
                    chunk = response.read(64 * 1024)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > limits.max_pdf_bytes:
                        raise DownloadError("PDF_TOO_LARGE", "source stream exceeds the limit")
                    if len(prefix) < 5:
                        prefix.extend(chunk[: 5 - len(prefix)])
                    digest.update(chunk)
                    handle.write(chunk)
            if bytes(prefix) != b"%PDF-":
                raise DownloadError("PDF_MAGIC_INVALID", "source does not begin with PDF magic")
            content_type = str(response.headers.get("Content-Type", "")).lower().split(";", 1)[0].strip()
            if content_type and content_type not in {"application/pdf", "application/octet-stream"} and "pdf" not in content_type:
                raise DownloadError("NON_PDF_CONTENT", "source content type is not PDF")
            if deadline is not None:
                _runtime_checkpoint(deadline, heartbeat, "downloading")
            return DownloadedPdf(destination, total, digest.hexdigest())
    except DownloadError:
        destination.unlink(missing_ok=True)
        raise
    except ProcessorError:
        destination.unlink(missing_ok=True)
        raise
    except (OSError, ValueError) as error:
        destination.unlink(missing_ok=True)
        raise DownloadError("SOURCE_FETCH_FAILED", "source could not be stored") from error


def _source_digest(path: Path, maximum: int) -> tuple[int, str]:
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as handle:
        while chunk := handle.read(64 * 1024):
            size += len(chunk)
            if size > maximum:
                raise ProcessorError("PDF_TOO_LARGE", "PDF exceeds the processing limit")
            digest.update(chunk)
    return size, digest.hexdigest()


def _content_type(extension: str) -> str:
    return {"png": "image/png", "jpeg": "image/jpeg", "jpg": "image/jpeg", "jp2": "image/jp2"}.get(extension.lower(), "application/octet-stream")


def extract_pdf(
    pdf_path: Path,
    output_dir: Path,
    *,
    limits: ExtractionLimits | None = None,
    resource_id: str = "fixture-resource",
    deadline: ProcessingDeadline | None = None,
    heartbeat: LeaseHeartbeat | None = None,
) -> ExtractionResult:
    limits = limits or ExtractionLimits()
    if deadline is not None:
        deadline.start_stage("extracting")
        _runtime_checkpoint(deadline, heartbeat, "extracting")
    _check_memory(limits, stage="extracting")
    source_size, source_sha256 = _source_digest(pdf_path, limits.max_pdf_bytes)
    try:
        with pdf_path.open("rb") as handle:
            prefix = handle.read(5)
        if prefix != b"%PDF-":
            raise ProcessorError("PDF_MAGIC_INVALID", "PDF magic is invalid")
    except OSError as error:
        raise ProcessorError("PDF_INPUT_UNREADABLE", "PDF input is not readable") from error
    shutil.rmtree(output_dir, ignore_errors=True)
    output_dir.mkdir(parents=True, exist_ok=True)
    try:
        if deadline is not None:
            _runtime_checkpoint(deadline, heartbeat, "extracting")
        _check_memory(limits, stage="extracting")
        try:
            reader = PdfReader(str(pdf_path), strict=True)
            if reader.is_encrypted:
                raise ProcessorError("ENCRYPTED_PDF_UNSUPPORTED", "encrypted PDFs are not admitted")
            page_count = len(reader.pages)
        except ProcessorError:
            raise
        except MemoryError as error:
            raise ProcessorError("PAPER_PROCESSOR_MEMORY_LIMIT", "paper processing memory budget exceeded") from error
        except Exception as error:
            raise ProcessorError("MALFORMED_PDF", "PDF parser rejected the input") from error
        if page_count > limits.max_pages:
            raise ProcessorError("PAGE_COUNT_LIMIT", "PDF page count exceeds the limit")

        pages: list[dict[str, Any]] = []
        for page_number, page in enumerate(reader.pages, start=1):
            if deadline is not None:
                _runtime_checkpoint(deadline, heartbeat, "extracting")
            _check_memory(limits, stage="extracting")
            try:
                text = page.extract_text() or ""
            except MemoryError as error:
                raise ProcessorError("PAPER_PROCESSOR_MEMORY_LIMIT", "paper processing memory budget exceeded") from error
            except Exception as error:
                raise ProcessorError("TEXT_EXTRACTION_FAILED", "PDF text extraction failed") from error
            pages.append({"page": page_number, "text": text, "text_bytes": len(text.encode("utf-8")), "images": []})
            if deadline is not None:
                _runtime_checkpoint(deadline, heartbeat, "extracting")
            _check_memory(limits, stage="extracting")

        images: list[dict[str, Any]] = []
        total_image_bytes = 0
        document = fitz.open(str(pdf_path))
        try:
            if document.page_count != page_count:
                raise ProcessorError("PDF_PAGE_COUNT_MISMATCH", "PDF parsers disagreed on page count")
            for page_index in range(document.page_count):
                if deadline is not None:
                    _runtime_checkpoint(deadline, heartbeat, "extracting")
                _check_memory(limits, stage="extracting")
                page = document.load_page(page_index)
                for image_index, image in enumerate(page.get_images(full=True), start=1):
                    if deadline is not None:
                        _runtime_checkpoint(deadline, heartbeat, "extracting")
                    _check_memory(limits, stage="extracting")
                    if len(images) >= limits.max_images:
                        raise ProcessorError("IMAGE_COUNT_LIMIT", "embedded image count exceeds the limit")
                    try:
                        extracted = document.extract_image(image[0])
                        width = int(extracted.get("width", 0))
                        height = int(extracted.get("height", 0))
                        image_bytes = bytes(extracted["image"])
                        extension = str(extracted.get("ext", "")).lower()
                        if width <= 0 or height <= 0 or width > limits.max_image_dimension or height > limits.max_image_dimension:
                            raise ProcessorError("IMAGE_DIMENSION_LIMIT", "embedded image dimensions exceed the limit")
                        if len(image_bytes) > limits.max_image_bytes:
                            raise ProcessorError("IMAGE_BYTE_LIMIT", "embedded image exceeds the limit")
                        if extension not in {"png", "jpeg", "jpg", "jp2"}:
                            raise ProcessorError("IMAGE_FORMAT_UNSUPPORTED", "embedded image format is not supported")
                        if extension != "png":
                            pixmap = fitz.Pixmap(document, image[0])
                            try:
                                image_bytes = pixmap.tobytes("png")
                            finally:
                                pixmap = None
                            extension = "png"
                            if len(image_bytes) > limits.max_image_bytes:
                                raise ProcessorError("IMAGE_BYTE_LIMIT", "normalized embedded image exceeds the limit")
                        total_image_bytes += len(image_bytes)
                        if total_image_bytes > limits.max_total_image_bytes:
                            raise ProcessorError("IMAGE_TOTAL_BYTE_LIMIT", "total embedded image bytes exceed the limit")
                        image_id = f"page-{page_index + 1:04d}-image-{image_index:04d}"
                        image_path = output_dir / "images" / f"{image_id}.png"
                        image_path.parent.mkdir(parents=True, exist_ok=True)
                        image_path.write_bytes(image_bytes)
                        image_hash = hashlib.sha256(image_bytes).hexdigest()
                        metadata = {"image_id": image_id, "page": page_index + 1, "width": width, "height": height, "content_type": _content_type(extension), "size_bytes": len(image_bytes), "sha256": image_hash}
                        pages[page_index]["images"].append(image_id)
                        images.append({**metadata, "local_path": str(image_path)})
                        if deadline is not None:
                            _runtime_checkpoint(deadline, heartbeat, "extracting")
                        _check_memory(limits, stage="extracting")
                    except ProcessorError:
                        raise
                    except MemoryError as error:
                        raise ProcessorError("PAPER_PROCESSOR_MEMORY_LIMIT", "paper processing memory budget exceeded") from error
                    except Exception as error:
                        raise ProcessorError("IMAGE_EXTRACTION_FAILED", "embedded image extraction failed") from error
        finally:
            document.close()

        has_text = any(bool(page["text"].strip()) for page in pages)
        warnings = [] if has_text else ["no_text_layer"]
        manifest_images = [{key: value for key, value in image.items() if key != "local_path"} for image in images]
        manifest_pages = [{"page": page["page"], "text_bytes": page["text_bytes"], "images": page["images"]} for page in pages]
        manifest = {"resource_id": resource_id, "parser_version": "paper-processor-pdf-1", "source_size_bytes": source_size, "source_sha256": source_sha256, "page_count": page_count, "image_count": len(images), "pages": manifest_pages, "images": manifest_images, "warnings": warnings}
        if deadline is not None:
            _runtime_checkpoint(deadline, heartbeat, "extracting")
        _check_memory(limits, stage="extracting")
        return ExtractionResult(pages, images, manifest, has_text, source_size, source_sha256)
    except MemoryError as error:
        shutil.rmtree(output_dir, ignore_errors=True)
        raise ProcessorError("PAPER_PROCESSOR_MEMORY_LIMIT", "paper processing memory budget exceeded") from error
    except ProcessorError as error:
        shutil.rmtree(output_dir, ignore_errors=True)
        raise
    except Exception as error:
        shutil.rmtree(output_dir, ignore_errors=True)
        raise ProcessorError("MALFORMED_PDF", "PDF parser rejected the input") from error


def write_downloaded_pdf(body: bytes, destination: Path, *, limits: ExtractionLimits | None = None) -> DownloadedPdf:
    """Store a bounded private-upload body using the same PDF admission checks."""
    limits = limits or ExtractionLimits()
    if len(body) > limits.max_pdf_bytes:
        raise DownloadError("PDF_TOO_LARGE", "source stream exceeds the limit")
    if len(body) == 0 or body[:5] != b"%PDF-":
        raise DownloadError("PDF_MAGIC_INVALID", "source does not begin with PDF magic")
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(body)
    return DownloadedPdf(destination, len(body), hashlib.sha256(body).hexdigest())


def _safe_fail(client: Any, grant: Any, error_code: str) -> None:
    """Report only a bounded code; never serialize exception details."""
    try:
        fail = getattr(client, "fail", None)
        if callable(fail):
            fail(grant, error_code)
        else:
            client.cancel(grant)
    except Exception as error:
        try:
            client.cancel(grant)
        except Exception:
            pass


def _safe_cancel(client: Any, grant: Any) -> None:
    try:
        client.cancel(grant)
    except Exception:
        pass


def _safe_log(event: str, grant: Any | None = None, *, stage: str = "", error_code: str = "") -> None:
    """Emit operational facts without payloads, headers, URLs, or tracebacks."""
    resource_id = getattr(grant, "resource_id", "-") if grant is not None else "-"
    attempt_id = getattr(grant, "attempt_id", "-") if grant is not None else "-"
    LOGGER.info(
        "paper_processor event=%s resource_id=%s attempt_id=%s stage=%s error_code=%s",
        event,
        resource_id,
        attempt_id,
        stage or "-",
        error_code or "-",
    )


def process_one(
    client: Any,
    work_root: Path,
    *,
    limits: ExtractionLimits | None = None,
    runtime_limits: ProcessorRuntimeLimits | None = None,
) -> bool:
    """Process one exact Edge grant with bounded time, memory, and lease renewal."""
    limits = limits or ExtractionLimits()
    runtime_limits = runtime_limits or ProcessorRuntimeLimits()
    grant = client.poll()
    if grant is None:
        return False

    deadline = ProcessingDeadline(runtime_limits)
    heartbeat = LeaseHeartbeat(client, grant, interval_seconds=runtime_limits.heartbeat_interval_seconds)
    heartbeat.start()
    _safe_log("grant", grant, stage="downloading")
    try:
        with _attempt_alarm(runtime_limits.attempt_timeout_seconds):
            deadline.start_stage("downloading")
            _runtime_checkpoint(deadline, heartbeat, "downloading")
            with processor_workspace(work_root) as workspace:
                metadata = client.input_metadata(grant)
                _runtime_checkpoint(deadline, heartbeat, "downloading")
                source = admit_source(
                    str(metadata.get("source_kind", "")),
                    str(metadata.get("source_ref", "")),
                    metadata.get("canonical_ref") if isinstance(metadata.get("canonical_ref"), str) else None,
                )
                source_path = workspace / "source.pdf"
                if source.url:
                    downloaded = download_pdf(
                        source,
                        source_path,
                        limits=limits,
                        deadline=deadline,
                        heartbeat=heartbeat,
                    )
                else:
                    body = client.input_source(grant, limits.max_pdf_bytes)
                    _runtime_checkpoint(deadline, heartbeat, "downloading")
                    _check_memory(limits, stage="downloading")
                    downloaded = write_downloaded_pdf(body, source_path, limits=limits)
                    del body
                del downloaded
                _runtime_checkpoint(deadline, heartbeat, "downloading")
                _check_memory(limits, stage="downloading")
                source_body = source_path.read_bytes()
                _check_memory(limits, stage="downloading")
                client.upload(grant, "source_pdf", source_body, "application/pdf")
                del source_body
                _runtime_checkpoint(deadline, heartbeat, "downloading")
                client.stage(grant, "extracting")
                _safe_log("stage", grant, stage="extracting")
                result = extract_pdf(
                    source_path,
                    workspace / "extracted",
                    limits=limits,
                    resource_id=grant.resource_id,
                    deadline=deadline,
                    heartbeat=heartbeat,
                )
                _runtime_checkpoint(deadline, heartbeat, "extracting")
                client.stage(grant, "uploading")
                _safe_log("stage", grant, stage="uploading")
                deadline.start_stage("uploading")
                _runtime_checkpoint(deadline, heartbeat, "uploading")
                _check_memory(limits, stage="uploading")
                text_pages_body = result.text_pages_jsonl()
                _check_memory(limits, stage="uploading")
                client.upload(grant, "text_pages", text_pages_body, "application/json", "pages")
                del text_pages_body
                _runtime_checkpoint(deadline, heartbeat, "uploading")
                for image in result.images:
                    _runtime_checkpoint(deadline, heartbeat, "uploading")
                    image_body = Path(str(image["local_path"])).read_bytes()
                    _check_memory(limits, stage="uploading")
                    client.upload(
                        grant,
                        "image",
                        image_body,
                        str(image["content_type"]),
                        str(image["image_id"]),
                    )
                    del image_body
                    _runtime_checkpoint(deadline, heartbeat, "uploading")
                _check_memory(limits, stage="uploading")
                image_manifest_body = result.image_manifest_json()
                _check_memory(limits, stage="uploading")
                client.upload(grant, "image_manifest", image_manifest_body, "application/json")
                del image_manifest_body
                _runtime_checkpoint(deadline, heartbeat, "uploading")
                _check_memory(limits, stage="uploading")
                text_manifest_body = json.dumps(result.manifest, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
                _check_memory(limits, stage="uploading")
                client.upload(
                    grant,
                    "text_manifest",
                    text_manifest_body,
                    "application/json",
                )
                del text_manifest_body
                _runtime_checkpoint(deadline, heartbeat, "uploading")
                _check_memory(limits, stage="uploading")
                client.finalize(grant, result.manifest)
                _safe_log("succeeded", grant, stage="ready")
                return True
    except ProcessorError as error:
        heartbeat.stop()
        _safe_fail(client, grant, error.code)
        _safe_log("failed", grant, stage="terminal", error_code=error.code)
        raise
    except MemoryError as error:
        heartbeat.stop()
        _safe_fail(client, grant, "PAPER_PROCESSOR_MEMORY_LIMIT")
        _safe_log("failed", grant, stage="terminal", error_code="PAPER_PROCESSOR_MEMORY_LIMIT")
        raise ProcessorError("PAPER_PROCESSOR_MEMORY_LIMIT", "paper processing memory budget exceeded") from error
    except Exception as error:
        heartbeat.stop()
        # A grant has already been leased.  An unexpected local/runtime error
        # must close that exact fenced attempt as a terminal failure, never as
        # cancellation: cancellation would make an infrastructure defect look
        # like user intent and can hide the operational error from a retry
        # decision.  The Edge validates the exact grant token and epoch.
        _safe_fail(client, grant, "PAPER_PROCESSOR_RUNTIME_ERROR")
        _safe_log("failed", grant, stage="terminal", error_code="PAPER_PROCESSOR_RUNTIME_ERROR")
        raise ProcessorError("PAPER_PROCESSOR_RUNTIME_ERROR", "paper processor encountered an unexpected runtime error") from error
    finally:
        heartbeat.stop()


@contextmanager
def processor_workspace(root: Path) -> Iterator[Path]:
    root.mkdir(parents=True, exist_ok=True)
    workspace = Path(tempfile.mkdtemp(prefix="paper-processor-", dir=root))
    try:
        yield workspace
    finally:
        shutil.rmtree(workspace, ignore_errors=True)


def recover_processor_workspaces(root: Path) -> int:
    recovered = 0
    if not root.exists():
        return recovered
    for path in root.iterdir():
        if path.name.startswith("paper-processor-") and path.is_dir():
            shutil.rmtree(path, ignore_errors=True)
            recovered += 1
    return recovered
