"""Tests for Paper Reader Workflow components (PG repo compatible)."""

import json
import tempfile
from dataclasses import dataclass
from pathlib import Path
from unittest.mock import Mock, patch

import pytest


@dataclass
class _FakeRecord:
    paper_id: str
    source_url: str | None = None
    local_path: str | None = None
    title: str | None = None
    status: str = "pending"
    report_md: str | None = None
    report_pdf_path: str | None = None
    canonical_md_path: str | None = None


class FakePapersRepo:
    def __init__(self):
        self.records = {}
        self.authorized = set()
        self.links = set()

    def get_by_id(self, paper_id):
        return self.records.get(paper_id)

    def get_by_url(self, url):
        for r in self.records.values():
            if r.source_url == url:
                return r
        return None

    def upsert(self, record):
        self.records[record.paper_id] = _FakeRecord(
            paper_id=record.paper_id,
            source_url=record.source_url,
            local_path=record.local_path,
            title=record.title,
            status=record.status,
            report_md=record.report_md,
            report_pdf_path=record.report_pdf_path,
            canonical_md_path=record.canonical_md_path,
        )

    def update_status(self, paper_id, status):
        if paper_id in self.records:
            self.records[paper_id].status = status

    def save_extracted_content(self, paper_id, text, images_dir, canonical_md_path=None):
        if paper_id in self.records:
            self.records[paper_id].canonical_md_path = canonical_md_path

    def register_authorized_refs(self, refs, source="search_paper"):
        for r in refs:
            if isinstance(r, str) and r.strip():
                self.authorized.add(r.strip())

    def link_paper_to_session(self, session_id, paper_id, source_ref=None):
        if session_id and paper_id:
            self.links.add((session_id, paper_id))

    def is_paper_linked_to_session(self, session_id, paper_id):
        return (session_id, paper_id) in self.links

    def is_authorized_ref(self, ref, paper_id=None):
        return ref in self.authorized

    def get_completed(self, paper_id):
        record = self.records.get(paper_id)
        if record and record.status == "completed" and record.report_md:
            return record
        return None

    def save_report(self, paper_id, report_md, report_pdf_path=None):
        if paper_id in self.records:
            self.records[paper_id].report_md = report_md
            self.records[paper_id].report_pdf_path = report_pdf_path
            self.records[paper_id].status = "completed"


class TestPDFExtractor:
    @pytest.fixture
    def extractor(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            from agent.tools.pdf_extractor import PDFExtractor
            yield PDFExtractor(output_base_dir=Path(tmpdir))

    def test_generate_paper_id_arxiv(self, extractor):
        assert extractor.generate_paper_id("/path/to/2103.03404.pdf") == "2103_03404"
        assert extractor.generate_paper_id("/path/to/2103.03404v1.pdf") == "2103_03404v1"
        assert extractor.generate_paper_id("https://arxiv.org/pdf/2103.03404.pdf") == "2103_03404"


class TestPaperReaderWorkflow:
    @pytest.fixture
    def workflow(self, monkeypatch):
        # These tests exercise filesystem/session behavior only.  Keep the
        # provider profile on a local, syntactically valid URL so offline CI
        # does not need DNS or a live model endpoint during construction.
        monkeypatch.setenv("APP_ENV", "test")
        monkeypatch.setenv("ANALYSIS_PROVIDER_BASE_URL", "http://127.0.0.1:1/v1")
        with tempfile.TemporaryDirectory() as tmpdir:
            from agent.paperReaderWorkflow import PaperReaderWorkflow
            workflow = PaperReaderWorkflow(
                papers_dir=Path(tmpdir),
                api_key="test_key",
                db=FakePapersRepo(),
                session_id="00000000-0000-0000-0000-000000000001",
                storage_mode="sandboxed",
            )
            yield workflow

    def test_is_url(self, workflow):
        assert workflow._is_url("https://arxiv.org/pdf/2103.03404.pdf") is True
        assert workflow._is_url("/path/to/paper.pdf") is False

    def test_extract_arxiv_id(self, workflow):
        assert workflow._extract_arxiv_id("https://arxiv.org/pdf/2103.03404.pdf") == "2103.03404"
        assert workflow._extract_arxiv_id("/path/to/random.pdf") is None

    @patch("agent.paperReaderWorkflow.requests.get")
    def test_download_pdf(self, mock_get, workflow):
        mock_response = Mock()
        mock_response.content = b"fake pdf content"
        mock_response.raise_for_status = Mock()
        mock_get.return_value = mock_response

        pdf_path = workflow._download_pdf("https://arxiv.org/pdf/2103.03404.pdf", "2103_03404")
        assert pdf_path.exists()

    def test_read_paper_actions_from_cached_md(self, workflow):
        paper_ref = "https://arxiv.org/pdf/2103.03404.pdf"
        paper_id = "2103_03404"
        md_path = workflow.md_dir / f"{paper_id}.md"
        md_path.parent.mkdir(parents=True, exist_ok=True)
        md_path.write_text("# Title\nIntro line\n## Method\nUse FastQC pipeline\n", encoding="utf-8")

        workflow.db.register_authorized_refs([paper_ref])
        workflow.db.records[paper_id] = _FakeRecord(
            paper_id=paper_id,
            status="completed",
            canonical_md_path=str(md_path),
        )

        head = json.loads(workflow.read_paper(paper_ref, action="head", max_lines=2))
        assert head["action"] == "head"
        assert "Title" in head["content"]

        grep = json.loads(workflow.read_paper(paper_ref, action="grep", pattern="fastqc"))
        assert grep["match_count"] == 1

    def test_read_paper_rejects_unauthorized_ref_in_sandbox(self, workflow):
        result = json.loads(workflow.read_paper("https://arxiv.org/pdf/9999.99999.pdf", action="head"))
        assert result["success"] is False
        assert result["error"] == "paper_not_authorized_for_session"

    def test_analyze_paper_rejects_outside_session_local_file(self, workflow, tmp_path):
        outside_pdf = tmp_path / "outside.pdf"
        outside_pdf.write_bytes(b"%PDF-1.4\n%fake\n")
        workflow.db.register_authorized_refs([str(outside_pdf)])

        result = json.loads(workflow.analyze_paper(str(outside_pdf)))
        assert result["success"] is False
        assert result["error"] == "paper_not_authorized_for_session"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
