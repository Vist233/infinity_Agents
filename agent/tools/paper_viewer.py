"""
Paper Viewer Tools - View paper content by page number or regex pattern.

Supports cached PDF downloads and forced regex search mode for testing.
"""

import json
import re
from pathlib import Path
from typing import Any, Dict, List, Optional

from agno.tools import Toolkit
from agno.utils.log import log_debug, logger

try:
    from pypdf import PdfReader
except ImportError:
    raise ImportError("`pypdf` not installed. Please install using `pip install pypdf`")


DOWNLOAD_DIR = Path(__file__).parent / "arxiv_pdfs"


class RegexForceMiddleware:
    """Middleware that forces regex search mode for testing effectiveness."""

    def __init__(self, force_regex: bool = False):
        self.force_regex = force_regex

    def should_use_regex(self, regex_pattern: Optional[str]) -> bool:
        """Determine if regex should be used."""
        if self.force_regex:
            log_debug("Regex search forced by middleware")
            return True
        return regex_pattern is not None


class PaperViewerTools(Toolkit):
    """Tools for viewing paper content with page-based or regex-based access."""

    def __init__(
        self,
        download_dir: Optional[Path] = None,
        regex_middleware: Optional[RegexForceMiddleware] = None,
        **kwargs,
    ):
        self.download_dir = download_dir or DOWNLOAD_DIR
        self.regex_middleware = regex_middleware or RegexForceMiddleware()
        self._pdf_cache: Dict[str, PdfReader] = {}

        tools: List[Any] = [
            self.view_paper_page,
            self.search_paper_text,
            self.get_paper_outline,
        ]

        super().__init__(name="paper_viewer_tools", tools=tools, **kwargs)

    def _get_pdf_reader(self, paper_id: str) -> Optional[PdfReader]:
        """Get or load PDF reader for a paper."""
        if paper_id in self._pdf_cache:
            return self._pdf_cache[paper_id]

        # Look for downloaded PDF
        pdf_files = list(self.download_dir.glob(f"*{paper_id}*.pdf"))
        if not pdf_files:
            return None

        try:
            reader = PdfReader(pdf_files[0])
            self._pdf_cache[paper_id] = reader
            return reader
        except Exception as e:
            logger.error(f"Failed to load PDF for {paper_id}: {e}")
            return None

    def view_paper_page(self, paper_id: str, page_number: int) -> str:
        """View a specific page from a downloaded paper.

        Args:
            paper_id (str): The paper ID (e.g., '2103.03404v1'). Paper must be downloaded first.
            page_number (int): The page number to view (1-indexed).

        Returns:
            str: JSON with page content or error message.
        """
        reader = self._get_pdf_reader(paper_id)
        if not reader:
            return json.dumps({
                "error": f"Paper {paper_id} not found. Use read_paper_content to download first."
            })

        total_pages = len(reader.pages)
        if page_number < 1 or page_number > total_pages:
            return json.dumps({
                "error": f"Invalid page number. Paper has {total_pages} pages.",
                "total_pages": total_pages,
            })

        try:
            page = reader.pages[page_number - 1]
            text = page.extract_text() or ""

            return json.dumps({
                "paper_id": paper_id,
                "page": page_number,
                "total_pages": total_pages,
                "text": text,
            }, indent=2)
        except Exception as e:
            return json.dumps({"error": str(e)})

    def search_paper_text(
        self,
        paper_id: str,
        pattern: str,
        case_sensitive: bool = False,
        context_chars: int = 100,
    ) -> str:
        """Search for a pattern in the paper text using regex.

        Args:
            paper_id (str): The paper ID. Paper must be downloaded first.
            pattern (str): Regex pattern to search for.
            case_sensitive (bool, optional): Whether search is case-sensitive. Defaults to False.
            context_chars (int, optional): Characters of context around matches. Defaults to 100.

        Returns:
            str: JSON with matches including page numbers and surrounding context.
        """
        reader = self._get_pdf_reader(paper_id)
        if not reader:
            return json.dumps({
                "error": f"Paper {paper_id} not found. Use read_paper_content to download first."
            })

        flags = 0 if case_sensitive else re.IGNORECASE
        matches = []

        try:
            for page_num, page in enumerate(reader.pages, start=1):
                text = page.extract_text() or ""

                # Find all matches with context
                for match in re.finditer(pattern, text, flags):
                    start = max(0, match.start() - context_chars)
                    end = min(len(text), match.end() + context_chars)
                    context = text[start:end]

                    matches.append({
                        "page": page_num,
                        "match": match.group(),
                        "context": f"...{context}..." if start > 0 or end < len(text) else context,
                        "position": match.start(),
                    })

                # Limit matches per paper
                if len(matches) >= 50:
                    break

            return json.dumps({
                "paper_id": paper_id,
                "pattern": pattern,
                "total_matches": len(matches),
                "matches": matches,
            }, indent=2)

        except re.error as e:
            return json.dumps({"error": f"Invalid regex pattern: {e}"})
        except Exception as e:
            return json.dumps({"error": str(e)})

    def get_paper_outline(self, paper_id: str) -> str:
        """Get the outline/structure of a paper (page count, sections if detectable).

        Args:
            paper_id (str): The paper ID.

        Returns:
            str: JSON with paper structure information.
        """
        reader = self._get_pdf_reader(paper_id)
        if not reader:
            return json.dumps({
                "error": f"Paper {paper_id} not found."
            })

        try:
            # Extract basic info
            total_pages = len(reader.pages)
            metadata = reader.metadata or {}

            # Try to detect sections from first few pages
            sections = []
            section_patterns = [
                r"^\s*(\d+\.?\s+)?(Introduction|Abstract|Methods?|Results?|Discussion|Conclusion|References)",
                r"^\s*(\d+\.?\s+)?[A-Z][A-Z\s]+$",  # All caps headers
            ]

            for page_num in range(min(5, total_pages)):
                text = reader.pages[page_num].extract_text() or ""
                for pattern in section_patterns:
                    for match in re.finditer(pattern, text, re.MULTILINE | re.IGNORECASE):
                        sections.append({
                            "page": page_num + 1,
                            "heading": match.group().strip()[:50],
                        })

            return json.dumps({
                "paper_id": paper_id,
                "total_pages": total_pages,
                "title": metadata.get("/Title", "Unknown"),
                "author": metadata.get("/Author", "Unknown"),
                "detected_sections": sections[:20],  # Limit sections
            }, indent=2)

        except Exception as e:
            return json.dumps({"error": str(e)})
