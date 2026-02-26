import json
from pathlib import Path
from types import SimpleNamespace
import pytest
from agent.tools.paper_search import PaperSearchTools, CacheMiddleware, SizeMiddleware
from agent.tools.pdf_extractor import ExtractedContent

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

def test_search_papers_combined(monkeypatch, paper_search_tools):
    """Test combined search behavior with deterministic offline fixtures."""
    monkeypatch.setattr(
        paper_search_tools,
        "_get_arxiv_papers",
        lambda _q, _n: [
            {
                "source": "arxiv",
                "id": "a1",
                "title": "Attention Paper",
                "summary": "summary-a1",
                "authors": ["author-a"],
                "entry_id": "https://arxiv.org/abs/1706.03762",
                "url": "https://arxiv.org/abs/1706.03762",
                "pdf_url": "https://arxiv.org/pdf/1706.03762",
            },
            {
                "source": "arxiv",
                "id": "a2",
                "title": "Another Paper",
                "summary": "summary-a2",
                "authors": ["author-b"],
                "entry_id": "https://arxiv.org/abs/2401.00001",
                "url": "https://arxiv.org/abs/2401.00001",
                "pdf_url": "https://arxiv.org/pdf/2401.00001",
            },
        ],
    )
    monkeypatch.setattr(paper_search_tools, "_register_authorized_papers", lambda _items: None)

    result_json = paper_search_tools.search_papers("transformer models", num_results=4)
    results = json.loads(result_json)
    assert isinstance(results, list)
    assert len(results) == 2
    assert all(article.get("source") == "arxiv" for article in results)

def test_read_paper_content_basic(monkeypatch, paper_search_tools, temp_download_dir):
    """Test reading paper content."""
    paper_id = "1706.03762v7"  # Attention Is All You Need

    class _FakePage:
        def extract_text(self):
            return "Transformer content"

    class _FakeReader:
        def __init__(self, _pdf_path):
            self.pages = [_FakePage()]

    class _FakeResult:
        title = "Attention Is All You Need"
        summary = "summary"

        def get_short_id(self):
            return paper_id

        @property
        def pdf_url(self):
            return "https://arxiv.org/pdf/1706.03762v7.pdf"

        def download_pdf(self, dirpath):
            path = Path(dirpath) / f"{paper_id}.pdf"
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"%PDF-1.4\n%fake\n")
            return str(path)

    monkeypatch.setattr(
        paper_search_tools.arxiv_client,
        "results",
        lambda search: [_FakeResult()],
    )
    monkeypatch.setattr("agent.tools.paper_search.PdfReader", _FakeReader)

    result_json = paper_search_tools.read_paper_content(paper_id, pages=[1])
    
    if "... [Response truncated]" in result_json:
        assert "1706.03762v7" in result_json
    else:
        result = json.loads(result_json)
        assert result["id"] == "1706.03762v7"
        assert len(result["content"]) == 1
        assert result["content"][0]["page"] == 1

def test_read_paper_content_regex(monkeypatch, paper_search_tools):
    """Test reading paper content with regex."""
    paper_id = "1706.03762v7"
    regex = "Transformer"

    class _FakePage:
        def extract_text(self):
            return "This paper introduces the Transformer architecture."

    class _FakeReader:
        def __init__(self, _pdf_path):
            self.pages = [_FakePage()]

    class _FakeResult:
        title = "Attention Is All You Need"
        summary = "summary"

        def get_short_id(self):
            return paper_id

        @property
        def pdf_url(self):
            return "https://arxiv.org/pdf/1706.03762v7.pdf"

        def download_pdf(self, dirpath):
            path = Path(dirpath) / f"{paper_id}.pdf"
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"%PDF-1.4\n%fake\n")
            return str(path)

    monkeypatch.setattr(
        paper_search_tools.arxiv_client,
        "results",
        lambda search: [_FakeResult()],
    )
    monkeypatch.setattr("agent.tools.paper_search.PdfReader", _FakeReader)

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


