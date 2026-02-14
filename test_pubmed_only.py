#!/usr/bin/env python3
"""
Test PubMed search ONLY - no ArXiv mixing.
Focus on verifying PMC PDF retrieval works correctly.
"""

import json
from Bio import Entrez

Entrez.email = "paper_agent@example.com"


def get_pmc_pdf_url(pmid: str) -> str:
    """Get PDF URL from PubMed Central (PMC) if available."""
    try:
        # Step 1: Check if this PMID has a PMC ID
        print(f"    Looking up PMC ID for PMID: {pmid}")
        handle = Entrez.elink(dbfrom="pubmed", db="pmc", id=pmid)
        link_results = Entrez.read(handle)
        handle.close()

        # Extract PMC ID
        pmc_id = None
        for linkset in link_results:
            for link in linkset.get("LinkSetDb", []):
                if link.get("DbTo") == "pmc":
                    for doc_id in link.get("Link", []):
                        pmc_id = doc_id.get("Id")
                        break
                if pmc_id:
                    break
            if pmc_id:
                break

        if not pmc_id:
            print(f"    ❌ No PMC ID found for PMID {pmid}")
            return None

        print(f"    ✓ Found PMC ID: {pmc_id}")

        # Step 2: Construct the PDF URL
        pdf_url = f"https://www.ncbi.nlm.nih.gov/pmc/articles/PMC{pmc_id}/pdf"
        print(f"    ✓ PDF URL: {pdf_url}")

        return pdf_url

    except Exception as e:
        print(f"    ❌ Error: {e}")
        return None


def search_pubmed_only(query: str, num_results: int = 5):
    """Search PubMed ONLY - no ArXiv."""
    print("=" * 70)
    print(f"PUBMED ONLY SEARCH: '{query}'")
    print("=" * 70)

    # Search PubMed
    print(f"\n1. Searching PubMed for: {query}")
    handle = Entrez.esearch(db="pubmed", term=query, retmax=num_results)
    record = Entrez.read(handle)
    handle.close()

    id_list = record.get("IdList", [])
    print(f"   ✓ Found {len(id_list)} papers")

    if not id_list:
        print("   ❌ No results found")
        return []

    # Fetch details
    print(f"\n2. Fetching details for {len(id_list)} papers...")
    handle = Entrez.efetch(db="pubmed", id=",".join(id_list), rettype="xml", retmode="xml")
    records = Entrez.read(handle)
    handle.close()
    print("   ✓ Details fetched")

    # Process each paper
    print(f"\n3. Processing papers and checking PMC PDF availability...")
    print("-" * 70)

    articles = []
    for i, article in enumerate(records.get("PubmedArticle", []), 1):
        medline = article.get("MedlineCitation", {})
        article_data = medline.get("Article", {})

        pmid = str(medline.get("PMID", ""))
        title = article_data.get("ArticleTitle", "")

        # Get abstract
        abstract = article_data.get("Abstract", {}).get("AbstractText", [""])
        if isinstance(abstract, list):
            abstract = " ".join(str(a) for a in abstract)

        # Get authors
        authors = []
        for author in article_data.get("AuthorList", [])[:5]:
            name = f"{author.get('ForeName', '')} {author.get('LastName', '')}".strip()
            if name:
                authors.append(name)

        print(f"\n[{i}] PMID: {pmid}")
        print(f"    Title: {title[:70]}..." if len(title) > 70 else f"    Title: {title}")

        # Get PMC PDF URL
        pdf_url = get_pmc_pdf_url(pmid)

        articles.append({
            "source": "pubmed",
            "title": title,
            "id": pmid,
            "pmid": pmid,
            "url": f"https://pubmed.ncbi.nlm.nih.gov/{pmid}/",
            "pdf_url": pdf_url,
            "authors": authors,
            "summary": abstract[:500] + "..." if len(abstract) > 500 else abstract,
        })

    # Summary
    print("\n" + "=" * 70)
    print("SUMMARY")
    print("=" * 70)

    with_pdf = sum(1 for a in articles if a.get("pdf_url"))
    without_pdf = len(articles) - with_pdf

    print(f"\nTotal papers: {len(articles)}")
    print(f"  ✓ With PMC PDF: {with_pdf}")
    print(f"  ✗ Without PDF: {without_pdf}")

    if with_pdf > 0:
        print(f"\n✓ Successfully retrieved {with_pdf} PMC PDF links!")
        print("  These papers can be downloaded just like ArXiv papers.")

    print("\n" + "=" * 70)

    return articles


if __name__ == "__main__":
    # Test with a real search
    query = "CRISPR gene editing therapy"
    results = search_pubmed_only(query, num_results=5)

    # Also test a COVID-19 search (high chance of PMC availability)
    print("\n\n")
    print("#" * 70)
    print("# ADDITIONAL TEST: COVID-19 (high PMC coverage)")
    print("#" * 70)
    results2 = search_pubmed_only("COVID-19 vaccine efficacy", num_results=5)
