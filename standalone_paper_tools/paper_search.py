"""
Paper Search Tools - Combined ArXiv and PubMed search with caching and middleware.

Based on arxiv_agno.py pattern, extended with PubMed integration and middleware support.
"""

import json
import hashlib
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from agno.tools import Toolkit
from agno.utils.log import log_debug, logger
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
    SEARCH_OUTPUT_SCHEMA_VERSION = "v3_no_authors"

    def __init__(
        self,
        enable_search: bool = True,
        enable_read: bool = True,
        cache_middleware: Optional[CacheMiddleware] = None,
        size_middleware: Optional[SizeMiddleware] = None,
        pubmed_client: Optional[PubMedSearchClient] = None,
        download_dir: Optional[Path] = None,
        **kwargs,
    ):
        self.arxiv_client = arxiv.Client()
        self.download_dir = download_dir or DOWNLOAD_DIR
        self.cache = cache_middleware or CacheMiddleware()
        self.size_limit = size_middleware or SizeMiddleware()
        self.pubmed_client = pubmed_client or PubMedSearchClient()

        tools: List[Any] = []
        if enable_search:
            tools.append(self.search_papers)
        if enable_read:
            tools.append(self.read_paper_content)

        super().__init__(name="paper_search_tools", tools=tools, **kwargs)

    def search_papers(self, query: str, num_results: int = 5, require_pdf_url: bool = True) -> str:
        """Search for academic papers on both ArXiv and PubMed.

        Args:
            query (str): The search query for finding papers.
            num_results (int, optional): Maximum number of results to return. Defaults to 10.
            require_pdf_url (bool, optional): If True, only return records with non-empty PDF URL.
                Defaults to True.

        Returns:
            str: JSON object with `articles` and optional `errors`.
        """
        # Check cache first
        cached = self.cache.get(
            "combined_search",
            self.SEARCH_OUTPUT_SCHEMA_VERSION,
            query,
            num_results,
            require_pdf_url,
        )
        if cached:
            return cached

        fetch_size = max(num_results * 4, 1)

        # Fetch both sources using unified schema
        arxiv_articles = self._get_arxiv_papers(query, fetch_size)
        
        # Fetch PubMed papers
        pubmed_result = self.pubmed_client.search(query, fetch_size)
        pubmed_articles = pubmed_result["articles"]
        errors: List[Dict[str, str]] = []
        if pubmed_result.get("error"):
            errors.append(pubmed_result["error"])

        if require_pdf_url:
            arxiv_articles = self._filter_with_pdf(arxiv_articles)
            pubmed_articles = self._filter_with_pdf(pubmed_articles)

        # Seamless merge: interleave two sources so callers can use one unified list.
        merged_articles = self._merge_interleaved(arxiv_articles, pubmed_articles)
        all_articles = self._dedupe_articles(merged_articles)
        all_articles = self.size_limit.limit_articles(all_articles[:num_results])

        if require_pdf_url and len(all_articles) < num_results:
            errors.append(
                {
                    "source": "paper_search",
                    "code": "insufficient_pdf_results",
                    "message": f"Requested {num_results} PDF-backed results, found {len(all_articles)}.",
                }
            )
        
        payload: Dict[str, Any] = {"articles": all_articles}
        if errors:
            payload["errors"] = self._dedupe_errors(errors)

        result = json.dumps(payload, indent=2)
        result = self.size_limit.limit_response(result)

        # Cache the result
        self.cache.set(
            "combined_search",
            result,
            self.SEARCH_OUTPUT_SCHEMA_VERSION,
            query,
            num_results,
            require_pdf_url,
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

    def _dedupe_errors(self, errors: List[Dict[str, str]]) -> List[Dict[str, str]]:
        """Deduplicate repeated structured errors."""
        deduped: List[Dict[str, str]] = []
        seen = set()
        for err in errors:
            key = (err.get("source"), err.get("code"), err.get("message"))
            if key in seen:
                continue
            seen.add(key)
            deduped.append(err)
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
        """Backward-compatible wrapper to get only PubMed articles."""
        return self.pubmed_client.search(query, num_results).get("articles", [])

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
