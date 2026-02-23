"""
Standalone PubMed search helper with retry/backoff and structured errors.
"""

import os
import re
import time
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import urljoin
from urllib.request import Request, urlopen

from agno.utils.log import logger


class PubMedSearchClient:
    """PubMed search client with basic fault-tolerance."""

    def __init__(
        self,
        email: Optional[str] = None,
        max_retries: int = 3,
        retry_delay_seconds: float = 1.0,
    ):
        self.email = email or os.getenv("ENTREZ_EMAIL") or "paper_agent@example.com"
        self.max_retries = max_retries
        self.retry_delay_seconds = retry_delay_seconds
        self.api_key = os.getenv("ENTREZ_API_KEY")

    def search(self, query: str, num_results: int) -> Dict[str, Any]:
        """Search PubMed and return articles with optional error payload."""
        if num_results <= 0:
            return {"articles": [], "error": None}

        try:
            from Bio import Entrez
        except ImportError:
            return {
                "articles": [],
                "error": {
                    "source": "pubmed",
                    "code": "dependency_missing",
                    "message": "Biopython is not installed. Install with `pip install biopython`.",
                },
            }

        Entrez.email = self.email
        if self.api_key:
            Entrez.api_key = self.api_key

        try:
            id_list = self._retry("esearch", lambda: self._run_esearch(Entrez, query, num_results))
            if not id_list:
                return {"articles": [], "error": None}

            records = self._retry("efetch", lambda: self._run_efetch(Entrez, id_list))
            articles = self._parse_records(records)
            return {"articles": articles, "error": None}
        except Exception as exc:
            logger.error(f"PubMed search error: {exc}")
            return {
                "articles": [],
                "error": {
                    "source": "pubmed",
                    "code": "request_failed",
                    "message": str(exc),
                },
            }

    def download_pdf_by_pmid(self, pmid: str, output_dir: str = "papers/pubmed") -> Dict[str, Any]:
        """Try downloading a PubMed paper PDF if an open PDF URL is available."""
        result = self.search(f"{pmid}[PMID]", 1)
        if result.get("error"):
            return {"ok": False, "error": result["error"]}

        articles = result.get("articles", [])
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

    def _retry(self, op_name: str, op):
        """Run an operation with exponential backoff."""
        last_exc: Optional[Exception] = None
        for attempt in range(self.max_retries):
            try:
                return op()
            except Exception as exc:
                last_exc = exc
                if attempt == self.max_retries - 1:
                    break
                sleep_seconds = self.retry_delay_seconds * (2**attempt)
                logger.warning(
                    "PubMed %s failed on attempt %s/%s: %s. Retrying in %.1fs",
                    op_name,
                    attempt + 1,
                    self.max_retries,
                    exc,
                    sleep_seconds,
                )
                time.sleep(sleep_seconds)
        raise RuntimeError(f"PubMed {op_name} failed after {self.max_retries} attempts: {last_exc}")

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

    def _parse_records(self, records: Dict[str, Any]) -> List[Dict[str, Any]]:
        articles: List[Dict[str, Any]] = []
        for article in records.get("PubmedArticle", []):
            parsed = self._parse_article(article)
            if parsed:
                articles.append(parsed)
        return articles

    def _parse_article(self, article: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        medline = article.get("MedlineCitation", {})
        article_data = medline.get("Article", {})
        pubmed_data = article.get("PubmedData", {})

        title = str(article_data.get("ArticleTitle", "")).strip()
        pmid = str(medline.get("PMID", "")).strip()
        if not pmid:
            return None

        abstract = self._normalize_abstract(article_data.get("Abstract", {}).get("AbstractText", [""]))
        external_ids = self._extract_external_ids(pubmed_data.get("ArticleIdList", []))
        pmcid = external_ids.get("pmc")
        doi = external_ids.get("doi")
        full_text_url = f"https://pmc.ncbi.nlm.nih.gov/articles/{pmcid}/" if pmcid else (f"https://doi.org/{doi}" if doi else None)
        pdf_url = f"https://pmc.ncbi.nlm.nih.gov/articles/{pmcid}/pdf/" if pmcid else None

        return {
            "source": "pubmed",
            "title": title,
            "id": pmid,
            "pmid": pmid,
            "pmcid": pmcid,
            "doi": doi,
            "entry_id": None,
            "url": f"https://pubmed.ncbi.nlm.nih.gov/{pmid}/",
            "full_text_url": full_text_url,
            "pdf_url": pdf_url,
            "primary_category": None,
            "categories": [],
            "published": None,
            "summary": abstract[:500] + "..." if len(abstract) > 500 else abstract,
        }

    def _normalize_abstract(self, abstract: Any) -> str:
        if isinstance(abstract, list):
            return " ".join(str(item) for item in abstract).strip()
        return str(abstract).strip()

    def _parse_authors(self, author_list: Any) -> List[str]:
        authors: List[str] = []
        if not isinstance(author_list, list):
            return authors

        for author in author_list[:5]:
            if not isinstance(author, dict):
                continue
            fore_name = str(author.get("ForeName", "")).strip()
            last_name = str(author.get("LastName", "")).strip()
            name = f"{fore_name} {last_name}".strip()
            if name:
                authors.append(name)
        return authors

    def _extract_external_ids(self, article_id_list: Any) -> Dict[str, str]:
        ids: Dict[str, str] = {}
        if not isinstance(article_id_list, list):
            return ids

        for item in article_id_list:
            value = str(item).strip()
            if not value:
                continue
            id_type = ""
            attrs = getattr(item, "attributes", None)
            if isinstance(attrs, dict):
                id_type = str(attrs.get("IdType", "")).lower()
            elif isinstance(item, dict):
                id_type = str(item.get("IdType", "")).lower()

            if id_type in {"pubmed", "doi", "pmc", "pmcid"}:
                normalized = "pmc" if id_type == "pmcid" else id_type
                ids[normalized] = value
        return ids

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
