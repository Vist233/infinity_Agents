import json
import pytest
from pathlib import Path
import shutil
import time
from agent.tools.paper_search import PaperSearchTools, CacheMiddleware, SizeMiddleware

@pytest.fixture
def temp_cache_dir(tmp_path):
    return tmp_path / "cache"

@pytest.fixture
def temp_download_dir(tmp_path):
    return tmp_path / "downloads"

@pytest.fixture
def paper_search_tools(temp_cache_dir, temp_download_dir):
    cache = CacheMiddleware(cache_dir=temp_cache_dir, ttl_seconds=60)
    size = SizeMiddleware(max_chars=5000, max_articles=10) # Increased for combined tests
    return PaperSearchTools(
        cache_middleware=cache,
        size_middleware=size,
        download_dir=temp_download_dir
    )

def test_cache_middleware_basic(temp_cache_dir):
    cache = CacheMiddleware(cache_dir=temp_cache_dir, ttl_seconds=10)
    func_name = "test_func"
    args = ("arg1",)
    kwargs = {"kw": "val"}
    data = "test_result"
    
    # Check empty cache
    assert cache.get(func_name, *args, **kwargs) is None
    
    # Set and get
    cache.set(func_name, data, *args, **kwargs)
    assert cache.get(func_name, *args, **kwargs) == data
    
    cache_key = cache._get_cache_key(func_name, *args, **kwargs)
    assert (temp_cache_dir / f"{cache_key}.json").exists()

def test_size_middleware_limits():
    size = SizeMiddleware(max_chars=10, max_articles=1)
    
    # Test response limiting
    long_response = "this is a very long response"
    limited = size.limit_response(long_response)
    assert len(limited) <= 10 + len("\n... [Response truncated]")
    assert "truncated" in limited
    
    # Test article limiting
    articles = [{"id": 1}, {"id": 2}]
    limited_articles = size.limit_articles(articles)
    assert len(limited_articles) == 1

def test_search_papers_combined(paper_search_tools):
    """Test combined ArXiv and PubMed search."""
    query = "transformer models"
    result_json = paper_search_tools.search_papers(query, num_results=4)
    
    results = json.loads(result_json)
    assert isinstance(results, list)
    assert len(results) <= 4
    
    sources = set(article.get("source") for article in results)
    print(f"Sources found: {sources}")
    # Ideally should contain both if available
    assert "arxiv" in sources or "pubmed" in sources

def test_read_paper_content_basic(paper_search_tools):
    """Test reading paper content."""
    paper_id = "1706.03762v7" # Attention Is All You Need
    result_json = paper_search_tools.read_paper_content(paper_id, pages=[1])
    
    if "... [Response truncated]" in result_json:
        assert "1706.03762v7" in result_json
    else:
        result = json.loads(result_json)
        assert result["id"] == "1706.03762v7"
        assert len(result["content"]) == 1
        assert result["content"][0]["page"] == 1

def test_read_paper_content_regex(paper_search_tools):
    """Test reading paper content with regex."""
    paper_id = "1706.03762v7"
    regex = "Transformer"
    result_json = paper_search_tools.read_paper_content(paper_id, pages=[1], regex_pattern=regex)
    
    if "... [Response truncated]" in result_json:
        assert "Transformer" in result_json or "matches" in result_json
    else:
        result = json.loads(result_json)
        assert "content" in result
        for page in result["content"]:
            assert "matches" in page
            for match in page["matches"]:
                assert "Transformer" in match or "transformer" in match.lower()
