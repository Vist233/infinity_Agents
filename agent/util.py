"""
Shared utilities for infinity_Agents.

Includes context management, middleware, and common helpers.
"""

import hashlib
import json
import time
from pathlib import Path
from typing import Any, Dict, List, Optional
from dataclasses import dataclass, field


# ============================================================================
# Path Constants
# ============================================================================

AGENT_DIR = Path(__file__).parent
TOOLS_DIR = AGENT_DIR / "tools"
CACHE_DIR = TOOLS_DIR / "cache"
PLOTLY_OUTPUT_DIR = TOOLS_DIR / "plotly_outputs"
PLOT_OUTPUT_DIR = TOOLS_DIR / "plot_outputs"
ARXIV_PDF_DIR = TOOLS_DIR / "arxiv_pdfs"


def ensure_directories():
    """Ensure all required directories exist."""
    for directory in [CACHE_DIR, PLOTLY_OUTPUT_DIR, PLOT_OUTPUT_DIR, ARXIV_PDF_DIR]:
        directory.mkdir(parents=True, exist_ok=True)


# ============================================================================
# Paper Reference for Context Management
# ============================================================================

@dataclass
class PaperReference:
    """Compressed paper reference for context management."""
    url: str
    title: str
    abstract: str
    paper_id: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "url": self.url,
            "title": self.title,
            "abstract": self.abstract,
            "paper_id": self.paper_id,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "PaperReference":
        return cls(
            url=data.get("url", ""),
            title=data.get("title", ""),
            abstract=data.get("abstract", ""),
            paper_id=data.get("paper_id"),
        )


@dataclass
class ToolCallRecord:
    """Record of a tool call for context management."""
    tool_name: str
    arguments: Dict[str, Any]
    result_summary: str
    paper_references: List[PaperReference] = field(default_factory=list)
    is_compressed: bool = False


# ============================================================================
# Cache Utilities
# ============================================================================

class SimpleCache:
    """Simple file-based cache with TTL."""

    def __init__(self, cache_dir: Optional[Path] = None, ttl_seconds: int = 3600):
        self.cache_dir = cache_dir or CACHE_DIR
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.ttl_seconds = ttl_seconds

    def _get_key(self, *args, **kwargs) -> str:
        """Generate cache key from arguments."""
        data = f"{args}:{sorted(kwargs.items())}"
        return hashlib.md5(data.encode()).hexdigest()

    def get(self, *args, **kwargs) -> Optional[str]:
        """Get cached value if not expired."""
        key = self._get_key(*args, **kwargs)
        cache_file = self.cache_dir / f"{key}.json"

        if cache_file.exists():
            try:
                with open(cache_file, "r", encoding="utf-8") as f:
                    cached = json.load(f)
                if time.time() - cached.get("ts", 0) < self.ttl_seconds:
                    return cached.get("data")
            except Exception:
                pass
        return None

    def set(self, value: str, *args, **kwargs) -> None:
        """Cache a value."""
        key = self._get_key(*args, **kwargs)
        cache_file = self.cache_dir / f"{key}.json"

        try:
            with open(cache_file, "w", encoding="utf-8") as f:
                json.dump({"ts": time.time(), "data": value}, f)
        except Exception:
            pass

    def clear(self) -> int:
        """Clear all cached files. Returns number of files deleted."""
        count = 0
        for cache_file in self.cache_dir.glob("*.json"):
            try:
                cache_file.unlink()
                count += 1
            except Exception:
                pass
        return count


# ============================================================================
# Token Estimation
# ============================================================================

def estimate_tokens(text: str, chars_per_token: float = 4.0) -> int:
    """
    Estimate token count from text.
    
    Args:
        text: Input text.
        chars_per_token: Average characters per token (default 4 for English).
    
    Returns:
        Estimated token count.
    """
    return int(len(text) / chars_per_token)


def estimate_message_tokens(messages: List[Dict]) -> int:
    """Estimate total tokens in a message list."""
    text = json.dumps(messages, ensure_ascii=False)
    return estimate_tokens(text)


# ============================================================================
# Image Utilities
# ============================================================================

import base64

SUPPORTED_IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".bmp", ".webp", ".heic", ".tif", ".tiff"}


def is_supported_image(path: Path) -> bool:
    """Check if file is a supported image type."""
    return path.suffix.lower() in SUPPORTED_IMAGE_EXTENSIONS


def encode_image_base64(image_path: str) -> str:
    """Encode image file to base64."""
    with open(image_path, "rb") as f:
        return base64.b64encode(f.read()).decode("utf-8")


def get_image_mime_type(image_path: str) -> str:
    """Get MIME type from image file extension."""
    ext = Path(image_path).suffix.lower()
    mime_map = {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".bmp": "image/bmp",
        ".webp": "image/webp",
        ".heic": "image/heic",
        ".tif": "image/tiff",
        ".tiff": "image/tiff",
    }
    return mime_map.get(ext, "application/octet-stream")


def image_to_data_url(image_path: str) -> str:
    """Convert image file to data URL."""
    mime_type = get_image_mime_type(image_path)
    base64_data = encode_image_base64(image_path)
    return f"data:{mime_type};base64,{base64_data}"


# Initialize directories on import
ensure_directories()