def test_search_papers_deduped(monkeypatch, paper_search_tools):
    """Dedupe strategy: source-aware dedupe removes duplicate IDs."""
    arxiv_articles = [
        {"source": "arxiv", "id": "a1", "title": "A1", "summary": "sa1", "authors": ["x"]},
        {"source": "arxiv", "id": "a1", "title": "A1 duplicate", "summary": "dup", "authors": ["x"]},
        {"source": "arxiv", "id": "a2", "title": "A2", "summary": "sa2", "authors": ["y"]},
    ]

    monkeypatch.setattr(paper_search_tools, "_get_arxiv_papers", lambda _q, _n: arxiv_articles)

    called = {}

    def _capture_register(items):
        called["items"] = items

    monkeypatch.setattr(paper_search_tools, "_register_authorized_papers", _capture_register)

    result_json = paper_search_tools.search_papers("merge-test", num_results=4)
    result = json.loads(result_json)

    assert isinstance(result, list)
    assert len(result) == 2
    assert [item["id"] for item in result] == ["a1", "a2"]
    assert called["items"] == result


def test_register_authorized_papers_called_with_final_list(monkeypatch, temp_cache_dir, temp_download_dir):
    """Ensure authorization registration uses final result list."""
    class FakePapersDB:
        def __init__(self):
            self.session_id = "test-session"
            self.linked = []
            self.refs = []

        def link_paper_to_session(self, session_id, paper_id, source_ref=None):
            self.linked.append((session_id, paper_id, source_ref))

        def register_authorized_refs(self, refs, source=""):
            self.refs.append((refs, source))

    cache = CacheMiddleware(cache_dir=temp_cache_dir, ttl_seconds=60)
    size = SizeMiddleware(max_chars=5000, max_articles=10)
    fake_db = FakePapersDB()
    tool = PaperSearchTools(
        cache_middleware=cache,
        size_middleware=size,
        download_dir=temp_download_dir,
        papers_db=fake_db,
    )

    monkeypatch.setattr(
        tool,
        "_get_arxiv_papers",
        lambda _q, _n: [{"source": "arxiv", "id": "2401.00001", "title": "A", "summary": "sa", "entry_id": "https://arxiv.org/abs/2401.00001", "url": "https://arxiv.org/abs/2401.00001", "pdf_url": "https://arxiv.org/pdf/2401.00001"}],
    )

    result = json.loads(tool.search_papers("auth-test", num_results=2))
    assert isinstance(result, list)
    assert len(result) == 1
    assert fake_db.linked
    assert fake_db.refs


def test_search_paper_alias_matches_search_papers(monkeypatch, paper_search_tools):
    """search_paper should remain a compatibility alias of search_papers."""
    payload = [{"source": "arxiv", "id": "a1", "title": "T", "summary": "S", "authors": []}]
    monkeypatch.setattr(paper_search_tools, "search_papers", lambda query, num_results=5: json.dumps(payload))

    via_alias = paper_search_tools.search_paper("q", num_results=3)
    via_direct = paper_search_tools.search_papers("q", num_results=3)
    assert via_alias == via_direct
    assert json.loads(via_alias) == payload


def test_search_papers_uses_fetch_size_multiplier(monkeypatch, paper_search_tools):
    """ArXiv fetch uses num_results * 4."""
    captured = {"arxiv": None}

    def _fake_arxiv(_q, n):
        captured["arxiv"] = n
        return []

    monkeypatch.setattr(paper_search_tools, "_get_arxiv_papers", _fake_arxiv)
    monkeypatch.setattr(paper_search_tools, "_register_authorized_papers", lambda _items: None)

    paper_search_tools.search_papers("fetch-size", num_results=7)
    assert captured["arxiv"] == 28


