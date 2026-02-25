"""
File System Tools - Atomic tools for browsing files, reading text, and resolving image refs.

Designed for PaperAgent to browse extracted papers, reports, and chart outputs.
Scoped to allowed directories only for safety.
"""

import json
import mimetypes
from pathlib import Path
from typing import Any, List, Optional

from agno.tools import Toolkit
from agno.utils.log import logger

from agent.tools.image_path_utils import normalize_image_locator, normalize_ref_path, to_img_ref

# Default allowed roots
PAPERS_DIR = Path(__file__).parent.parent.parent / "papers"
PLOT_OUTPUTS_DIR = Path(__file__).parent / "plot_outputs"
PLOTLY_OUTPUTS_DIR = Path(__file__).parent / "plotly_outputs"


class FileSystemTools(Toolkit):
    """Tools for listing files, reading text, and reading images as img:// refs.

    Access is restricted to a set of allowed directories for safety.
    """

    def __init__(
        self,
        allowed_dirs: Optional[List[Path]] = None,
        **kwargs,
    ):
        self.allowed_dirs = allowed_dirs or [
            PAPERS_DIR,
            PLOT_OUTPUTS_DIR,
            PLOTLY_OUTPUTS_DIR,
        ]
        # Ensure all allowed dirs exist
        for d in self.allowed_dirs:
            d.mkdir(parents=True, exist_ok=True)

        tools: List[Any] = [
            self.list_files,
            self.read_file,
            self.read_image,
        ]

        super().__init__(name="file_system_tools", tools=tools, **kwargs)

    def _is_path_allowed(self, path: Path) -> bool:
        """Check if a path is within allowed directories."""
        resolved = path.resolve()
        return any(
            resolved == allowed.resolve() or
            str(resolved).startswith(str(allowed.resolve()) + "/")
            for allowed in self.allowed_dirs
        )

    def _resolve_path(self, path_str: str) -> Optional[Path]:
        """Resolve a path string. Try absolute first, then relative to each allowed dir."""
        normalized = normalize_image_locator(path_str)
        if not normalized:
            return None
        p = Path(normalized)

        # If absolute and allowed, use directly
        if p.is_absolute():
            if self._is_path_allowed(p):
                return p
            return None

        # Try relative to each allowed dir
        for allowed in self.allowed_dirs:
            candidate = allowed / normalized
            if candidate.exists() and self._is_path_allowed(candidate):
                return candidate

        # Backward compatibility for basename-only references.
        if "/" not in normalized:
            for allowed in self.allowed_dirs:
                for candidate in allowed.rglob(normalized):
                    if candidate.exists() and candidate.is_file() and self._is_path_allowed(candidate):
                        return candidate

        return None

    def _to_relative_ref_path(self, target: Path) -> str:
        """Compute a stable relative path following allowed_dirs priority."""
        resolved = target.resolve()
        for allowed in self.allowed_dirs:
            try:
                return resolved.relative_to(allowed.resolve()).as_posix()
            except ValueError:
                continue
        return target.name

    def list_files(self, directory: str = "") -> str:
        """List files and subdirectories in the workspace.

        Args:
            directory (str, optional): Directory path to list. Can be:
                - Empty string to list all allowed root directories
                - An absolute path within allowed directories
                - A relative path (resolved against allowed directories)

        Returns:
            str: JSON with file listing including name, type, and size.
        """
        if not directory:
            # List all roots
            roots = []
            for d in self.allowed_dirs:
                if d.exists():
                    count = sum(1 for _ in d.rglob("*") if _.is_file())
                    roots.append({
                        "path": str(d),
                        "name": d.name,
                        "type": "directory",
                        "file_count": count,
                    })
            return json.dumps({"directories": roots}, indent=2, ensure_ascii=False)

        target = self._resolve_path(directory)
        if target is None:
            return json.dumps({
                "error": f"Path '{directory}' not found or not in allowed directories.",
                "allowed_directories": [str(d) for d in self.allowed_dirs],
            })

        if not target.exists():
            return json.dumps({"error": f"Path '{directory}' does not exist."})

        if not target.is_dir():
            return json.dumps({"error": f"Path '{directory}' is not a directory."})

        items = []
        try:
            for entry in sorted(target.iterdir()):
                item = {
                    "name": entry.name,
                    "type": "directory" if entry.is_dir() else "file",
                }
                if entry.is_file():
                    item["size_bytes"] = entry.stat().st_size
                    item["extension"] = entry.suffix
                elif entry.is_dir():
                    item["children"] = sum(1 for _ in entry.iterdir())
                items.append(item)
        except PermissionError:
            return json.dumps({"error": "Permission denied."})

        return json.dumps({
            "directory": str(target),
            "items": items,
            "total": len(items),
        }, indent=2, ensure_ascii=False)

    def read_file(self, file_path: str, max_chars: int = 50000) -> str:
        """Read the contents of a text file.

        Args:
            file_path (str): Path to the file. Can be absolute or relative.
            max_chars (int, optional): Maximum characters to read. Defaults to 50000.

        Returns:
            str: JSON with file contents or error.
        """
        target = self._resolve_path(file_path)
        if target is None:
            return json.dumps({
                "error": f"File '{file_path}' not found or not in allowed directories."
            })

        if not target.exists():
            return json.dumps({"error": f"File '{file_path}' does not exist."})

        if not target.is_file():
            return json.dumps({"error": f"'{file_path}' is not a file."})

        # Check if it's likely a text file
        mime_type, _ = mimetypes.guess_type(str(target))
        binary_extensions = {".pdf", ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".zip", ".tar", ".gz"}
        if target.suffix.lower() in binary_extensions:
            return json.dumps({
                "error": f"'{target.name}' is a binary file. Use read_image for images.",
                "suggestion": "Use read_image() for image files.",
            })

        try:
            text = target.read_text(encoding="utf-8", errors="replace")
            truncated = len(text) > max_chars
            if truncated:
                text = text[:max_chars]

            return json.dumps({
                "file_path": str(target),
                "file_name": target.name,
                "size_bytes": target.stat().st_size,
                "content": text,
                "truncated": truncated,
            }, indent=2, ensure_ascii=False)
        except Exception as e:
            return json.dumps({"error": f"Failed to read file: {e}"})

    def read_image(self, file_path: str) -> str:
        """Get information about an image file.

        Returns the file path and a standard Markdown image reference.
        The frontend will automatically handle rendering.

        Args:
            file_path (str): Path to the image file. Can be absolute or relative.

        Returns:
            str: JSON with file info and Markdown syntax.
        """
        target = self._resolve_path(file_path)
        if target is None:
            return json.dumps({
                "error": f"Image '{file_path}' not found or not in allowed directories.",
                "accepted_formats": [
                    "extracted/paper_x/images/fig.png",
                    "/absolute/path/to/fig.png",
                    "img://extracted/paper_x/images/fig.png",
                    "img://./extracted/paper_x/images/fig.png",
                    "![fig](img://extracted/paper_x/images/fig.png)",
                    "/api/sessions/{session_id}/files/extracted/paper_x/images/fig.png",
                ],
            })

        if not target.exists():
            return json.dumps({"error": f"Image '{file_path}' does not exist."})

        if not target.is_file():
            return json.dumps({"error": f"'{file_path}' is not a file."})

        # Determine MIME type
        image_types = {
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".gif": "image/gif",
            ".webp": "image/webp",
            ".svg": "image/svg+xml",
            ".bmp": "image/bmp",
        }

        ext = target.suffix.lower()
        mime = image_types.get(ext)
        if not mime:
            return json.dumps({
                "error": f"Unsupported image format: {ext}",
                "supported": list(image_types.keys()),
            })

        try:
            size_bytes = target.stat().st_size
            logger.info(f"Image {target.name} ({size_bytes} bytes)")
            normalized_input = normalize_image_locator(file_path)
            input_path = Path(normalized_input)
            if input_path.is_absolute():
                ref_path = self._to_relative_ref_path(target)
            elif "/" in normalized_input or "\\" in normalized_input:
                ref_path = normalize_ref_path(normalized_input)
            else:
                ref_path = target.name
            img_ref = to_img_ref(ref_path)

            return json.dumps({
                "file_name": target.name,
                "resolved_path": str(target.resolve()),
                "size_bytes": size_bytes,
                "mime_type": mime,
                "image_ref": img_ref,
                "markdown": f"![{target.stem}]({img_ref})",
            }, ensure_ascii=False)
        except Exception as e:
            return json.dumps({"error": f"Failed to read image info: {e}"})
