"""
PubMed Search Tool - Independent PubMed paper search with PMC PDF retrieval.

This is a standalone tool for searching PubMed and retrieving PMC PDF links.
No dependencies on ArXiv or other paper sources.

Features:
- Pure PubMed search via NCBI E-utilities API
- Automatic PMC (PubMed Central) PDF link retrieval
- Caching support for better performance
- Structured paper metadata extraction

Requirements:
    pip install biopython

Usage:
    from agent.tools.pubmed_search import PubMedSearchTools
    
    # Create instance
    pubmed = PubMedSearchTools()
    
    # Search papers
    results = pubmed.search_papers("COVID-19 vaccine", num_results=10)
    
    # Each result contains:
    # - pmid: PubMed ID
    # - title: Paper title
    # - authors: List of authors
    # - summary: Abstract
    # - pdf_url: PMC PDF URL (if available)
"""

import json
import hashlib
import time
import re
from pathlib import Path
from typing import Any, Dict, List, Optional
from dataclasses import dataclass
from urllib.parse import urljoin
from urllib.request import Request, urlopen

# Configure logging
import logging
logger = logging.getLogger(__name__)

# Default cache directory
CACHE_DIR = Path(__file__).parent / "cache" / "pubmed"


@dataclass
class PubMedPaper:
    """Structured representation of a PubMed paper."""
    pmid: str
    title: str
    authors: List[str]
    abstract: str
    publication_date: Optional[str]
    journal: Optional[str]
    doi: Optional[str]
    pdf_url: Optional[str]  # PMC PDF URL if available
    pmc_id: Optional[str]  # PubMed Central ID
    
    def to_dict(self) -> Dict:
        """Convert to dictionary for JSON serialization."""
        return {
            "source": "pubmed",
            "pmid": self.pmid,
            "id": self.pmid,
            "title": self.title,
            "authors": self.authors,
            "summary": self.abstract[:500] + "..." if len(self.abstract) > 500 else self.abstract,
            "abstract": self.abstract,
            "publication_date": self.publication_date,
            "journal": self.journal,
            "doi": self.doi,
            "pdf_url": self.pdf_url,
            "pmc_id": self.pmc_id,
            "url": f"https://pubmed.ncbi.nlm.nih.gov/{self.pmid}/",
            "full_text_url": f"https://pmc.ncbi.nlm.nih.gov/articles/{self.pmc_id}/" if self.pmc_id else (f"https://doi.org/{self.doi}" if self.doi else None),
        }


class PubMedCache:
    """Simple file-based cache for PubMed API responses."""
    
    def __init__(self, cache_dir: Path = CACHE_DIR, ttl_seconds: int = 3600):
        self.cache_dir = cache_dir
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.ttl_seconds = ttl_seconds
    
    def _get_cache_key(self, func_name: str, *args, **kwargs) -> str:
        """Generate cache key from function arguments."""
        key_data = f"{func_name}:{args}:{sorted(kwargs.items())}"
        return hashlib.md5(key_data.encode()).hexdigest()
    
    def get(self, func_name: str, *args, **kwargs) -> Optional[str]:
        """Get cached result if available and not expired."""
        cache_key = self._get_cache_key(func_name, *args, **kwargs)
        cache_path = self.cache_dir / f"{cache_key}.json"
        
        if cache_path.exists():
            try:
                with open(cache_path, "r", encoding="utf-8") as f:
                    cached = json.load(f)
                if time.time() - cached.get("timestamp", 0) < self.ttl_seconds:
                    logger.debug(f"Cache hit for {func_name}")
                    return cached.get("data")
            except Exception as e:
                logger.error(f"Cache read error: {e}")
        return None
    
    def set(self, func_name: str, result: str, *args, **kwargs) -> None:
        """Cache the result."""
        cache_key = self._get_cache_key(func_name, *args, **kwargs)
        cache_path = self.cache_dir / f"{cache_key}.json"
        
        try:
            with open(cache_path, "w", encoding="utf-8") as f:
                json.dump({"timestamp": time.time(), "data": result}, f)
            logger.debug(f"Cached result for {func_name}")
        except Exception as e:
            logger.error(f"Cache write error: {e}")