def test_search_papers_cache_key_uses_schema_and_pdf_flag(monkeypatch, paper_search_tools):
    """Cache arguments should include schema version and require_pdf flag to avoid stale collisions."""
    calls = {"get": None, "set": None}

    def _fake_get(func_name, *args, **kwargs):
        calls["get"] = (func_name, args, kwargs)
        return None

    def _fake_set(func_name, result, *args, **kwargs):
        calls["set"] = (func_name, result, args, kwargs)

    monkeypatch.setattr(paper_search_tools.cache, "get", _fake_get)
    monkeypatch.setattr(paper_search_tools.cache, "set", _fake_set)
    monkeypatch.setattr(paper_search_tools, "_get_arxiv_papers", lambda _q, _n: [])
    monkeypatch.setattr(paper_search_tools, "_register_authorized_papers", lambda _items: None)

    paper_search_tools.search_papers("cache-key", num_results=2)

    assert calls["get"] is not None
    get_func, get_args, _ = calls["get"]
    assert get_func == "combined_search"
    assert get_args[0] == paper_search_tools.SEARCH_OUTPUT_SCHEMA_VERSION
    assert get_args[1] == "cache-key"
    assert get_args[2] == 2
    assert get_args[3] is False

    assert calls["set"] is not None
    set_func, _set_result, set_args, _ = calls["set"]
    assert set_func == "combined_search"
    assert set_args[0] == paper_search_tools.SEARCH_OUTPUT_SCHEMA_VERSION
    assert set_args[1] == "cache-key"
    assert set_args[2] == 2
    assert set_args[3] is False


def test_search_papers_pdf_filter_toggle(monkeypatch, paper_search_tools):
    """When require_pdf_url_default=True, non-PDF records should be dropped."""
    arxiv_articles = [
        {"source": "arxiv", "id": "a1", "title": "A1", "summary": "s", "authors": [], "pdf_url": ""},
        {"source": "arxiv", "id": "a2", "title": "A2", "summary": "s", "authors": [], "pdf_url": "http://x/a2.pdf"},
    ]

    paper_search_tools.require_pdf_url_default = True
    monkeypatch.setattr(paper_search_tools, "_get_arxiv_papers", lambda _q, _n: arxiv_articles)
    monkeypatch.setattr(paper_search_tools, "_register_authorized_papers", lambda _items: None)

    result = json.loads(paper_search_tools.search_papers("pdf-filter", num_results=4))
    assert [item["id"] for item in result] == ["a2"]


class _FakePapersDB:
    def __init__(self):
        self.session_id = "00000000-0000-0000-0000-000000000001"
        self.authorized = True
        self.linked = []
        self.refs = []
        self.upserts = []
        self.saved_extracted = []
        self.status_updates = []
        self.record = None
        self.uploaded_papers = {}

    def is_authorized_ref(self, ref, paper_id=None):
        return self.authorized

    def link_paper_to_session(self, session_id, paper_id, source_ref=None):
        self.linked.append((session_id, paper_id, source_ref))

    def register_authorized_refs(self, refs, source="search_paper"):
        self.refs.append((list(refs), source))

    def get_by_id(self, paper_id):
        return self.record

    def upsert(self, record):
        self.upserts.append(record)
        self.record = SimpleNamespace(
            paper_id=record.paper_id,
            pdf_path=record.pdf_path,
            canonical_md_path=record.canonical_md_path,
        )

    def save_extracted_content(self, paper_id, text, images_dir, canonical_md_path=None):
        self.saved_extracted.append((paper_id, canonical_md_path, images_dir))
        self.record = SimpleNamespace(
            paper_id=paper_id,
            pdf_path=self.record.pdf_path if self.record else None,
            canonical_md_path=canonical_md_path,
        )

    def update_status(self, paper_id, status):
        self.status_updates.append((paper_id, status))

    def get_session_uploaded_paper(self, session_id, paper_id):
        if session_id != self.session_id:
            return None
        return self.uploaded_papers.get(paper_id)


class _SharedSessionStore:
    def __init__(self):
        self.authorized_refs_by_session = {}
        self.linked = set()
        self.record = None


class _SessionScopedFakePapersDB:
    def __init__(self, shared: _SharedSessionStore, session_id: str):
        self.shared = shared
        self.session_id = session_id

    def is_authorized_ref(self, ref, paper_id=None):
        refs = self.shared.authorized_refs_by_session.get(self.session_id, set())
        if isinstance(ref, str) and ref in refs:
            return True
        if paper_id and (self.session_id, paper_id) in self.shared.linked:
            return True
        return False

    def link_paper_to_session(self, session_id, paper_id, source_ref=None):
        self.shared.linked.add((session_id, paper_id))

    def register_authorized_refs(self, refs, source="search_paper"):
        self.shared.authorized_refs_by_session.setdefault(self.session_id, set()).update(refs)

    def get_by_id(self, paper_id):
        return self.shared.record

    def upsert(self, record):
        self.shared.record = SimpleNamespace(
            paper_id=record.paper_id,
            pdf_path=record.pdf_path,
            canonical_md_path=record.canonical_md_path,
        )

    def save_extracted_content(self, paper_id, text, images_dir, canonical_md_path=None):
        self.shared.record = SimpleNamespace(
            paper_id=paper_id,
            pdf_path=self.shared.record.pdf_path if self.shared.record else None,
            canonical_md_path=canonical_md_path,
        )

    def update_status(self, paper_id, status):
        return None


