"""
Tests for Paper Reader Workflow components.
"""

import os
import json
import sqlite3
import tempfile
from pathlib import Path
from unittest.mock import Mock, patch, MagicMock

import pytest


class TestPapersDatabase:
    """Tests for PapersDatabase."""
    
    @pytest.fixture
    def temp_db(self):
        """Create a temporary database."""
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "test.db"
            from agent.papers_db import PapersDatabase, PaperRecord
            db = PapersDatabase(db_path=db_path)
            yield db, PaperRecord
    
    def test_init_creates_tables(self, temp_db):
        """Test database initialization creates required tables."""
        db, _ = temp_db
        
        with db._get_connection() as conn:
            cursor = conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='papers'"
            )
            assert cursor.fetchone() is not None
    
    def test_upsert_and_get_by_id(self, temp_db):
        """Test inserting and retrieving a paper record."""
        db, PaperRecord = temp_db
        
        record = PaperRecord(
            paper_id="test_123",
            source_url="https://arxiv.org/pdf/2103.03404.pdf",
            title="Test Paper",
            status="processing",
        )
        db.upsert(record)
        
        retrieved = db.get_by_id("test_123")
        assert retrieved is not None
        assert retrieved.paper_id == "test_123"
        assert retrieved.title == "Test Paper"
        assert retrieved.status == "processing"
    
    def test_get_by_url(self, temp_db):
        """Test retrieving paper by URL."""
        db, PaperRecord = temp_db
        
        url = "https://arxiv.org/pdf/2103.03404.pdf"
        record = PaperRecord(paper_id="test_url", source_url=url)
        db.upsert(record)
        
        retrieved = db.get_by_url(url)
        assert retrieved is not None
        assert retrieved.paper_id == "test_url"
    
    def test_update_status(self, temp_db):
        """Test updating paper status."""
        db, PaperRecord = temp_db
        
        record = PaperRecord(paper_id="test_status", status="pending")
        db.upsert(record)
        
        db.update_status("test_status", "completed")
        
        retrieved = db.get_by_id("test_status")
        assert retrieved.status == "completed"
    
    def test_save_report(self, temp_db):
        """Test saving report updates status to completed."""
        db, PaperRecord = temp_db
        
        record = PaperRecord(paper_id="test_report", status="processing")
        db.upsert(record)
        
        db.save_report("test_report", "# Test Report", "/path/to/report.pdf")
        
        retrieved = db.get_by_id("test_report")
        assert retrieved.status == "completed"
        assert retrieved.report_md == "# Test Report"
        assert retrieved.report_pdf_path == "/path/to/report.pdf"
    
    def test_get_completed(self, temp_db):
        """Test getting completed papers only."""
        db, PaperRecord = temp_db
        
        # Incomplete paper
        record1 = PaperRecord(paper_id="incomplete", status="processing")
        db.upsert(record1)
        
        # Complete paper
        record2 = PaperRecord(paper_id="complete", status="completed", report_md="# Report")
        db.upsert(record2)
        
        assert db.get_completed("incomplete") is None
        assert db.get_completed("complete") is not None


class TestPDFExtractor:
    """Tests for PDFExtractor."""
    
    @pytest.fixture
    def extractor(self):
        """Create extractor with temp directory."""
        with tempfile.TemporaryDirectory() as tmpdir:
            from agent.tools.pdf_extractor import PDFExtractor
            yield PDFExtractor(output_base_dir=Path(tmpdir))
    
    def test_generate_paper_id_arxiv(self, extractor):
        """Test paper ID generation from arXiv format."""
        assert extractor.generate_paper_id("/path/to/2103.03404.pdf") == "2103_03404"
        assert extractor.generate_paper_id("/path/to/2103.03404v1.pdf") == "2103_03404v1"
        assert extractor.generate_paper_id("https://arxiv.org/pdf/2103.03404.pdf") == "2103_03404"
    
    def test_generate_paper_id_fallback(self, extractor):
        """Test paper ID generation falls back to hash."""
        paper_id = extractor.generate_paper_id("/path/to/random_paper.pdf")
        assert len(paper_id) == 12  # MD5 hash prefix
    
    def test_get_images_dir_creates_directory(self, extractor):
        """Test images directory is created."""
        images_dir = extractor._get_images_dir("test_paper")
        assert images_dir.exists()
        assert images_dir.name == "images"


