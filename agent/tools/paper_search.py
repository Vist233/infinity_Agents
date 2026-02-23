"""
Paper Search Tools - Combined ArXiv and PubMed search with caching and middleware.

Based on arxiv_agno.py pattern, extended with PubMed integration and middleware support.
"""

import json
import hashlib
import time
import re
import requests
from pathlib import Path
from typing import Any, Dict, List, Optional

from agno.tools import Toolkit
from agno.utils.log import log_debug, logger
from agent.papers_repo_pg import PapersRepoPG, PaperRecord
from agent.tools.pdf_extractor import PDFExtractor, ExtractedContent
from standalone_paper_tools.pubmed_search import PubMedSearchClient

try:
    import arxiv
except ImportError:
    raise ImportError("`arxiv` not installed. Please install using `pip install arxiv`")

try:
    from pypdf import PdfReader
except ImportError:
    raise ImportError("`pypdf` not installed. Please install using `pip install pypdf`")


# Cache directory
CACHE_DIR = Path(__file__).parent / "cache"
DOWNLOAD_DIR = Path(__file__).parent / "arxiv_pdfs"


class CacheMiddleware:
    """Middleware for caching API responses."""

    def __init__(self, cache_dir: Optional[Path] = None, ttl_seconds: int = 3600):
        self.cache_dir = cache_dir or CACHE_DIR
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.ttl_seconds = ttl_seconds

    def _get_cache_key(self, func_name: str, *args, **kwargs) -> str:
        """Generate a cache key from function name and arguments."""
        key_data = f"{func_name}:{args}:{sorted(kwargs.items())}"
        return hashlib.md5(key_data.encode()).hexdigest()

    def _get_cache_path(self, cache_key: str) -> Path:
        return self.cache_dir / f"{cache_key}.json"

    def get(self, func_name: str, *args, **kwargs) -> Optional[str]:
        """Get cached result if available and not expired."""
        cache_key = self._get_cache_key(func_name, *args, **kwargs)
        cache_path = self._get_cache_path(cache_key)

        if cache_path.exists():
            try:
                with open(cache_path, "r", encoding="utf-8") as f:
                    cached = json.load(f)
                if time.time() - cached.get("timestamp", 0) < self.ttl_seconds:
                    log_debug(f"Cache hit for {func_name}")
                    return cached.get("data")
            except Exception as e:
                logger.error(f"Cache read error: {e}")
        return None

    def set(self, func_name: str, result: str, *args, **kwargs) -> None:
        """Cache the result."""
        cache_key = self._get_cache_key(func_name, *args, **kwargs)
        cache_path = self._get_cache_path(cache_key)

        try:
            with open(cache_path, "w", encoding="utf-8") as f:
                json.dump({"timestamp": time.time(), "data": result}, f)
            log_debug(f"Cached result for {func_name}")
        except Exception as e:
            logger.error(f"Cache write error: {e}")


class SizeMiddleware:
    """Middleware for limiting response size."""

    def __init__(self, max_chars: int = 50000, max_articles: int = 10):
        self.max_chars = max_chars
        self.max_articles = max_articles

    def limit_response(self, response: str) -> str:
        """Limit response to max_chars."""
        if len(response) > self.max_chars:
            log_debug(f"Response truncated from {len(response)} to {self.max_chars} chars")
            return response[: self.max_chars] + "\n... [Response truncated]"
        return response

    def limit_articles(self, articles: List[Dict]) -> List[Dict]:
        """Limit number of articles."""
        if len(articles) > self.max_articles:
            log_debug(f"Articles limited from {len(articles)} to {self.max_articles}")
            return articles[: self.max_articles]
        return articles


