#!/usr/bin/env python3
"""Test PubMed PMC PDF retrieval."""

from Bio import Entrez
import json

Entrez.email = "test@example.com"

def get_pmc_pdf_url(pmid: str) -> str:
    """Get PDF URL from PubMed Central."""
    try:
        # Step 1: Check if this PMID has a PMC ID
        print(f"\n1. Looking up PMC ID for PMID: {pmid}")
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
            print(f"   ❌ No PMC ID found for PMID {pmid}")
            return None
        
        print(f"   ✓ Found PMC ID: {pmc_id}")
        
        # Step 2: Construct the PDF URL
        # The standard format for PMC PDF URLs
        pdf_url = f"https://www.ncbi.nlm.nih.gov/pmc/articles/PMC{pmc_id}/pdf"
        print(f"   ✓ PDF URL: {pdf_url}")
        
        return pdf_url
        
    except Exception as e:
        print(f"   ❌ Error: {e}")
        return None


def test_search():
    """Test search with PMC PDF retrieval."""
    print("=" * 60)
    print("Testing PubMed Search with PMC PDF Retrieval")
    print("=" * 60)
    
    # Search for COVID-19 papers
    query = "COVID-19 vaccine"
    print(f"\nSearching for: {query}")
    
    handle = Entrez.esearch(db="pubmed", term=query, retmax=5)
    record = Entrez.read(handle)
    handle.close()
    
    id_list = record.get("IdList", [])
    print(f"Found {len(id_list)} papers")
    
    # Get details for each paper
    handle = Entrez.efetch(db="pubmed", id=",".join(id_list), rettype="xml", retmode="xml")
    records = Entrez.read(handle)
    handle.close()
    
    results = []
    for article in records.get("PubmedArticle", []):
        medline = article.get("MedlineCitation", {})
        article_data = medline.get("Article", {})
        
        pmid = str(medline.get("PMID", ""))
        title = article_data.get("ArticleTitle", "")
        
        # Get PMC PDF URL
        pdf_url = get_pmc_pdf_url(pmid)
        
        results.append({
            "pmid": pmid,
            "title": title[:80] + "..." if len(title) > 80 else title,
            "has_pdf": pdf_url is not None,
            "pdf_url": pdf_url,
        })
    
    # Print summary
    print("\n" + "=" * 60)
    print("Results Summary")
    print("=" * 60)
    
    for i, r in enumerate(results, 1):
        status = "✓ PDF" if r["has_pdf"] else "✗ No PDF"
        print(f"\n{i}. PMID: {r['pmid']} [{status}]")
        print(f"   Title: {r['title']}")
        if r["pdf_url"]:
            print(f"   PDF: {r['pdf_url']}")
    
    # Statistics
    with_pdf = sum(1 for r in results if r["has_pdf"])
    print(f"\n{'=' * 60}")
    print(f"Statistics: {with_pdf}/{len(results)} papers have PMC PDF")
    print("=" * 60)


if __name__ == "__main__":
    test_search()
