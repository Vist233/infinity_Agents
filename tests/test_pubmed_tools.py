import types
from pathlib import Path

import Bio

from agent.tools.pubmed_search import PubMedSearchTools, search_pubmed


class _Handle:
    def __init__(self, payload):
        self.payload = payload

    def close(self):
        return None


def _build_fake_entrez(record_sequence):
    queue = list(record_sequence)

    def _read(_handle):
        if not queue:
            raise AssertionError("Unexpected Entrez.read() call")
        return queue.pop(0)

    return types.SimpleNamespace(
        email="",
        esearch=lambda **kwargs: _Handle(kwargs),
        efetch=lambda **kwargs: _Handle(kwargs),
        elink=lambda **kwargs: _Handle(kwargs),
        read=_read,
    )


def test_pubmed_search_tools_returns_structured_results(monkeypatch, tmp_path: Path):
    fake_records = [
        {"IdList": ["11111111", "22222222"]},
        {
            "PubmedArticle": [
                {
                    "MedlineCitation": {
                        "PMID": "11111111",
                        "Article": {
                            "ArticleTitle": "Paper A",
                            "Abstract": {"AbstractText": ["Abstract A"]},
                            "AuthorList": [{"ForeName": "Ada", "LastName": "Lovelace"}],
                            "Journal": {"Title": "Journal A", "JournalIssue": {"PubDate": {"Year": "2024"}}},
                            "ELocationID": [],
                        },
                    }
                },
                {
                    "MedlineCitation": {
                        "PMID": "22222222",
                        "Article": {
                            "ArticleTitle": "Paper B",
                            "Abstract": {"AbstractText": ["Abstract B"]},
                            "AuthorList": [{"ForeName": "Alan", "LastName": "Turing"}],
                            "Journal": {"Title": "Journal B", "JournalIssue": {"PubDate": {"Year": "2023"}}},
                            "ELocationID": [],
                        },
                    }
                },
            ]
        },
    ]

    fake_entrez = _build_fake_entrez(fake_records)
    monkeypatch.setattr(Bio, "Entrez", fake_entrez, raising=False)

    tool = PubMedSearchTools(cache_dir=tmp_path / "cache", cache_ttl=60)
    monkeypatch.setattr(
        tool,
        "_get_pubmed_pmc_pdf_url",
        lambda pmid: f"https://www.ncbi.nlm.nih.gov/pmc/articles/PMC{pmid}/pdf",
    )

    results = tool.search_papers("covid vaccine", num_results=2, use_cache=False)
    assert len(results) == 2
    assert results[0]["source"] == "pubmed"
    assert results[0]["pmid"] == "11111111"
    assert results[0]["pdf_url"].endswith("PMC11111111/pdf")
    assert "authors" in results[1]


def test_pubmed_pmc_pdf_url_resolution(monkeypatch, tmp_path: Path):
    # Simulate Entrez.elink -> Entrez.read response that includes a PMC mapping.
    fake_entrez = _build_fake_entrez(
        [
            [
                {
                    "LinkSetDb": [
                        {
                            "DbTo": "pmc",
                            "Link": [{"Id": "9999999"}],
                        }
                    ]
                }
            ]
        ]
    )
    monkeypatch.setattr(Bio, "Entrez", fake_entrez, raising=False)

    tool = PubMedSearchTools(cache_dir=tmp_path / "cache", cache_ttl=60)
    url = tool._get_pubmed_pmc_pdf_url("12345678")
    assert url == "https://www.ncbi.nlm.nih.gov/pmc/articles/PMC9999999/pdf"


def test_search_pubmed_convenience_function(monkeypatch):
    def _fake_search(self, query, num_results=10, use_cache=True):
        assert query == "cancer immunotherapy"
        assert num_results == 3
        return [{"source": "pubmed", "pmid": "33333333", "title": "Mock Paper"}]

    monkeypatch.setattr(PubMedSearchTools, "search_papers", _fake_search)
    results = search_pubmed("cancer immunotherapy", num_results=3)
    assert isinstance(results, list)
    assert results[0]["pmid"] == "33333333"