class PaperSearchTools(Toolkit):
    """Combined ArXiv and PubMed search tools with caching and size limiting."""
    SEARCH_OUTPUT_SCHEMA_VERSION = "v4_standalone_pubmed_interleaved"

    def __init__(
        self,
        enable_search: bool = True,
        enable_read: bool = True,
        cache_middleware: Optional[CacheMiddleware] = None,
        size_middleware: Optional[SizeMiddleware] = None,
        download_dir: Optional[Path] = None,
        shared_cache_root: Optional[Path] = None,
        papers_db: Optional[PapersRepoPG] = None,
        pubmed_client: Optional[PubMedSearchClient] = None,
        **kwargs,
    ):
        self.arxiv_client = arxiv.Client()
        self.download_dir = download_dir or DOWNLOAD_DIR
        self.download_dir.mkdir(parents=True, exist_ok=True)
        self.shared_cache_root = shared_cache_root or self.download_dir.parent
        self.shared_cache_root.mkdir(parents=True, exist_ok=True)
        self.md_dir = self.shared_cache_root / "md"
        self.md_dir.mkdir(parents=True, exist_ok=True)
        self.extracted_dir = self.shared_cache_root / "extracted"
        self.extracted_dir.mkdir(parents=True, exist_ok=True)
        self.pdf_extractor = PDFExtractor(output_base_dir=self.extracted_dir)
        self.cache = cache_middleware or CacheMiddleware()
        self.size_limit = size_middleware or SizeMiddleware()
        self.papers_db = papers_db
        self.pubmed_client = pubmed_client or PubMedSearchClient()
        # Keep historical response behavior: do not enforce PDF-only results by default.
        self.require_pdf_url_default = False

        tools: List[Any] = []
        if enable_search:
            tools.extend([self.search_paper, self.search_papers])
        if enable_read:
            tools.append(self.read_paper)

        super().__init__(name="paper_search_tools", tools=tools, **kwargs)

    def _extract_arxiv_id(self, paper_ref: str) -> Optional[str]:
        if not isinstance(paper_ref, str):
            return None
        ref = paper_ref.strip()
        if not ref:
            return None
        if ref.startswith(("http://", "https://")) and "arxiv.org" not in ref:
            return None

        m_us = re.match(r"^(\d{4})_(\d{4,5})(v\d+)?$", ref)
        if m_us:
            version = m_us.group(3) or ""
            return f"{m_us.group(1)}.{m_us.group(2)}{version}"

        m_id = re.match(r"^(\d{4}\.\d{4,5})(v\d+)?$", ref)
        if m_id:
            return m_id.group(0)

        m_url = re.search(r"(\d{4}\.\d{4,5})(v\d+)?", ref)
        if m_url:
            return m_url.group(0)
        return None

    def _paper_id_from_arxiv_id(self, arxiv_id: str) -> str:
        return arxiv_id.replace(".", "_")

    def _canonical_md_path(self, paper_id: str) -> Path:
        return self.md_dir / f"{paper_id}.md"

    def _build_canonical_md(self, paper_id: str, extracted: ExtractedContent) -> str:
        parts: List[str] = [
            f"# Paper {paper_id}",
            "",
            "## Source Text (By Page)",
            "",
        ]
        for page in extracted.pages:
            page_num = page.get("page_num", "?")
            text = page.get("text", "") or ""
            parts.append(f"### Page {page_num}")
            parts.append("")
            parts.append(text if text.strip() else "[No text extracted on this page]")
            parts.append("")
        return "\n".join(parts)

    def _download_arxiv_pdf(self, arxiv_id: str, paper_id: str) -> Path:
        pdf_path = self.download_dir / f"{paper_id}.pdf"
        if pdf_path.exists():
            return pdf_path
        download_url = f"https://arxiv.org/pdf/{arxiv_id}.pdf"
        log_debug(f"Downloading PDF from: {download_url}")
        response = requests.get(download_url, timeout=60)
        response.raise_for_status()
        with open(pdf_path, "wb") as f:
            f.write(response.content)
        return pdf_path

    def _ensure_materialized_for_read(self, paper_ref: str) -> Dict[str, Any]:
        if self.papers_db is None:
            return {
                "success": False,
                "error": "paper_db_not_configured",
                "message": "当前运行未配置论文仓库，无法执行会话授权读取。",
            }

        arxiv_id = self._extract_arxiv_id(paper_ref)
        if not arxiv_id:
            return {
                "success": False,
                "error": "unsupported_paper_ref",
                "message": "仅支持 arXiv ID 或 arXiv URL。",
            }
        paper_id = self._paper_id_from_arxiv_id(arxiv_id)

        if not self.papers_db.is_authorized_ref(paper_ref, paper_id=paper_id):
            return {
                "success": False,
                "error": "paper_not_authorized_for_session",
                "message": "该论文不在当前会话可访问范围。请先使用 search_paper。",
            }

        self.papers_db.link_paper_to_session(self.papers_db.session_id, paper_id, source_ref=paper_ref)
        existing = self.papers_db.get_by_id(paper_id)
        md_path = self._canonical_md_path(paper_id)

        if existing and existing.canonical_md_path and Path(existing.canonical_md_path).exists():
            return {
                "success": True,
                "paper_id": paper_id,
                "md_path": Path(existing.canonical_md_path),
                "source_status": "from_cache",
                "cached": True,
            }
        if md_path.exists():
            return {
                "success": True,
                "paper_id": paper_id,
                "md_path": md_path,
                "source_status": "from_cache",
                "cached": True,
            }

        pdf_path: Optional[Path] = None
        if existing and existing.pdf_path and Path(existing.pdf_path).exists():
            pdf_path = Path(existing.pdf_path)
        if pdf_path is None:
            pdf_path = self._download_arxiv_pdf(arxiv_id, paper_id)

        self.papers_db.upsert(
            PaperRecord(
                paper_id=paper_id,
                source_url=f"https://arxiv.org/abs/{arxiv_id}",
                pdf_path=str(pdf_path),
                status="processing",
            )
        )

        extracted = self.pdf_extractor.extract(str(pdf_path), paper_id)
        canonical_md = self._build_canonical_md(paper_id, extracted)
        md_path.write_text(canonical_md, encoding="utf-8")

        self.papers_db.save_extracted_content(
            paper_id,
            extracted.text,
            str(extracted.images_dir),
            canonical_md_path=str(md_path),
        )
        self.papers_db.update_status(paper_id, "completed")
        return {
            "success": True,
            "paper_id": paper_id,
            "md_path": md_path,
            "source_status": "downloaded_and_extracted",
            "cached": False,
        }

    def read_paper(
        self,
        paper_ref: str,
        action: str = "cat",
        pattern: Optional[str] = None,
        start_line: int = 1,
        max_lines: int = 200,
        case_sensitive: bool = False,
    ) -> str:
        """Read paper content in command-line style from canonical Markdown."""
        materialized = self._ensure_materialized_for_read(paper_ref)
        if not materialized.get("success"):
            return json.dumps(materialized, indent=2, ensure_ascii=False)

        paper_id = materialized["paper_id"]
        md_path: Path = materialized["md_path"]
        source_status = materialized["source_status"]
        cached = materialized["cached"]

        lines = md_path.read_text(encoding="utf-8", errors="replace").splitlines()
        total_lines = len(lines)
        action = (action or "cat").lower()

        result: Dict[str, Any] = {
            "paper_id": paper_id,
            "md_path": str(md_path),
            "action": action,
            "cached": cached,
            "source_status": source_status,
            "total_lines": total_lines,
        }

        if action == "head":
            n = max(1, min(max_lines, total_lines))
            result["content"] = "\n".join(lines[:n])
            return json.dumps(result, indent=2, ensure_ascii=False)

        if action == "tail":
            n = max(1, min(max_lines, total_lines))
            result["content"] = "\n".join(lines[-n:])
            return json.dumps(result, indent=2, ensure_ascii=False)

        if action == "cat":
            start = max(1, start_line)
            end = min(total_lines, start + max_lines - 1)
            result["start_line"] = start
            result["end_line"] = end
            result["content"] = "\n".join(lines[start - 1:end])
            return json.dumps(result, indent=2, ensure_ascii=False)

        if action == "grep":
            if not pattern:
                result["error"] = "pattern is required for grep action"
                return json.dumps(result, indent=2, ensure_ascii=False)
            flags = 0 if case_sensitive else re.IGNORECASE
            matches: List[Dict[str, Any]] = []
            regex = re.compile(pattern, flags=flags)
            for idx, line in enumerate(lines, start=1):
                if regex.search(line):
                    ctx_start = max(1, idx - 2)
                    ctx_end = min(total_lines, idx + 2)
                    matches.append({
                        "line": idx,
                        "match": line,
                        "context": "\n".join(lines[ctx_start - 1:ctx_end]),
                    })
                if len(matches) >= max_lines:
                    break
            result["pattern"] = pattern
            result["matches"] = matches
            result["match_count"] = len(matches)
            return json.dumps(result, indent=2, ensure_ascii=False)

        if action == "outline":
            headings = []
            for idx, line in enumerate(lines, start=1):
                if line.startswith("#"):
                    headings.append({"line": idx, "heading": line.strip()})
            result["headings"] = headings
            return json.dumps(result, indent=2, ensure_ascii=False)

        result["error"] = f"unsupported action: {action}"
        return json.dumps(result, indent=2, ensure_ascii=False)

    def _register_authorized_papers(self, papers: List[Dict]) -> None:
        """Persist references returned by search so downstream tools can enforce authorization."""
        if self.papers_db is None:
            return
        refs: List[str] = []
        for p in papers:
            for key in ("id", "entry_id", "pdf_url", "url"):
                value = p.get(key)
                if isinstance(value, str) and value.strip():
                    refs.append(value.strip())
            paper_id = self._extract_paper_id_from_result(p)
            if paper_id:
                source_ref = next(
                    (
                        p.get(k)
                        for k in ("pdf_url", "entry_id", "url", "id")
                        if isinstance(p.get(k), str) and p.get(k).strip()
                    ),
                    None,
                )
                self.papers_db.link_paper_to_session(
                    self.papers_db.session_id,
                    paper_id,
                    source_ref=source_ref,
                )
        self.papers_db.register_authorized_refs(refs, source="search_paper")

    def _extract_paper_id_from_result(self, result: Dict[str, Any]) -> Optional[str]:
        """Extract canonical paper_id used by workflow/cache from search result."""
        raw_id = result.get("id")
        if isinstance(raw_id, str) and raw_id.strip():
            rid = raw_id.strip()
            if re.match(r"^\d{4}\.\d{4,5}(v\d+)?$", rid):
                return rid.replace(".", "_")
            if re.match(r"^\d+$", rid):
                return rid

        for key in ("entry_id", "pdf_url", "url"):
            value = result.get(key)
            if not isinstance(value, str):
                continue
            match = re.search(r"(\d{4}\.\d{4,5})(v\d+)?", value)
            if match:
                return match.group(0).replace(".", "_")
            pm_match = re.search(r"/(\d+)/?$", value)
            if pm_match:
                return pm_match.group(1)
        return None

    def search_paper(self, query: str, num_results: int = 5) -> str:
        """Primary paper search entry (alias of search_papers for compatibility)."""
        return self.search_papers(query=query, num_results=num_results)

    def search_papers(self, query: str, num_results: int = 5) -> str:
        """Search for academic papers on both ArXiv and PubMed.

        Args:
            query (str): The search query for finding papers.
            num_results (int, optional): Maximum number of results to return. Defaults to 10.

        Returns:
            str: JSON array of papers from both sources.
        """
        # Check cache first
        cached = self.cache.get(
            "combined_search",
            self.SEARCH_OUTPUT_SCHEMA_VERSION,
            query,
            num_results,
            self.require_pdf_url_default,
        )
        if cached:
            return cached

        fetch_size = max(num_results * 4, 1)

        # Fetch ArXiv papers
        arxiv_articles = self._get_arxiv_papers(query, fetch_size)

        # Fetch PubMed papers
        pubmed_articles = self._get_pubmed_papers(query, fetch_size)

        if self.require_pdf_url_default:
            arxiv_articles = self._filter_with_pdf(arxiv_articles)
            pubmed_articles = self._filter_with_pdf(pubmed_articles)

        merged_articles = self._merge_interleaved(arxiv_articles, pubmed_articles)
        all_articles = self._dedupe_articles(merged_articles)
        all_articles = self.size_limit.limit_articles(all_articles[:num_results])
        self._register_authorized_papers(all_articles)

        result = json.dumps(all_articles, indent=2)
        result = self.size_limit.limit_response(result)

        # Cache the result
        self.cache.set(
            "combined_search",
            result,
            self.SEARCH_OUTPUT_SCHEMA_VERSION,
            query,
            num_results,
            self.require_pdf_url_default,
        )
        return result

    def _dedupe_articles(self, articles: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Deduplicate by stable source-specific identifiers."""
        deduped: List[Dict[str, Any]] = []
        seen = set()
        for article in articles:
            source = article.get("source", "")
            article_id = article.get("id", "")
            title = str(article.get("title", "")).strip().lower()
            key = (source, article_id or title)
            if key in seen:
                continue
            seen.add(key)
            deduped.append(article)
        return deduped

    def _filter_with_pdf(self, articles: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Keep only records that contain a non-empty PDF URL."""
        filtered: List[Dict[str, Any]] = []
        for article in articles:
            pdf_url = article.get("pdf_url")
            if isinstance(pdf_url, str) and pdf_url.strip():
                filtered.append(article)
        return filtered

    def _merge_interleaved(
        self,
        arxiv_articles: List[Dict[str, Any]],
        pubmed_articles: List[Dict[str, Any]],
    ) -> List[Dict[str, Any]]:
        """Interleave source results to produce a single seamless ranked list."""
        merged: List[Dict[str, Any]] = []
        max_len = max(len(arxiv_articles), len(pubmed_articles))
        for i in range(max_len):
            if i < len(arxiv_articles):
                merged.append(arxiv_articles[i])
            if i < len(pubmed_articles):
                merged.append(pubmed_articles[i])
        return merged

    def _get_arxiv_papers(self, query: str, num_results: int) -> List[Dict]:
        """Internal helper to get ArXiv results."""
        if num_results <= 0:
            return []
        
        articles = []
        try:
            for result in self.arxiv_client.results(
                search=arxiv.Search(
                    query=query,
                    max_results=num_results,
                    sort_by=arxiv.SortCriterion.Relevance,
                    sort_order=arxiv.SortOrder.Descending,
                )
            ):
                article = {
                    "source": "arxiv",
                    "title": result.title,
                    "id": result.get_short_id(),
                    "pmid": None,
                    "pmcid": None,
                    "doi": None,
                    "entry_id": result.entry_id,
                    "url": result.entry_id,
                    "full_text_url": result.entry_id,
                    "authors": [author.name for author in result.authors][:5],
                    "primary_category": result.primary_category,
                    "categories": result.categories,
                    "published": result.published.isoformat() if result.published else None,
                    "pdf_url": result.pdf_url,
                    "summary": result.summary[:500] + "..." if len(result.summary) > 500 else result.summary,
                }
                articles.append(article)
        except Exception as e:
            logger.error(f"ArXiv search error: {e}")
        return articles

    def _get_pubmed_papers(self, query: str, num_results: int) -> List[Dict]:
        """Internal helper to get PubMed results."""
        result = self.pubmed_client.search(query, num_results)
        error = result.get("error")
        if error:
            logger.warning("PubMed search returned error: %s", error)

        raw_articles = result.get("articles") or []
        normalized: List[Dict[str, Any]] = []
        for article in raw_articles:
            normalized.append(self._normalize_pubmed_article(article))
        return normalized

    def _normalize_pubmed_article(self, article: Dict[str, Any]) -> Dict[str, Any]:
        """Normalize standalone PubMed payload to preserve current output compatibility."""
        pmid = str(article.get("pmid") or article.get("id") or "").strip()
        title = str(article.get("title") or "").strip()
        summary = str(article.get("summary") or article.get("abstract") or "").strip()
        url = article.get("url")
        if not isinstance(url, str) or not url.strip():
            if pmid:
                url = f"https://pubmed.ncbi.nlm.nih.gov/{pmid}/"
            else:
                url = None
        authors = article.get("authors")
        if not isinstance(authors, list):
            authors = []

        return {
            "source": "pubmed",
            "title": title,
            "id": pmid,
            "pmid": pmid,
            "pmcid": article.get("pmcid"),
            "doi": article.get("doi"),
            "entry_id": article.get("entry_id"),
            "url": url,
            "full_text_url": article.get("full_text_url"),
            "primary_category": article.get("primary_category"),
            "categories": article.get("categories") if isinstance(article.get("categories"), list) else [],
            "published": article.get("published"),
            "pdf_url": article.get("pdf_url"),
            "authors": authors,
            "summary": summary[:500] + "..." if len(summary) > 500 else summary,
        }

    def read_paper_content(
        self,
        paper_id: str,
        pages: Optional[List[int]] = None,
        regex_pattern: Optional[str] = None,
    ) -> str:
        """Read content from a paper by downloading its PDF.

        Args:
            paper_id (str): The ArXiv paper ID (e.g., '2103.03404v1').
            pages (List[int], optional): Specific page numbers to read. Defaults to all pages.
            regex_pattern (str, optional): Regex pattern to search for in the text.

        Returns:
            str: JSON with paper content or matching text sections.
        """
        import re

        # Check cache
        cache_key_args = (paper_id, tuple(pages) if pages else None, regex_pattern)
        cached = self.cache.get("read_paper_content", *cache_key_args)
        if cached:
            return cached

        self.download_dir.mkdir(parents=True, exist_ok=True)

        try:
            results = list(self.arxiv_client.results(search=arxiv.Search(id_list=[paper_id])))
            if not results:
                return json.dumps({"error": f"Paper {paper_id} not found"})

            paper = results[0]
            article = {
                "title": paper.title,
                "id": paper.get_short_id(),
                "pdf_url": paper.pdf_url,
                "summary": paper.summary,
            }

            if paper.pdf_url:
                log_debug(f"Downloading: {paper.pdf_url}")
                pdf_path = paper.download_pdf(dirpath=str(self.download_dir))
                pdf_reader = PdfReader(pdf_path)

                content = []
                for page_num, page in enumerate(pdf_reader.pages, start=1):
                    # Skip pages not in the requested list
                    if pages and page_num not in pages:
                        continue

                    text = page.extract_text() or ""

                    # If regex pattern provided, only include matching sections
                    if regex_pattern:
                        matches = re.findall(f".{{0,100}}{regex_pattern}.{{0,100}}", text, re.IGNORECASE)
                        if matches:
                            content.append({
                                "page": page_num,
                                "matches": matches[:10],  # Limit matches per page
                            })
                    else:
                        content.append({
                            "page": page_num,
                            "text": text[:5000] + "..." if len(text) > 5000 else text,
                        })

                article["content"] = content

        except Exception as e:
            logger.error(f"Error reading paper: {e}")
            return json.dumps({"error": str(e)})

        result = json.dumps(article, indent=2)
        result = self.size_limit.limit_response(result)

        self.cache.set("read_paper_content", result, *cache_key_args)
        return result