class TestPaperReaderWorkflow:
    """Tests for PaperReaderWorkflow."""
    
    @pytest.fixture
    def workflow(self):
        """Create workflow with temp directory and mocked AI."""
        with tempfile.TemporaryDirectory() as tmpdir:
            from agent.paperReaderWorkflow import PaperReaderWorkflow
            
            workflow = PaperReaderWorkflow(
                papers_dir=Path(tmpdir),
                api_key="test_key",
            )
            yield workflow
    
    def test_is_url(self, workflow):
        """Test URL detection."""
        assert workflow._is_url("https://arxiv.org/pdf/2103.03404.pdf") is True
        assert workflow._is_url("http://example.com/paper.pdf") is True
        assert workflow._is_url("/path/to/paper.pdf") is False
        assert workflow._is_url("paper.pdf") is False
    
    def test_extract_arxiv_id(self, workflow):
        """Test arXiv ID extraction."""
        assert workflow._extract_arxiv_id("https://arxiv.org/pdf/2103.03404.pdf") == "2103.03404"
        assert workflow._extract_arxiv_id("https://arxiv.org/abs/2103.03404v2") == "2103.03404v2"
        assert workflow._extract_arxiv_id("/path/to/2103.03404.pdf") == "2103.03404"
        assert workflow._extract_arxiv_id("/path/to/random.pdf") is None
    
    def test_generate_paper_id(self, workflow):
        """Test paper ID generation."""
        assert workflow._generate_paper_id("https://arxiv.org/pdf/2103.03404.pdf") == "2103_03404"
        # Non-arXiv should use hash
        paper_id = workflow._generate_paper_id("/path/to/custom.pdf")
        assert len(paper_id) == 16
    
    @patch('agent.paperReaderWorkflow.requests.get')
    def test_download_pdf(self, mock_get, workflow):
        """Test PDF download."""
        mock_response = Mock()
        mock_response.content = b"fake pdf content"
        mock_response.raise_for_status = Mock()
        mock_get.return_value = mock_response
        
        pdf_path = workflow._download_pdf(
            "https://arxiv.org/pdf/2103.03404.pdf",
            "2103_03404"
        )
        
        assert pdf_path.exists()
        assert pdf_path.name == "2103_03404.pdf"
        mock_get.assert_called_once()
    
    def test_generate_report(self, workflow):
        """Test report generation from analysis."""
        analysis = {
            "paper_info": {
                "title": "Test Paper",
                "data_type": "RNA-seq",
                "organism": "Human",
            },
            "pipeline_steps": [
                {
                    "step_number": 1,
                    "step_name": "Quality Control",
                    "description": "QC with FastQC",
                    "tools": ["FastQC"],
                    "input_data": "Raw FASTQ",
                    "output_data": "QC reports",
                    "commands_example": "fastqc *.fastq.gz",
                }
            ],
            "databases_used": ["NCBI", "Ensembl"],
        }
        
        from agent.tools.pdf_extractor import ExtractedContent
        extracted = ExtractedContent(
            text="sample text",
            pages=[],
            images_dir=Path("/tmp"),
            image_count=5,
            page_count=10,
        )
        
        report = workflow._generate_report("test_id", analysis, extracted)
        
        assert "# Test Paper" in report
        assert "Test Paper" in report
        assert "Quality Control" in report
        assert "FastQC" in report
        assert "fastqc *.fastq.gz" in report

    def test_read_paper_actions_from_cached_md(self):
        """read_paper should support command-line style actions on cached canonical MD."""
        with tempfile.TemporaryDirectory() as tmpdir:
            from agent.paperReaderWorkflow import PaperReaderWorkflow

            workflow = PaperReaderWorkflow(
                papers_dir=Path(tmpdir),
                api_key="test_key",
                session_id="s-test",
                storage_mode="sandboxed",
            )
            paper_ref = "https://arxiv.org/pdf/2103.03404.pdf"
            paper_id = "2103_03404"
            md_path = workflow.md_dir / f"{paper_id}.md"
            md_path.write_text(
                "\n".join(
                    [
                        "# Title",
                        "Intro line",
                        "## Method",
                        "Use FastQC pipeline",
                        "## Results",
                        "Accuracy improved",
                    ]
                ),
                encoding="utf-8",
            )
            workflow.db.register_authorized_refs([paper_ref])
            workflow.db.save_extracted_content(
                paper_id,
                "dummy text",
                str(workflow.extracted_dir / paper_id / "images"),
                canonical_md_path=str(md_path),
            )
            workflow.db.update_status(paper_id, "completed")

            head = json.loads(workflow.read_paper(paper_ref, action="head", max_lines=2))
            assert head["action"] == "head"
            assert "Title" in head["content"]

            tail = json.loads(workflow.read_paper(paper_ref, action="tail", max_lines=1))
            assert tail["content"] == "Accuracy improved"

            cat = json.loads(
                workflow.read_paper(paper_ref, action="cat", start_line=2, max_lines=3)
            )
            assert cat["start_line"] == 2
            assert cat["end_line"] == 4
            assert "Intro line" in cat["content"]
            assert "Use FastQC pipeline" in cat["content"]

            grep = json.loads(workflow.read_paper(paper_ref, action="grep", pattern="fastqc"))
            assert grep["match_count"] == 1
            assert "Use FastQC pipeline" in grep["matches"][0]["match"]

            outline = json.loads(workflow.read_paper(paper_ref, action="outline"))
            assert len(outline["headings"]) == 3
            assert outline["headings"][0]["heading"] == "# Title"

    def test_read_paper_rejects_unauthorized_ref_in_sandbox(self):
        """Sandbox mode should block reading papers not authorized by session registry."""
        with tempfile.TemporaryDirectory() as tmpdir:
            from agent.paperReaderWorkflow import PaperReaderWorkflow

            workflow = PaperReaderWorkflow(
                papers_dir=Path(tmpdir),
                api_key="test_key",
                session_id="s-test",
                storage_mode="sandboxed",
            )
            result = json.loads(
                workflow.read_paper("https://arxiv.org/pdf/9999.99999.pdf", action="head")
            )
            assert result["success"] is False
            assert result["error"] == "paper_not_authorized_for_session"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
