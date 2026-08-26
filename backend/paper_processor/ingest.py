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
import re
import shutil
import socket
import tempfile
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterator, Protocol
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin, urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener

import fitz
from pypdf import PdfReader


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


@dataclass(frozen=True)
class DownloadedPdf:
    path: Path
    size_bytes: int
    sha256: str


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
            return DownloadedPdf(destination, total, digest.hexdigest())
    except DownloadError:
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


def extract_pdf(pdf_path: Path, output_dir: Path, *, limits: ExtractionLimits | None = None, resource_id: str = "fixture-resource") -> ExtractionResult:
    limits = limits or ExtractionLimits()
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
        try:
            reader = PdfReader(str(pdf_path), strict=True)
            if reader.is_encrypted:
                raise ProcessorError("ENCRYPTED_PDF_UNSUPPORTED", "encrypted PDFs are not admitted")
            page_count = len(reader.pages)
        except ProcessorError:
            raise
        except Exception as error:
            raise ProcessorError("MALFORMED_PDF", "PDF parser rejected the input") from error
        if page_count > limits.max_pages:
            raise ProcessorError("PAGE_COUNT_LIMIT", "PDF page count exceeds the limit")

        pages: list[dict[str, Any]] = []
        for page_number, page in enumerate(reader.pages, start=1):
            try:
                text = page.extract_text() or ""
            except Exception as error:
                raise ProcessorError("TEXT_EXTRACTION_FAILED", "PDF text extraction failed") from error
            pages.append({"page": page_number, "text": text, "text_bytes": len(text.encode("utf-8")), "images": []})

        images: list[dict[str, Any]] = []
        total_image_bytes = 0
        document = fitz.open(str(pdf_path))
        try:
            if document.page_count != page_count:
                raise ProcessorError("PDF_PAGE_COUNT_MISMATCH", "PDF parsers disagreed on page count")
            for page_index in range(document.page_count):
                page = document.load_page(page_index)
                for image_index, image in enumerate(page.get_images(full=True), start=1):
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
                    except ProcessorError:
                        raise
                    except Exception as error:
                        raise ProcessorError("IMAGE_EXTRACTION_FAILED", "embedded image extraction failed") from error
        finally:
            document.close()

        has_text = any(bool(page["text"].strip()) for page in pages)
        warnings = [] if has_text else ["no_text_layer"]
        manifest_images = [{key: value for key, value in image.items() if key != "local_path"} for image in images]
        manifest_pages = [{"page": page["page"], "text_bytes": page["text_bytes"], "images": page["images"]} for page in pages]
        manifest = {"resource_id": resource_id, "parser_version": "paper-processor-pdf-1", "source_size_bytes": source_size, "source_sha256": source_sha256, "page_count": page_count, "image_count": len(images), "pages": manifest_pages, "images": manifest_images, "warnings": warnings}
        return ExtractionResult(pages, images, manifest, has_text, source_size, source_sha256)
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


def process_one(client: Any, work_root: Path, *, limits: ExtractionLimits | None = None) -> bool:
    """Process one exact Edge grant and clean its workspace in every outcome."""
    limits = limits or ExtractionLimits()
    grant = client.poll()
    if grant is None:
        return False
    try:
        with processor_workspace(work_root) as workspace:
            metadata = client.input_metadata(grant)
            source = admit_source(str(metadata.get("source_kind", "")), str(metadata.get("source_ref", "")), metadata.get("canonical_ref") if isinstance(metadata.get("canonical_ref"), str) else None)
            source_path = workspace / "source.pdf"
            if source.url:
                downloaded = download_pdf(source, source_path, limits=limits)
            else:
                body = client.input_source(grant, limits.max_pdf_bytes)
                downloaded = write_downloaded_pdf(body, source_path, limits=limits)
            client.upload(grant, "source_pdf", source_path.read_bytes(), "application/pdf")
            client.stage(grant, "extracting")
            result = extract_pdf(source_path, workspace / "extracted", limits=limits, resource_id=grant.resource_id)
            client.stage(grant, "uploading")
            client.upload(grant, "text_pages", result.text_pages_jsonl(), "application/json", "pages")
            for image in result.images:
                client.upload(grant, "image", Path(str(image["local_path"])).read_bytes(), str(image["content_type"]), str(image["image_id"]))
            client.upload(grant, "image_manifest", result.image_manifest_json(), "application/json")
            client.upload(grant, "text_manifest", json.dumps(result.manifest, ensure_ascii=False, separators=(",", ":")).encode("utf-8"), "application/json")
            client.finalize(grant, result.manifest)
            return True
    except ProcessorError as error:
        # The Edge keeps the attempt/resource terminal and prevents a partial
        # manifest from being published. Only the bounded machine code is sent
        # to the Edge; parser details never become a public error payload.
        try:
            fail = getattr(client, "fail", None)
            if callable(fail):
                fail(grant, error.code)
            else:
                client.cancel(grant)
        except Exception:
            try:
                client.cancel(grant)
            except Exception:
                pass
        raise
    except Exception:
        # A transport or unexpected local failure must not leave a partially
        # staged attempt looking successful. Lease expiry remains the recovery
        # path if the cancellation request cannot be delivered.
        try:
            client.cancel(grant)
        except Exception:
            pass
        raise


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
