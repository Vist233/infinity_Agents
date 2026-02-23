"""
PDF Extractor - Extract text and images from PDF files.

Uses pypdf for text extraction and pymupdf (fitz) for image extraction.
"""

import hashlib
import re
from pathlib import Path
from typing import Optional, List, Dict, Tuple
from dataclasses import dataclass

try:
    from pypdf import PdfReader
except ImportError:
    raise ImportError("`pypdf` not installed. Please install using `pip install pypdf`")

try:
    import fitz  # pymupdf
except ImportError:
    raise ImportError("`pymupdf` not installed. Please install using `pip install pymupdf`")


@dataclass
class ExtractedContent:
    """Result of PDF extraction."""
    text: str
    pages: List[Dict]  # [{page_num, text, image_paths}]
    images_dir: Path
    image_count: int
    page_count: int


class PDFExtractor:
    """Extract text and images from PDF files."""
    
    def __init__(
        self,
        output_base_dir: Optional[Path] = None,
        min_image_size: int = 100,  # Minimum image dimension in pixels
        max_image_size: int = 5000,  # Maximum image dimension
    ):
        self.output_base_dir = output_base_dir or Path(__file__).parent.parent.parent / "papers"
        self.min_image_size = min_image_size
        self.max_image_size = max_image_size
    
    def _get_paper_dir(self, paper_id: str) -> Path:
        """Get the directory for a paper's extracted content."""
        paper_dir = self.output_base_dir / paper_id
        paper_dir.mkdir(parents=True, exist_ok=True)
        return paper_dir
    
    def _get_images_dir(self, paper_id: str) -> Path:
        """Get the directory for a paper's extracted images."""
        images_dir = self._get_paper_dir(paper_id) / "images"
        images_dir.mkdir(parents=True, exist_ok=True)
        return images_dir
    
    def generate_paper_id(self, pdf_path: str) -> str:
        """Generate a unique paper ID from file path or content hash."""
        path = Path(pdf_path)
        
        # Try to extract arXiv ID from filename
        arxiv_pattern = r"(\d{4}\.\d{4,5}(v\d+)?)"
        match = re.search(arxiv_pattern, path.stem)
        if match:
            return match.group(1).replace(".", "_")
        
        # Fall back to hash of filename
        return hashlib.md5(path.stem.encode()).hexdigest()[:12]
    
    def extract_text(self, pdf_path: Path) -> Tuple[str, List[Dict]]:
        """Extract text from PDF using pypdf.
        
        Returns:
            Tuple of (full_text, pages_list) where pages_list contains 
            {page_num, text} for each page.
        """
        reader = PdfReader(pdf_path)
        pages = []
        full_text_parts = []
        
        for page_num, page in enumerate(reader.pages, start=1):
            text = page.extract_text() or ""
            pages.append({
                "page_num": page_num,
                "text": text,
                "image_paths": [],
            })
            full_text_parts.append(f"--- Page {page_num} ---\n{text}")
        
        full_text = "\n\n".join(full_text_parts)
        return full_text, pages
    
    def extract_images(
        self,
        pdf_path: Path,
        paper_id: str,
        pages: List[Dict],
    ) -> int:
        """Extract images from PDF using pymupdf.
        
        Args:
            pdf_path: Path to PDF file
            paper_id: Paper identifier for organizing output
            pages: Pages list to update with image paths
            
        Returns:
            Number of images extracted
        """
        images_dir = self._get_images_dir(paper_id)
        doc = fitz.open(pdf_path)
        image_count = 0
        
        for page_num in range(len(doc)):
            page = doc.load_page(page_num)
            image_list = page.get_images()
            
            for img_idx, img in enumerate(image_list):
                xref = img[0]
                
                try:
                    base_image = doc.extract_image(xref)
                    image_bytes = base_image["image"]
                    image_ext = base_image["ext"]
                    width = base_image.get("width", 0)
                    height = base_image.get("height", 0)
                    
                    # Filter by size
                    if width < self.min_image_size or height < self.min_image_size:
                        continue
                    if width > self.max_image_size or height > self.max_image_size:
                        continue
                    
                    # Save image
                    image_filename = f"page{page_num + 1}_img{img_idx + 1}.{image_ext}"
                    image_path = images_dir / image_filename
                    
                    with open(image_path, "wb") as f:
                        f.write(image_bytes)
                    
                    # Update pages list
                    if page_num < len(pages):
                        pages[page_num]["image_paths"].append(str(image_path))
                    
                    image_count += 1
                    
                except Exception as e:
                    # Skip problematic images
                    continue
        
        doc.close()
        return image_count
    
    def extract(self, pdf_path: str, paper_id: Optional[str] = None) -> ExtractedContent:
        """Extract all content from a PDF.
        
        Args:
            pdf_path: Path to PDF file
            paper_id: Optional paper ID, will be generated if not provided
            
        Returns:
            ExtractedContent with text, pages, and image information
        """
        pdf_path = Path(pdf_path)
        if not pdf_path.exists():
            raise FileNotFoundError(f"PDF file not found: {pdf_path}")
        
        if paper_id is None:
            paper_id = self.generate_paper_id(str(pdf_path))
        
        # Extract text
        full_text, pages = self.extract_text(pdf_path)
        
        # Extract images
        images_dir = self._get_images_dir(paper_id)
        image_count = self.extract_images(pdf_path, paper_id, pages)
        
        return ExtractedContent(
            text=full_text,
            pages=pages,
            images_dir=images_dir,
            image_count=image_count,
            page_count=len(pages),
        )
    
    def get_image_paths(self, paper_id: str) -> List[Path]:
        """Get all extracted image paths for a paper."""
        images_dir = self._get_images_dir(paper_id)
        if not images_dir.exists():
            return []
        return sorted(images_dir.glob("*.*"))
