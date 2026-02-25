"""Utilities for normalizing image locators into local relative/absolute paths."""

from __future__ import annotations

import re
from urllib.parse import unquote, urlparse

_MARKDOWN_IMAGE_RE = re.compile(r"!\[[^\]]*\]\(([^)]+)\)")
_DEST_WITH_TITLE_RE = re.compile(r'^\s*(<[^>]+>|[^ \t]+)(?:\s+["\'][^"\']*["\'])?\s*$')
_SESSION_FILE_URL_RE = re.compile(r"/api/sessions/[^/]+/files/(.+)")
_GLOBAL_FILE_URL_RE = re.compile(r"/api/files/(.+)")


def _normalize_slashes(path: str) -> str:
    return path.replace("\\", "/")


def normalize_ref_path(path: str) -> str:
    """Normalize a path segment used inside img:// refs."""
    normalized = _normalize_slashes(unquote(str(path or "").strip()))
    while normalized.startswith("./"):
        normalized = normalized[2:]
    return normalized.lstrip("/")


def to_img_ref(path: str) -> str:
    """Build canonical image reference: img://./<normalized-path>."""
    return f"img://./{normalize_ref_path(path)}"


def _strip_markdown_wrapper(raw: str) -> str:
    match = _MARKDOWN_IMAGE_RE.search(raw)
    if not match:
        return raw
    destination = match.group(1).strip()
    title_match = _DEST_WITH_TITLE_RE.match(destination)
    if title_match:
        destination = title_match.group(1).strip()
    if destination.startswith("<") and destination.endswith(">"):
        destination = destination[1:-1].strip()
    return destination


def normalize_image_locator(raw_input: str) -> str:
    """Normalize image locators from multiple formats into local file paths.

    Supported input forms:
    - relative path: extracted/paper_x/images/fig.png
    - absolute path: /abs/path/to/fig.png
    - img:// reference: img://./extracted/paper_x/images/fig.png
    - markdown image: ![fig](img://./extracted/paper_x/images/fig.png)
    - frontend API URL: /api/sessions/{id}/files/extracted/... or /api/files/extracted/...
    """
    raw = str(raw_input or "").strip()
    if not raw:
        return ""

    raw = _strip_markdown_wrapper(raw).strip().strip("\"'")
    if not raw:
        return ""

    if raw.startswith("img://"):
        payload = raw[len("img://"):].split("?", 1)[0].split("#", 1)[0]
        return normalize_ref_path(payload)

    parsed = urlparse(raw)
    if parsed.scheme in {"http", "https"}:
        path = parsed.path or ""
        session_match = _SESSION_FILE_URL_RE.search(path)
        if session_match:
            return normalize_ref_path(session_match.group(1))
        global_match = _GLOBAL_FILE_URL_RE.search(path)
        if global_match:
            return normalize_ref_path(global_match.group(1))
        return _normalize_slashes(unquote(raw))

    if not parsed.scheme and raw.startswith("/api/sessions/"):
        session_match = _SESSION_FILE_URL_RE.search(raw)
        if session_match:
            return normalize_ref_path(session_match.group(1))
    if not parsed.scheme and raw.startswith("/api/files/"):
        global_match = _GLOBAL_FILE_URL_RE.search(raw)
        if global_match:
            return normalize_ref_path(global_match.group(1))

    return _normalize_slashes(unquote(raw))