def test_read_paper_rejects_unauthorized_ref(tmp_path):
    fake_db = _FakePapersDB()
    fake_db.authorized = False
    tool = PaperSearchTools(
        enable_search=False,
        enable_read=True,
        download_dir=tmp_path / "cache" / "downloads",
        shared_cache_root=tmp_path / "cache",
        papers_db=fake_db,
    )
    result = json.loads(tool.read_paper("2103.03404", action="head"))
    assert result["error"] == "paper_not_authorized_for_session"


def test_read_paper_uploaded_ref_success(monkeypatch, tmp_path):
    fake_db = _FakePapersDB()
    from agent.tools import paper_search as paper_search_module

    monkeypatch.setattr(paper_search_module, "PROJECT_ROOT", tmp_path)
    session_root = tmp_path / "papers" / "sessions" / fake_db.session_id
    md_path = session_root / "md" / "upload_test.md"
    images_dir = session_root / "extracted" / "upload_test" / "images"
    md_path.parent.mkdir(parents=True, exist_ok=True)
    images_dir.mkdir(parents=True, exist_ok=True)
    (images_dir / "page1_img1.png").write_bytes(b"fake-image")
    md_path.write_text(
        "# Paper upload_test\n\n## Source Text (By Page)\n\n### Page 1\n\ncontent\n\n",
        encoding="utf-8",
    )
    fake_db.uploaded_papers["upload_test"] = {
        "paper_id": "upload_test",
        "canonical_md_path": str(md_path),
        "images_dir": f"papers/sessions/{fake_db.session_id}/extracted/upload_test/images",
    }
    tool = PaperSearchTools(
        enable_search=False,
        enable_read=True,
        download_dir=tmp_path / "cache" / "downloads",
        shared_cache_root=tmp_path / "cache",
        papers_db=fake_db,
    )

    result = json.loads(tool.read_paper("uploaded://upload_test", action="head", max_lines=20))
    assert result["paper_id"] == "upload_test"
    assert result["source_status"] == "uploaded_session_pdf"
    assert result["images_by_page"] == [
        {
            "page_num": 1,
            "image_paths": ["extracted/upload_test/images/page1_img1.png"],
            "image_markdown": ["![page1_img1](img://./extracted/upload_test/images/page1_img1.png)"],
        }
    ]


def test_read_paper_uploaded_ref_denied_when_not_in_session(tmp_path):
    fake_db = _FakePapersDB()
    tool = PaperSearchTools(
        enable_search=False,
        enable_read=True,
        download_dir=tmp_path / "cache" / "downloads",
        shared_cache_root=tmp_path / "cache",
        papers_db=fake_db,
    )
    result = json.loads(tool.read_paper("uploaded://not_exists", action="head"))
    assert result["error"] == "paper_not_authorized_for_session"


def test_read_paper_cache_hit_skips_download(monkeypatch, tmp_path):
    fake_db = _FakePapersDB()
    shared_root = tmp_path / "cache"
    md_path = shared_root / "md" / "2103_03404.md"
    md_path.parent.mkdir(parents=True, exist_ok=True)
    md_path.write_text("# Title\nLine2\n", encoding="utf-8")
    fake_db.record = SimpleNamespace(
        paper_id="2103_03404",
        pdf_path=str(shared_root / "downloads" / "2103_03404.pdf"),
        canonical_md_path=str(md_path),
    )
    tool = PaperSearchTools(
        enable_search=False,
        enable_read=True,
        download_dir=shared_root / "downloads",
        shared_cache_root=shared_root,
        papers_db=fake_db,
    )

    def _should_not_download(*_args, **_kwargs):
        raise AssertionError("download should not be called on cache hit")

    monkeypatch.setattr(tool, "_download_pdf", _should_not_download)
    result = json.loads(tool.read_paper("2103.03404", action="head", max_lines=1))
    assert result["paper_id"] == "2103_03404"
    assert result["source_status"] == "from_cache"
    assert "Title" in result["content"]


