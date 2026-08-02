"""Unified, public-source literature search for PaperAgent.

Adapters are vendored from openags/paper-search-mcp under its MIT license.
Search returns small, normalized records; PDF extraction remains the separate
``read_paper`` workflow so retrieval does not consume the agent context.
"""

from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor, wait
from typing import Any, Iterable, Optional

from agno.tools import Toolkit

from agent.vendor.paper_search_mcp.academic_platforms.arxiv import ArxivSearcher
from agent.vendor.paper_search_mcp.academic_platforms.crossref import CrossRefSearcher
from agent.vendor.paper_search_mcp.academic_platforms.europepmc import EuropePMCSearcher
from agent.vendor.paper_search_mcp.academic_platforms.openalex import OpenAlexSearcher
from agent.vendor.paper_search_mcp.academic_platforms.pmc import PMCSearcher
from agent.vendor.paper_search_mcp.academic_platforms.pubmed import PubMedSearcher
from agent.vendor.paper_search_mcp.academic_platforms.semantic import SemanticSearcher
from agent.vendor.paper_search_mcp.paper import Paper


DEFAULT_SOURCES = ("pubmed", "europepmc", "arxiv")
SUPPORTED_SOURCES = (
    "pubmed",
    "europepmc",
    "arxiv",
    "semantic",
    "openalex",
    "pmc",
    "crossref",
)
DEFAULT_FIELDS = ("title", "authors", "published", "abstract", "doi", "pdf_url", "landing_url", "open_access")
ALLOWED_FIELDS = {"id", "source", *DEFAULT_FIELDS, "categories", "keywords", "citation_count"}


class LiteratureSearchTools(Toolkit):
    """Search public academic indexes with a stable Tool Calling schema."""

    def __init__(
        self,
        searchers: Optional[dict[str, Any]] = None,
        source_timeout_seconds: int = 8,
        **kwargs: Any,
    ):
        self.searchers = searchers or {
            "pubmed": PubMedSearcher(),
            "europepmc": EuropePMCSearcher(),
            "arxiv": ArxivSearcher(),
            "semantic": SemanticSearcher(),
            "openalex": OpenAlexSearcher(),
            "pmc": PMCSearcher(),
            "crossref": CrossRefSearcher(),
        }
        self.source_timeout_seconds = max(1, min(int(source_timeout_seconds), 15))
        super().__init__(name="literature_search_tools", tools=[self.search_literature], **kwargs)

    @staticmethod
    def _parse_sources(sources: str) -> list[str]:
        requested = [part.strip().lower() for part in str(sources or "").split(",") if part.strip()]
        if not requested:
            return list(DEFAULT_SOURCES)
        if requested == ["all"]:
            return list(SUPPORTED_SOURCES)
        return [source for source in requested if source in SUPPORTED_SOURCES]

    @staticmethod
    def _parse_fields(fields: Optional[list[str]]) -> list[str]:
        requested = [str(field).strip() for field in (fields or DEFAULT_FIELDS) if str(field).strip()]
        return [field for field in requested if field in ALLOWED_FIELDS]

    @staticmethod
    def _dedupe(papers: Iterable[Paper]) -> list[Paper]:
        result: list[Paper] = []
        seen: set[str] = set()
        for paper in papers:
            key = (paper.doi or "").lower() or f"{paper.source}:{paper.paper_id}" or paper.title.strip().lower()
            if key and key not in seen:
                seen.add(key)
                result.append(paper)
        return result

    @staticmethod
    def _serialize(paper: Paper, fields: list[str]) -> dict[str, Any]:
        value: dict[str, Any] = {
            "id": paper.paper_id,
            "source": paper.source,
            "title": paper.title,
        }
        source_values = {
            "authors": paper.authors,
            "published": paper.published_date.isoformat() if paper.published_date else None,
            "abstract": paper.abstract or None,
            "doi": paper.doi or None,
            "pdf_url": paper.pdf_url or None,
            "landing_url": paper.url or None,
            "open_access": bool(paper.pdf_url),
            "categories": paper.categories or [],
            "keywords": paper.keywords or [],
            "citation_count": paper.citations or 0,
        }
        for field in fields:
            if field in source_values:
                value[field] = source_values[field]
        return value

    def _search_source(
        self,
        source: str,
        query: str,
        limit: int,
        year: Optional[str],
        open_access_only: bool,
    ) -> list[Paper]:
        searcher = self.searchers[source]
        kwargs: dict[str, Any] = {"max_results": limit}
        if source == "semantic" and year:
            kwargs["year"] = year
        if source == "europepmc":
            kwargs["has_fulltext"] = open_access_only
            kwargs["open_access"] = open_access_only
        return searcher.search(query, **kwargs)

    def search_literature(
        self,
        query: str,
        sources: str = "pubmed,europepmc,arxiv",
        fields: Optional[list[str]] = None,
        limit: int = 5,
        year: Optional[str] = None,
        open_access_only: bool = False,
    ) -> str:
        """Search public literature sources and return only requested metadata fields.

        Args:
            query: Literature query. PubMed supports its official query syntax.
            sources: Comma-separated sources: pubmed, europepmc, arxiv, semantic,
                openalex, pmc, crossref; use ``all`` for every supported source.
            fields: Optional fields to return: title, authors, published, abstract,
                doi, pdf_url, landing_url, open_access, categories, keywords, citation_count.
            limit: Maximum records fetched per source, from 1 to 20.
            year: Optional year or year-range where the source supports it.
            open_access_only: Restrict Europe PMC to open-access/full-text records;
                other sources still report whether a direct PDF URL is known.
        """
        query = str(query or "").strip()
        if not query:
            return json.dumps({"error": "query cannot be empty"})
        selected = self._parse_sources(sources)
        if not selected:
            return json.dumps({"error": "no supported sources selected", "supported_sources": SUPPORTED_SOURCES})
        selected_fields = self._parse_fields(fields)
        if not selected_fields:
            return json.dumps({"error": "no supported fields selected", "supported_fields": sorted(ALLOWED_FIELDS)})
        try:
            limit = max(1, min(int(limit), 20))
        except (TypeError, ValueError):
            return json.dumps({"error": "limit must be an integer between 1 and 20"})

        papers: list[Paper] = []
        errors: dict[str, str] = {}
        counts: dict[str, int] = {}
        executor = ThreadPoolExecutor(max_workers=len(selected))
        futures = {
                executor.submit(self._search_source, source, query, limit, year, open_access_only): source
                for source in selected
            }
        done, pending = wait(futures, timeout=self.source_timeout_seconds)
        for future in done:
            source = futures[future]
            try:
                found = future.result()
                counts[source] = len(found)
                papers.extend(found)
            except Exception as exc:
                counts[source] = 0
                errors[source] = str(exc)
        for future in pending:
            source = futures[future]
            future.cancel()
            counts[source] = 0
            errors[source] = f"timed out after {self.source_timeout_seconds}s"
        # Do not hold a user-facing tool call open for a slow third-party API.
        # Running requests are allowed to finish in the background and discarded.
        executor.shutdown(wait=False, cancel_futures=True)

        records = [self._serialize(paper, selected_fields) for paper in self._dedupe(papers)]
        return json.dumps(
            {
                "query": query,
                "sources_used": selected,
                "source_results": counts,
                "errors": errors,
                "partial": bool(errors),
                "fields": selected_fields,
                "papers": records[: limit * len(selected)],
            },
            ensure_ascii=False,
            indent=2,
        )
