#!/usr/bin/env python3
"""Quick test of the standalone PubMed search tool."""

import sys
sys.path.insert(0, '/Users/zhangyvjing/iCloud/Code/infinity_Agents')

from agent.tools.pubmed_search import PubMedSearchTools, search_pubmed

print("=" * 70)
print("Testing Standalone PubMed Search Tool")
print("=" * 70)

# Method 1: Using the class
print("\n--- Method 1: Using PubMedSearchTools class ---")
tool = PubMedSearchTools()

print("\nSearching for: 'COVID-19 vaccine'")
results = tool.search_papers("COVID-19 vaccine", num_results=5)

print(f"Found {len(results)} papers")
for i, paper in enumerate(results, 1):
    has_pdf = "✓ PDF" if paper.get("pdf_url") else "✗ No PDF"
    print(f"\n[{i}] PMID: {paper['pmid']} [{has_pdf}]")
    print(f"    Title: {paper['title'][:60]}...")
    if paper.get("pdf_url"):
        print(f"    PDF: {paper['pdf_url']}")

# Statistics
with_pdf = sum(1 for r in results if r.get("pdf_url"))
print(f"\n{'='*70}")
print(f"Summary: {with_pdf}/{len(results)} papers have PMC PDF")
print(f"{'='*70}")

# Method 2: Using convenience function
print("\n\n--- Method 2: Using search_pubmed() function ---")
print("Searching for: 'cancer immunotherapy'")
results2 = search_pubmed("cancer immunotherapy", num_results=3)
print(f"Found {len(results2)} papers")
for paper in results2:
    print(f"- {paper['pmid']}: {paper['title'][:50]}...")

print("\n✓ PubMed tool test completed!")