def test_read_paper_download_and_materialize(monkeypatch, tmp_path):
    fake_db = _FakePapersDB()
    shared_root = tmp_path / "cache"
    downloads = shared_root / "downloads"
    tool = PaperSearchTools(
        enable_search=False,
        enable_read=True,
        download_dir=downloads,
        shared_cache_root=shared_root,
        papers_db=fake_db,
    )

    def _fake_download(_pdf_url, paper_id):
        pdf_path = downloads / f"{paper_id}.pdf"
        pdf_path.parent.mkdir(parents=True, exist_ok=True)
        pdf_path.write_bytes(b"%PDF-1.4\n%fake\n")
        return pdf_path

    def _fake_extract(_pdf_path, paper_id):
        images_dir = shared_root / "extracted" / paper_id / "images"
        images_dir.mkdir(parents=True, exist_ok=True)
        image_path = images_dir / "page1_img1.png"
        image_path.write_bytes(b"fake-image")
        return ExtractedContent(
            text="Method section",
            pages=[{"page_num": 1, "text": "Method section", "image_paths": [str(image_path)]}],
            images_dir=images_dir,
            image_count=1,
            page_count=1,
        )

    monkeypatch.setattr(tool, "_download_pdf", _fake_download)
    monkeypatch.setattr(tool.pdf_extractor, "extract", _fake_extract)

    result = json.loads(tool.read_paper("https://arxiv.org/abs/2103.03404", action="grep", pattern="Method"))
    assert result["paper_id"] == "2103_03404"
    assert result["source_status"] == "downloaded_and_extracted"
    assert result["match_count"] >= 1
    assert result["images_by_page"] == [
        {
            "page_num": 1,
            "image_paths": ["extracted/2103_03404/images/page1_img1.png"],
            "image_markdown": ["![page1_img1](img://./extracted/2103_03404/images/page1_img1.png)"],
        }
    ]
    assert (shared_root / "downloads" / "2103_03404.pdf").exists()
    assert (shared_root / "md" / "2103_03404.md").exists()
    assert "extracted/2103_03404/images/page1_img1.png" in (shared_root / "md" / "2103_03404.md").read_text(encoding="utf-8")
    assert fake_db.upserts
    assert fake_db.saved_extracted


def test_read_paper_accepts_underscore_arxiv_id(monkeypatch, tmp_path):
    fake_db = _FakePapersDB()
    shared_root = tmp_path / "cache"
    downloads = shared_root / "downloads"
    tool = PaperSearchTools(
        enable_search=False,
        enable_read=True,
        download_dir=downloads,
        shared_cache_root=shared_root,
        papers_db=fake_db,
    )

    def _fake_download(pdf_url, paper_id):
        assert pdf_url == "2103_03404"
        assert paper_id == "2103_03404"
        pdf_path = downloads / f"{paper_id}.pdf"
        pdf_path.parent.mkdir(parents=True, exist_ok=True)
        pdf_path.write_bytes(b"%PDF-1.4\n%fake\n")
        return pdf_path

    def _fake_extract(_pdf_path, paper_id):
        images_dir = shared_root / "extracted" / paper_id / "images"
        images_dir.mkdir(parents=True, exist_ok=True)
        return ExtractedContent(
            text="content",
            pages=[{"page_num": 1, "text": "content", "image_paths": []}],
            images_dir=images_dir,
            image_count=0,
            page_count=1,
        )

    monkeypatch.setattr(tool, "_download_pdf", _fake_download)
    monkeypatch.setattr(tool.pdf_extractor, "extract", _fake_extract)

    result = json.loads(tool.read_paper("2103_03404", action="head", max_lines=1))
    assert result["paper_id"] == "2103_03404"
    assert result["source_status"] == "downloaded_and_extracted"


def test_read_paper_rejects_non_pdf_url(monkeypatch, tmp_path):
    fake_db = _FakePapersDB()
    tool = PaperSearchTools(
        enable_search=False,
        enable_read=True,
        download_dir=tmp_path / "cache" / "downloads",
        shared_cache_root=tmp_path / "cache",
        papers_db=fake_db,
    )
    monkeypatch.setattr(tool, "_is_valid_pdf_url", lambda _url: False)
    result = json.loads(tool.read_paper("https://example.com/paper.html", action="head"))
    assert result["error"] == "unsupported_paper_ref"