class PubMedSearchTools:
    """Standalone PubMed search tool with PMC PDF retrieval.
    
    This tool provides a clean, independent interface for searching
    PubMed and retrieving PMC PDF links when available.
    
    Example:
        >>> tool = PubMedSearchTools()
        >>> results = tool.search_papers("COVID-19 vaccine", num_results=10)
        >>> for paper in results:
        ...     print(f"{paper['pmid']}: {paper['title'][:50]}...")
        ...     if paper.get('pdf_url'):
        ...         print(f"  PDF: {paper['pdf_url']}")
    """
    
    def __init__(
        self,
        email: str = "paper_agent@example.com",
        cache_dir: Optional[Path] = None,
        cache_ttl: int = 3600,
    ):
        """Initialize PubMed search tool.
        
        Args:
            email: Email for NCBI API (required by their terms)
            cache_dir: Directory for caching API responses
            cache_ttl: Cache time-to-live in seconds
        """
        self.email = email
        self.cache = PubMedCache(cache_dir or CACHE_DIR, cache_ttl)
        
        # Verify biopython is installed
        try:
            from Bio import Entrez
            self._entrez_available = True
        except ImportError:
            logger.warning("Biopython not installed. PubMed search will not work.")
            logger.info("Install with: pip install biopython")
            self._entrez_available = False
    
    def search_papers(
        self,
        query: str,
        num_results: int = 10,
        use_cache: bool = True,
    ) -> List[Dict]:
        """Search PubMed for papers matching the query."""
        if not self._entrez_available:
            logger.error("Biopython not available. Cannot search PubMed.")
            return []
        
        # Check cache
        if use_cache:
            cached = self.cache.get("search_papers", query, num_results)
            if cached:
                logger.info(f"Returning cached results for '{query}'")
                return json.loads(cached)
        
        from Bio import Entrez
        Entrez.email = self.email
        
        try:
            logger.info(f"Searching PubMed for: {query}")
            
            # Step 1: Search for PMIDs
            id_list = self._retry("esearch", lambda: self._run_esearch(Entrez, query, num_results))
            if not id_list:
                logger.info(f"No results found for '{query}'")
                return []
            
            logger.info(f"Found {len(id_list)} papers, fetching details...")
            
            # Step 2: Fetch paper details
            records = self._retry("efetch", lambda: self._run_efetch(Entrez, id_list))
            
            # Step 3: Parse papers
            papers = []
            for article in records.get("PubmedArticle", []):
                paper = self._parse_pubmed_article(article)
                if paper:
                    papers.append(paper.to_dict())
            
            # Cache results
            if use_cache:
                self.cache.set(
                    "search_papers",
                    json.dumps(papers),
                    query,
                    num_results
                )
            
            logger.info(f"Successfully retrieved {len(papers)} papers")
            return papers
            
        except Exception as e:
            logger.error(f"PubMed search error: {e}")
            return []

    def _retry(self, op_name: str, op, max_retries: int = 3, retry_delay_seconds: float = 1.0):
        """Run an operation with exponential backoff."""
        last_exc: Optional[Exception] = None
        for attempt in range(max_retries):
            try:
                return op()
            except Exception as exc:
                last_exc = exc
                if attempt == max_retries - 1:
                    break
                sleep_seconds = retry_delay_seconds * (2**attempt)
                logger.warning(
                    "PubMed %s failed on attempt %s/%s: %s. Retrying in %.1fs",
                    op_name,
                    attempt + 1,
                    max_retries,
                    exc,
                    sleep_seconds,
                )
                time.sleep(sleep_seconds)
        raise RuntimeError(f"PubMed {op_name} failed after {max_retries} attempts: {last_exc}")

    def _run_esearch(self, entrez, query: str, num_results: int) -> List[str]:
        handle = entrez.esearch(db="pubmed", term=query, retmax=num_results)
        try:
            record = entrez.read(handle)
            return record.get("IdList", [])
        finally:
            handle.close()

    def _run_efetch(self, entrez, id_list: List[str]) -> Dict[str, Any]:
        handle = entrez.efetch(db="pubmed", id=",".join(id_list), rettype="xml", retmode="xml")
        try:
            return entrez.read(handle)
        finally:
            handle.close()
    
    def _parse_pubmed_article(self, article: Dict) -> Optional[PubMedPaper]:
        """Parse a PubMed article XML into a PubMedPaper object."""
        try:
            medline = article.get("MedlineCitation", {})
            article_data = medline.get("Article", {})
            
            # Extract PMID
            pmid = str(medline.get("PMID", ""))
            if not pmid:
                return None
            
            # Extract title
            title = article_data.get("ArticleTitle", "")
            
            # Extract abstract
            abstract_parts = article_data.get("Abstract", {}).get("AbstractText", [""])
            if isinstance(abstract_parts, list):
                abstract = " ".join(str(a) for a in abstract_parts)
            else:
                abstract = str(abstract_parts)
            
            # Extract authors
            authors = []
            for author in article_data.get("AuthorList", [])[:5]:
                first_name = author.get("ForeName", "")
                last_name = author.get("LastName", "")
                name = f"{first_name} {last_name}".strip()
                if name:
                    authors.append(name)
            
            # Extract journal and date
            journal = article_data.get("Journal", {}).get("Title", "")
            pub_date = article_data.get("Journal", {}).get("JournalIssue", {}).get("PubDate", {})
            year = pub_date.get("Year", "")
            month = pub_date.get("Month", "")
            publication_date = f"{year}-{month}" if year and month else year
            
            # Extract DOI
            doi = None
            for identifier in article_data.get("ELocationID", []):
                if identifier.attributes.get("EIdType") == "doi":
                    doi = str(identifier)
                    break
            
            # Get PMC PDF URL
            pdf_url = self._get_pubmed_pmc_pdf_url(pmid)
            
            # Extract PMC ID from PDF URL
            pmc_id = None
            if pdf_url:
                # Extract PMC ID from URL like .../PMC12345678/pdf
                import re
                match = re.search(r'PMC(\d+)', pdf_url)
                if match:
                    pmc_id = match.group(1)
            
            return PubMedPaper(
                pmid=pmid,
                title=title,
                authors=authors,
                abstract=abstract,
                publication_date=publication_date,
                journal=journal,
                doi=doi,
                pdf_url=pdf_url,
                pmc_id=pmc_id,
            )
            
        except Exception as e:
            logger.error(f"Error parsing PubMed article: {e}")
            return None
    
    def _get_pubmed_pmc_pdf_url(self, pmid: str) -> Optional[str]:
        """Get PDF URL from PubMed Central (PMC) if available.
        
        This method queries the NCBI Entrez API to check if a PubMed article
        has a corresponding entry in PubMed Central (PMC). If found, it returns
        the direct PDF URL.
        
        Args:
            pmid: PubMed ID (e.g., "12345678")
            
        Returns:
            Direct PDF URL if available in PMC, otherwise None.
            Format: https://www.ncbi.nlm.nih.gov/pmc/articles/PMC{pmc_id}/pdf
            
        Example:
            >>> url = tool._get_pubmed_pmc_pdf_url("12345678")
            >>> print(url)
            "https://www.ncbi.nlm.nih.gov/pmc/articles/PMC87654321/pdf"
        """
        try:
            from Bio import Entrez
        except ImportError:
            logger.warning("Biopython not installed. Cannot query PMC.")
            return None
            
        try:
            # Step 1: Query Entrez to check if this PMID has a PMC ID
            # We use elink to find links between PubMed (dbfrom) and PMC (db)
            handle = Entrez.elink(dbfrom="pubmed", db="pmc", id=pmid)
            link_results = Entrez.read(handle)
            handle.close()
            
            # Step 2: Extract the PMC ID from the link results
            # The structure is nested, so we need to iterate through the results
            pmc_id = None
            for linkset in link_results:
                # Each linkset contains multiple database links
                for link in linkset.get("LinkSetDb", []):
                    # Check if this link is to PMC
                    if link.get("DbTo") == "pmc":
                        # Extract the ID from the link
                        for doc_id in link.get("Link", []):
                            pmc_id = doc_id.get("Id")
                            if pmc_id:
                                break
                    if pmc_id:
                        break
                if pmc_id:
                    break
            
            # Step 3: If no PMC ID found, this paper is not in PMC
            if not pmc_id:
                logger.debug(f"No PMC ID found for PMID {pmid}")
                return None
            
            # Step 4: Construct the direct PDF URL
            # The standard format for PMC PDF URLs is:
            # https://www.ncbi.nlm.nih.gov/pmc/articles/PMC{pmc_id}/pdf
            pdf_url = f"https://www.ncbi.nlm.nih.gov/pmc/articles/PMC{pmc_id}/pdf"
            
            logger.debug(f"Found PMC PDF for PMID {pmid}: {pdf_url}")
            return pdf_url
            
        except Exception as e:
            logger.error(f"Error getting PMC PDF for PMID {pmid}: {e}")
            return None
            
    def download_pdf_by_pmid(self, pmid: str, output_dir: str = "papers/pubmed") -> Dict[str, Any]:
        """Try downloading a PubMed paper PDF if an open PDF URL is available."""
        articles = self.search_papers(query=f"{pmid}[PMID]", num_results=1)
        if not articles:
            return {
                "ok": False,
                "error": {
                    "source": "pubmed",
                    "code": "not_found",
                    "message": f"No article found for PMID {pmid}",
                },
            }

        article = articles[0]
        pdf_url = article.get("pdf_url")
        if not pdf_url:
            return {
                "ok": False,
                "error": {
                    "source": "pubmed",
                    "code": "pdf_unavailable",
                    "message": f"No open PDF URL available for PMID {pmid}",
                },
                "article": article,
            }

        out_dir = Path(output_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        file_path = out_dir / f"{pmid}.pdf"

        try:
            data, content_type = self._fetch_url_bytes(pdf_url)
            if "pdf" not in content_type and not data.startswith(b"%PDF"):
                resolved_pdf_url = self._resolve_pdf_url_from_full_text(article)
                if not resolved_pdf_url:
                    return {
                        "ok": False,
                        "error": {
                            "source": "pubmed",
                            "code": "pdf_download_failed",
                            "message": f"URL did not return PDF content: {pdf_url}",
                        },
                        "article": article,
                    }
                data, content_type = self._fetch_url_bytes(resolved_pdf_url)
                if "pdf" not in content_type and not data.startswith(b"%PDF"):
                    return {
                        "ok": False,
                        "error": {
                            "source": "pubmed",
                            "code": "pdf_download_failed",
                            "message": f"Resolved URL did not return PDF content: {resolved_pdf_url}",
                        },
                        "article": article,
                    }
                article["pdf_url"] = resolved_pdf_url
            file_path.write_bytes(data)
            return {"ok": True, "path": str(file_path), "article": article}
        except Exception as exc:
            return {
                "ok": False,
                "error": {
                    "source": "pubmed",
                    "code": "pdf_download_failed",
                    "message": str(exc),
                },
                "article": article,
            }

    def _fetch_url_bytes(self, url: str) -> tuple[bytes, str]:
        req = Request(url, headers={"User-Agent": "Infinity-Agent/1.0"})
        with urlopen(req, timeout=30) as resp:
            content_type = str(resp.headers.get("Content-Type", "")).lower()
            data = resp.read()
        return data, content_type

    def _resolve_pdf_url_from_full_text(self, article: Dict[str, Any]) -> Optional[str]:
        full_text_url = article.get("full_text_url")
        if not full_text_url:
            return None
        try:
            html_bytes, content_type = self._fetch_url_bytes(full_text_url)
            if "html" not in content_type and "text" not in content_type:
                return None
            html = html_bytes.decode("utf-8", errors="ignore")

            # Preferred: citation_pdf_url meta tag
            match = re.search(
                r'<meta[^>]+name=["\\\']citation_pdf_url["\\\'][^>]+content=["\\\']([^"\\\']+)["\\\']',
                html,
                flags=re.IGNORECASE,
            )
            if match:
                return urljoin(full_text_url, match.group(1))

            # Fallback: direct .pdf href in page
            href_match = re.search(
                r'href=["\\\']([^"\\\']+\\.pdf(?:\\?[^"\\\']*)?)["\\\']',
                html,
                flags=re.IGNORECASE,
            )
            if href_match:
                return urljoin(full_text_url, href_match.group(1))
            return None
        except Exception:
            return None


# Convenience function for direct usage
def search_pubmed(
    query: str,
    num_results: int = 10,
    email: str = "paper_agent@example.com",
) -> List[Dict]:
    """Convenience function to search PubMed without creating a class instance.
    
    This is a standalone function that creates a temporary PubMedSearchTools
    instance, performs the search, and returns the results.
    
    Args:
        query: Search query (e.g., "COVID-19 vaccine")
        num_results: Maximum number of results to return
        email: Email for NCBI API (required by their terms of service)
        
    Returns:
        List of paper dictionaries. See PubMedSearchTools.search_papers() for details.
        
    Example:
        >>> results = search_pubmed("cancer immunotherapy", num_results=5)
        >>> for paper in results:
        ...     print(f"{paper['pmid']}: {paper['title'][:50]}...")
        ...     if paper.get('pdf_url'):
        ...         print(f"  PDF available: {paper['pdf_url']}")
    """
    tool = PubMedSearchTools(email=email)
    return tool.search_papers(query, num_results)


if __name__ == "__main__":
    # Run a quick test when executed directly
    import sys
    
    print("=" * 70)
    print("PubMed Search Tool - Standalone Test")
    print("=" * 70)
    
    # Check for biopython
    try:
        from Bio import Entrez
        print("✓ Biopython is installed")
    except ImportError:
        print("✗ Biopython is not installed")
        print("  Install with: pip install biopython")
        sys.exit(1)
    
    # Run test search
    query = "COVID-19 vaccine"
    print(f"\nSearching PubMed for: '{query}'")
    print("-" * 70)
    
    try:
        results = search_pubmed(query, num_results=5)
        
        print(f"\n✓ Found {len(results)} papers\n")
        
        for i, paper in enumerate(results, 1):
            has_pdf = "✓ PDF" if paper.get("pdf_url") else "✗ No PDF"
            print(f"[{i}] PMID: {paper['pmid']} [{has_pdf}]")
            print(f"    Title: {paper['title'][:70]}...")
            if paper.get("pdf_url"):
                print(f"    PDF: {paper['pdf_url']}")
            print()
        
        # Summary
        with_pdf = sum(1 for r in results if r.get("pdf_url"))
        print("-" * 70)
        print(f"Summary: {with_pdf}/{len(results)} papers have PMC PDF available")
        print("=" * 70)
        
    except Exception as e:
        print(f"\n✗ Error: {e}")
        import traceback
        traceback.print_exc()
