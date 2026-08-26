"""PAPER-07 deterministic PDF admission and extraction tests.

The fixtures are generated as real PDFs with PyMuPDF in a temporary directory;
no mutable public web page or production credential is used.
"""

from __future__ import annotations

import io
import shutil
from pathlib import Path
from typing import Any

import fitz
import pytest
from pypdf import PdfReader, PdfWriter

from backend.paper_processor.ingest import (
    AdmissionError,
    DownloadError,
    ExtractionLimits,
    ProcessorError,
    admit_source,
    download_pdf,
    extract_pdf,
    process_one,
    processor_workspace,
    recover_processor_workspaces,
)
from backend.paper_processor.client import ProcessorGrant


class FakeResponse:
    def __init__(self, body: bytes, *, content_type: str = "application/pdf", status: int = 200, location: str | None = None, chunk_size: int = 32):
        self._stream = io.BytesIO(body)
        self.headers = {"Content-Type": content_type, "Content-Length": str(len(body))}
        if location:
            self.headers["Location"] = location
        self.status = status
        self.chunk_size = chunk_size

    def read(self, size: int = -1) -> bytes:
        return self._stream.read(self.chunk_size if size < 0 else min(size, self.chunk_size))

    def close(self) -> None:
        self._stream.close()

    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, *_args: Any) -> None:
        self.close()


class FakeOpener:
    def __init__(self, responses: dict[str, FakeResponse]):
        self.responses = responses
        self.seen: list[str] = []

    def open(self, request: Any, timeout: int = 0) -> FakeResponse:
        url = request.full_url
        self.seen.append(url)
        response = self.responses.get(url)
        if response is None:
            raise AssertionError(f"unexpected URL: {url}")
        return response


def make_pdf(path: Path, *, image_only: bool = False, pages: int = 2) -> Path:
    document = fitz.open()
    for page_number in range(pages):
        page = document.new_page(width=320, height=220)
        if not image_only:
            page.insert_text((30, 60), f"Page {page_number + 1} durable paper text")
        pixmap = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 120, 80), False)
        pixmap.clear_with((page_number + 1) * 0x202020)
        page.insert_image(fitz.Rect(40, 90, 160, 170), pixmap=pixmap)
        pixmap = None
    document.save(path)
    document.close()
    return path


def resolver(host: str) -> list[str]:
    return ["93.184.216.34"] if host in {"arxiv.org", "www.ncbi.nlm.nih.gov", "pmc.ncbi.nlm.nih.gov"} else ["127.0.0.1"]


def test_source_admission_maps_only_known_arxiv_and_pmc_references() -> None:
    arxiv = admit_source("arxiv", "2401.00001v2")
    assert arxiv.url == "https://arxiv.org/pdf/2401.00001v2.pdf"
    pmc = admit_source("pubmed_pmc", "PMC1234567")
    assert pmc.url == "https://www.ncbi.nlm.nih.gov/pmc/articles/PMC1234567/pdf"
    with pytest.raises(AdmissionError, match="SOURCE_NOT_ALLOWED"):
        admit_source("approved_url", "https://example.com/paper.pdf")
    with pytest.raises(AdmissionError, match="SOURCE_REFERENCE_INVALID"):
        admit_source("arxiv", "https://evil.example/2401.00001.pdf")


def test_stream_download_checks_magic_hash_size_and_redirect_private_ip(tmp_path: Path) -> None:
    pdf = b"%PDF-1.7\nreal fixture\n"
    destination = tmp_path / "source.pdf"
    source = admit_source("arxiv", "2401.00001")
    opener = FakeOpener({source.url: FakeResponse(pdf)})
    downloaded = download_pdf(source, destination, opener=opener, resolve_host=resolver, limits=ExtractionLimits(max_pdf_bytes=1024))
    assert downloaded.size_bytes == len(pdf)
    assert downloaded.sha256
    assert destination.read_bytes() == pdf

    with pytest.raises(DownloadError, match="PDF_MAGIC_INVALID"):
        download_pdf(source, tmp_path / "html.pdf", opener=FakeOpener({source.url: FakeResponse(b"<html>not pdf</html>", content_type="text/html")}), resolve_host=resolver, limits=ExtractionLimits(max_pdf_bytes=1024))
    with pytest.raises(DownloadError, match="PDF_TOO_LARGE"):
        download_pdf(source, tmp_path / "large.pdf", opener=FakeOpener({source.url: FakeResponse(b"%PDF-" + b"x" * 20)}), resolve_host=resolver, limits=ExtractionLimits(max_pdf_bytes=16))

    redirect = "https://private.example/paper.pdf"
    with pytest.raises(DownloadError, match="REDIRECT_PRIVATE_ADDRESS"):
        download_pdf(source, tmp_path / "redirect.pdf", opener=FakeOpener({source.url: FakeResponse(b"", status=302, location=redirect)}), resolve_host=lambda host: ["93.184.216.34"] if host == "arxiv.org" else ["127.0.0.1"], limits=ExtractionLimits(max_pdf_bytes=1024))