def test_read_paper_direct_pdf_url_without_search(monkeypatch, tmp_path):
    fake_db = _FakePapersDB()
    fake_db.authorized = False
    shared_root = tmp_path / "cache"
    downloads = shared_root / "downloads"
    tool = PaperSearchTools(
        enable_search=False,
        enable_read=True,
        download_dir=downloads,
        shared_cache_root=shared_root,
        papers_db=fake_db,
    )
    pdf_url = "https://example.com/whitepaper.pdf"

    def _fake_download(_pdf_url, paper_id):
        pdf_path = downloads / f"{paper_id}.pdf"
        pdf_path.parent.mkdir(parents=True, exist_ok=True)
        pdf_path.write_bytes(b"%PDF-1.4\n%fake\n")
        return pdf_path

    def _fake_extract(_pdf_path, paper_id):
        images_dir = shared_root / "extracted" / paper_id / "images"
        images_dir.mkdir(parents=True, exist_ok=True)
        return ExtractedContent(
            text="Direct PDF content",
            pages=[{"page_num": 1, "text": "Direct PDF content", "image_paths": []}],
            images_dir=images_dir,
            image_count=0,
            page_count=1,
        )

    monkeypatch.setattr(tool, "_download_pdf", _fake_download)
    monkeypatch.setattr(tool.pdf_extractor, "extract", _fake_extract)
    first = json.loads(tool.read_paper(pdf_url, action="head", max_lines=1))
    assert first["source_status"] == "downloaded_and_extracted"
    assert fake_db.refs and fake_db.refs[-1][1] == "read_paper"
    assert pdf_url in fake_db.refs[-1][0]

    monkeypatch.setattr(tool, "_download_pdf", lambda *_a, **_k: (_ for _ in ()).throw(AssertionError("should not redownload")))
    second = json.loads(tool.read_paper(pdf_url, action="head", max_lines=1))
    assert second["source_status"] == "from_cache"


def test_read_paper_invalid_pdf_content_returns_structured_error(monkeypatch, tmp_path):
    fake_db = _FakePapersDB()
    fake_db.authorized = False
    tool = PaperSearchTools(
        enable_search=False,
        enable_read=True,
        download_dir=tmp_path / "cache" / "downloads",
        shared_cache_root=tmp_path / "cache",
        papers_db=fake_db,
    )
    monkeypatch.setattr(tool, "_download_pdf", lambda *_a, **_k: (_ for _ in ()).throw(ValueError("invalid_pdf_content")))

    result = json.loads(tool.read_paper("https://example.com/notpdf.pdf", action="head"))
    assert result["error"] == "invalid_pdf_content"


def test_read_paper_session_isolation_on_shared_cache(monkeypatch, tmp_path):
    shared_root = tmp_path / "cache"
    md_path = shared_root / "md" / "2103_03404.md"
    pdf_path = shared_root / "downloads" / "2103_03404.pdf"
    md_path.parent.mkdir(parents=True, exist_ok=True)
    pdf_path.parent.mkdir(parents=True, exist_ok=True)
    md_path.write_text("# Title\nSession scoped\n", encoding="utf-8")
    pdf_path.write_bytes(b"%PDF-1.4\n%fake\n")

    shared = _SharedSessionStore()
    shared.record = SimpleNamespace(
        paper_id="2103_03404",
        pdf_path=str(pdf_path),
        canonical_md_path=str(md_path),
    )
    shared.authorized_refs_by_session["00000000-0000-0000-0000-0000000000aa"] = {"2103.03404"}
    shared.authorized_refs_by_session["00000000-0000-0000-0000-0000000000bb"] = set()

    tool_a = PaperSearchTools(
        enable_search=False,
        enable_read=True,
        download_dir=shared_root / "downloads",
        shared_cache_root=shared_root,
        papers_db=_SessionScopedFakePapersDB(shared, "00000000-0000-0000-0000-0000000000aa"),
    )
    tool_b = PaperSearchTools(
        enable_search=False,
        enable_read=True,
        download_dir=shared_root / "downloads",
        shared_cache_root=shared_root,
        papers_db=_SessionScopedFakePapersDB(shared, "00000000-0000-0000-0000-0000000000bb"),
    )

    def _should_not_download(*_args, **_kwargs):
        raise AssertionError("download should not happen for shared cache hit")

    monkeypatch.setattr(tool_a, "_download_pdf", _should_not_download)
    monkeypatch.setattr(tool_b, "_download_pdf", _should_not_download)

    allowed = json.loads(tool_a.read_paper("2103.03404", action="head", max_lines=1))
    denied = json.loads(tool_b.read_paper("2103.03404", action="head", max_lines=1))

    assert allowed["paper_id"] == "2103_03404"
    assert allowed["source_status"] == "from_cache"
    assert "Title" in allowed["content"]
    assert denied["error"] == "paper_not_authorized_for_session"


