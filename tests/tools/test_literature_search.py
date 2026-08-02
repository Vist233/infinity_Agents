import json
import time
from datetime import datetime

from agent.tools.literature_search import LiteratureSearchTools
from agent.vendor.paper_search_mcp.paper import Paper


def _paper(source: str, paper_id: str, doi: str = "") -> Paper:
    return Paper(
        paper_id=paper_id,
        title=f"{source} title",
        authors=["Ada Lovelace"],
        abstract="A short abstract.",
        doi=doi,
        published_date=datetime(2026, 1, 1),
        pdf_url="https://example.test/paper.pdf",
        url="https://example.test/paper",
        source=source,
        categories=["biology"],
        keywords=["Brassica"],
        citations=7,
    )


class _Searcher:
    def __init__(self, papers):
        self.papers = papers

    def search(self, _query, **_kwargs):
        return self.papers


class _SlowSearcher:
    def search(self, _query, **_kwargs):
        time.sleep(0.2)
        return [_paper("arxiv", "slow")]


def test_search_literature_selects_fields_and_deduplicates():
    tools = LiteratureSearchTools(
        searchers={
            "pubmed": _Searcher([_paper("pubmed", "1", "10.1/example")]),
            "europepmc": _Searcher([_paper("europepmc", "2", "10.1/example")]),
            "arxiv": _Searcher([_paper("arxiv", "3")]),
        }
    )

    result = json.loads(
        tools.search_literature(
            "Brassica resistance",
            fields=["abstract", "pdf_url"],
            limit=2,
        )
    )

    assert result["partial"] is False
    assert len(result["papers"]) == 2
    assert result["papers"][0].keys() == {"id", "source", "title", "abstract", "pdf_url"}
    assert result["papers"][0]["abstract"] == "A short abstract."


def test_search_literature_returns_partial_results_after_timeout():
    tools = LiteratureSearchTools(
        searchers={
            "pubmed": _Searcher([_paper("pubmed", "1")]),
            "europepmc": _Searcher([]),
            "arxiv": _SlowSearcher(),
        },
        source_timeout_seconds=1,
    )
    tools.source_timeout_seconds = 0.01

    result = json.loads(tools.search_literature("Brassica resistance"))

    assert result["partial"] is True
    assert result["errors"]["arxiv"] == "timed out after 0.01s"
    assert result["papers"][0]["source"] == "pubmed"