def test_real_text_pdf_extracts_pages_images_and_manifest_without_local_paths(tmp_path: Path) -> None:
    pdf_path = make_pdf(tmp_path / "text-paper.pdf")
    result = extract_pdf(pdf_path, tmp_path / "out", limits=ExtractionLimits(max_pages=5, max_images=8, max_image_bytes=2_000_000))
    assert result.manifest["page_count"] == 2
    assert result.manifest["image_count"] >= 1
    assert "Page 1 durable paper text" in result.pages[0]["text"]
    assert result.pages[0]["images"]
    assert all("local_path" not in image and "object_key" not in image for image in result.manifest["images"])
    assert all(Path(image["local_path"]).exists() for image in result.images)


def test_image_only_pdf_is_not_ready_without_text_and_records_warning(tmp_path: Path) -> None:
    pdf_path = make_pdf(tmp_path / "image-only.pdf", image_only=True, pages=1)
    result = extract_pdf(pdf_path, tmp_path / "out", limits=ExtractionLimits(max_pages=5, max_images=4))
    assert result.manifest["page_count"] == 1
    assert result.manifest["warnings"] == ["no_text_layer"]
    assert result.has_text is False


def test_malformed_encrypted_page_and_image_limits_fail_closed(tmp_path: Path) -> None:
    malformed = tmp_path / "malformed.pdf"
    malformed.write_bytes(b"%PDF-1.7\ntruncated")
    with pytest.raises(ProcessorError, match="MALFORMED_PDF"):
        extract_pdf(malformed, tmp_path / "malformed-out")

    plain = make_pdf(tmp_path / "encrypted-source.pdf", pages=1)
    reader = PdfReader(str(plain))
    writer = PdfWriter()
    for page in reader.pages:
        writer.add_page(page)
    writer.encrypt("fixture-password")
    encrypted = tmp_path / "encrypted.pdf"
    with encrypted.open("wb") as handle:
        writer.write(handle)
    with pytest.raises(ProcessorError, match="ENCRYPTED_PDF_UNSUPPORTED"):
        extract_pdf(encrypted, tmp_path / "encrypted-out")

    with pytest.raises(ProcessorError, match="IMAGE_COUNT_LIMIT"):
        extract_pdf(plain, tmp_path / "limited-out", limits=ExtractionLimits(max_images=0))


def test_processor_workspace_cleans_on_success_failure_and_restart(tmp_path: Path) -> None:
    with processor_workspace(tmp_path) as workspace:
        assert workspace.exists()
    assert not workspace.exists()
    stale = tmp_path / "paper-processor-stale"
    stale.mkdir()
    (stale / "source.pdf").write_bytes(b"fixture")
    assert recover_processor_workspaces(tmp_path) == 1
    assert not stale.exists()
    with pytest.raises(RuntimeError):
        with processor_workspace(tmp_path) as workspace:
            raise RuntimeError("simulated parser failure")
    assert not any(path.is_dir() and path.name.startswith("paper-processor-") for path in tmp_path.iterdir())


class FakeProcessorClient:
    def __init__(self, body: bytes):
        self.body = body
        self.grant = ProcessorGrant("resource-1", "attempt-1", "lease-1", 1, 9_999_999_999, "user_upload", "upload-1", None)
        self.uploads: list[tuple[str, str | None, bytes]] = []
        self.stages: list[str] = []
        self.finalized = False
        self.cancelled = False

    def poll(self) -> ProcessorGrant:
        return self.grant

    def input_metadata(self, _grant: ProcessorGrant) -> dict[str, str]:
        return {"resource_id": "resource-1", "source_kind": "user_upload", "source_ref": "upload-1"}

    def input_source(self, _grant: ProcessorGrant, _maximum_bytes: int) -> bytes:
        return self.body

    def upload(self, _grant: ProcessorGrant, kind: str, body: bytes, _content_type: str, object_id: str | None = None) -> dict[str, Any]:
        self.uploads.append((kind, object_id, body))
        return {"status": "uploaded"}

    def stage(self, _grant: ProcessorGrant, stage: str) -> dict[str, Any]:
        self.stages.append(stage)
        return {"status": stage}

    def finalize(self, _grant: ProcessorGrant, _manifest: dict[str, Any]) -> dict[str, Any]:
        self.finalized = True
        return {"status": "ready"}

    def cancel(self, _grant: ProcessorGrant) -> dict[str, Any]:
        self.cancelled = True
        return {"status": "cancelled"}


def test_process_one_uploads_source_pages_images_manifests_and_cleans(tmp_path: Path) -> None:
    fixture = make_pdf(tmp_path / "upload.pdf", pages=2)
    client = FakeProcessorClient(fixture.read_bytes())
    assert process_one(client, tmp_path / "processor-work", limits=ExtractionLimits(max_pages=5, max_images=8)) is True
    assert [kind for kind, _object_id, _body in client.uploads] == ["source_pdf", "text_pages", "image", "image", "image_manifest", "text_manifest"]
    assert [object_id for kind, object_id, _body in client.uploads if kind == "image"] == ["page-0001-image-0001", "page-0002-image-0001"]
    assert client.stages == ["extracting", "uploading"]
    assert client.finalized is True
    assert client.cancelled is False
    assert not any(path.is_dir() and path.name.startswith("paper-processor-") for path in (tmp_path / "processor-work").iterdir())


def test_process_one_cancels_malformed_input_and_never_finalizes(tmp_path: Path) -> None:
    client = FakeProcessorClient(b"%PDF-1.7\ntruncated")
    with pytest.raises(ProcessorError, match="MALFORMED_PDF"):
        process_one(client, tmp_path / "processor-work")
    assert client.cancelled is True
    assert client.finalized is False