def test_read_paper_cache_hit_rebuilds_images_index_from_extracted_dir(monkeypatch, tmp_path):
    fake_db = _FakePapersDB()
    shared_root = tmp_path / "cache"
    md_path = shared_root / "md" / "2103_03404.md"
    images_dir = shared_root / "extracted" / "2103_03404" / "images"
    images_dir.mkdir(parents=True, exist_ok=True)
    (images_dir / "page1_img1.png").write_bytes(b"fake")
    (images_dir / "page2_img1.png").write_bytes(b"fake")
    md_path.parent.mkdir(parents=True, exist_ok=True)
    md_path.write_text("# Title\n", encoding="utf-8")

    fake_db.record = SimpleNamespace(
        paper_id="2103_03404",
        pdf_path=str(shared_root / "downloads" / "2103_03404.pdf"),
        canonical_md_path=str(md_path),
    )
    tool = PaperSearchTools(
        enable_search=False,
        enable_read=True,
        download_dir=shared_root / "downloads",
        shared_cache_root=shared_root,
        papers_db=fake_db,
    )
    monkeypatch.setattr(tool, "_download_pdf", lambda *_a, **_k: (_ for _ in ()).throw(AssertionError("should not download")))

    result = json.loads(tool.read_paper("2103.03404", action="head", max_lines=1))
    assert result["source_status"] == "from_cache"
    assert result["images_by_page"] == [
        {
            "page_num": 1,
            "image_paths": ["extracted/2103_03404/images/page1_img1.png"],
            "image_markdown": ["![page1_img1](img://./extracted/2103_03404/images/page1_img1.png)"],
        },
        {
            "page_num": 2,
            "image_paths": ["extracted/2103_03404/images/page2_img1.png"],
            "image_markdown": ["![page2_img1](img://./extracted/2103_03404/images/page2_img1.png)"],
        },
    ]


def test_read_paper_includes_empty_images_by_page_for_text_only_pdf(monkeypatch, tmp_path):
    fake_db = _FakePapersDB()
    shared_root = tmp_path / "cache"
    downloads = shared_root / "downloads"
    tool = PaperSearchTools(
        enable_search=False,
        enable_read=True,
        download_dir=downloads,
        shared_cache_root=shared_root,
        papers_db=fake_db,
    )

    def _fake_download(_pdf_url, paper_id):
        pdf_path = downloads / f"{paper_id}.pdf"
        pdf_path.parent.mkdir(parents=True, exist_ok=True)
        pdf_path.write_bytes(b"%PDF-1.4\n%fake\n")
        return pdf_path

    def _fake_extract(_pdf_path, paper_id):
        images_dir = shared_root / "extracted" / paper_id / "images"
        images_dir.mkdir(parents=True, exist_ok=True)
        return ExtractedContent(
            text="Only text",
            pages=[{"page_num": 1, "text": "Only text", "image_paths": []}],
            images_dir=images_dir,
            image_count=0,
            page_count=1,
        )

    monkeypatch.setattr(tool, "_download_pdf", _fake_download)
    monkeypatch.setattr(tool.pdf_extractor, "extract", _fake_extract)

    result = json.loads(tool.read_paper("https://arxiv.org/abs/2103.03404", action="cat"))
    assert result["paper_id"] == "2103_03404"
    assert result["images_by_page"] == []
