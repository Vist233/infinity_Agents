import json
import os
import pytest
from pathlib import Path
from agent.tools.arxiv_agno import ArxivTools

pytestmark = pytest.mark.skipif(
    os.getenv("RUN_LIVE_NETWORK_TESTS") != "1",
    reason="arXiv tests require explicit live-network opt-in",
)

@pytest.fixture
def arxiv_tools():
    return ArxivTools()

def test_search_arxiv_and_return_articles(arxiv_tools):
    """Test searching arXiv for articles."""
    query = "attention is all you need"
    results_json = arxiv_tools.search_arxiv_and_return_articles(query, num_articles=2)
    
    results = json.loads(results_json)
    assert isinstance(results, list)
    assert len(results) <= 2
    if len(results) > 0:
        article = results[0]
        assert "title" in article
        assert "id" in article
        assert "pdf_url" in article
        assert "summary" in article

def test_read_arxiv_papers(arxiv_tools):
    """Test reading content from specific arXiv papers."""
    # Using the ID for "Attention Is All You Need"
    id_list = ["1706.03762v7"]
    results_json = arxiv_tools.read_arxiv_papers(id_list, pages_to_read=1)
    
    results = json.loads(results_json)
    assert isinstance(results, list)
    assert len(results) == 1
    
    article = results[0]
    assert article["id"] == "1706.03762v7"
    assert "content" in article
    assert len(article["content"]) == 1
    assert "text" in article["content"][0]
    assert "page" in article["content"][0]
    assert article["content"][0]["page"] == 1
