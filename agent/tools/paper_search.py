"""
Paper Search Tools - Combined ArXiv and PubMed search with caching and middleware.

Based on arxiv_agno.py pattern, extended with PubMed integration and middleware support.
"""

import json
import hashlib
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Callable
from functools import wraps

from agno.tools import Toolkit
from agno.utils.log import log_debug, logger

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

    def __init__(
        self,
        enable_search: bool = True,
        enable_read: bool = True,
        enable_pubmed: bool = True,
        cache_middleware: Optional[CacheMiddleware] = None,
        size_middleware: Optional[SizeMiddleware] = None,
        download_dir: Optional[Path] = None,
        **kwargs,
    ):
        self.arxiv_client = arxiv.Client()
        self.download_dir = download_dir or DOWNLOAD_DIR
        self.cache = cache_middleware or CacheMiddleware()
        self.size_limit = size_middleware or SizeMiddleware()

        tools: List[Any] = []
        if enable_search:
            tools.append(self.search_papers)
        if enable_read:
            tools.append(self.read_paper_content)
        if enable_pubmed:
            tools.append(self.search_pubmed)

        super().__init__(name="paper_search_tools", tools=tools, **kwargs)

    def search_papers(self, query: str, num_results: int = 10, source: str = "arxiv") -> str:
        """Search for academic papers on ArXiv.

        Args:
            query (str): The search query for finding papers.
            num_results (int, optional): Maximum number of results to return. Defaults to 10.
            source (str, optional): Search source, currently only 'arxiv' supported. Defaults to 'arxiv'.

        Returns:
            str: JSON array of papers with title, id, authors, pdf_url, summary.
        """
        # Check cache first
        cached = self.cache.get("search_papers", query, num_results, source)
        if cached:
            return cached

        articles = []
        log_debug(f"Searching {source} for: {query}")

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
                    "title": result.title,
                    "id": result.get_short_id(),
                    "entry_id": result.entry_id,
                    "authors": [author.name for author in result.authors][:5],  # Limit authors
                    "primary_category": result.primary_category,
                    "published": result.published.isoformat() if result.published else None,
                    "pdf_url": result.pdf_url,
                    "summary": result.summary[:500] + "..." if len(result.summary) > 500 else result.summary,
                }
                articles.append(article)
        except Exception as e:
            logger.error(f"ArXiv search error: {e}")
            return json.dumps({"error": str(e)})

        articles = self.size_limit.limit_articles(articles)
        result = json.dumps(articles, indent=2)
        result = self.size_limit.limit_response(result)

        # Cache the result
        self.cache.set("search_papers", result, query, num_results, source)
        return result

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

    def search_pubmed(self, query: str, num_results: int = 10) -> str:
        """Search for papers on PubMed.

        Args:
            query (str): The search query.
            num_results (int, optional): Maximum results. Defaults to 10.

        Returns:
            str: JSON array of papers with title, pmid, authors, abstract.
        """
        try:
            from Bio import Entrez
        except ImportError:
            return json.dumps({"error": "biopython not installed. Run: pip install biopython"})

        cached = self.cache.get("search_pubmed", query, num_results)
        if cached:
            return cached

        Entrez.email = "paper_agent@example.com"

        try:
            # Search PubMed
            handle = Entrez.esearch(db="pubmed", term=query, retmax=num_results)
            record = Entrez.read(handle)
            handle.close()

            id_list = record.get("IdList", [])
            if not id_list:
                return json.dumps([])

            # Fetch details
            handle = Entrez.efetch(db="pubmed", id=",".join(id_list), rettype="xml", retmode="xml")
            records = Entrez.read(handle)
            handle.close()

            articles = []
            for article in records.get("PubmedArticle", []):
                medline = article.get("MedlineCitation", {})
                article_data = medline.get("Article", {})

                title = article_data.get("ArticleTitle", "")
                abstract = article_data.get("Abstract", {}).get("AbstractText", [""])
                if isinstance(abstract, list):
                    abstract = " ".join(str(a) for a in abstract)

                authors = []
                for author in article_data.get("AuthorList", [])[:5]:
                    name = f"{author.get('ForeName', '')} {author.get('LastName', '')}".strip()
                    if name:
                        authors.append(name)

                pmid = str(medline.get("PMID", ""))

                articles.append({
                    "title": title,
                    "pmid": pmid,
                    "url": f"https://pubmed.ncbi.nlm.nih.gov/{pmid}/",
                    "authors": authors,
                    "abstract": abstract[:500] + "..." if len(abstract) > 500 else abstract,
                })

            result = json.dumps(articles, indent=2)
            self.cache.set("search_pubmed", result, query, num_results)
            return result

        except Exception as e:
            logger.error(f"PubMed search error: {e}")
            return json.dumps({"error": str(e)})
