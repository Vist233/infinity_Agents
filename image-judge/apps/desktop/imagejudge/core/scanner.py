"""扫描器：遍历目录、过滤格式、路径规范化、哈希与去重（文档 §14.1）。"""
from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from pathlib import Path

from .. import config


@dataclass
class ScannedFile:
    path: str
    relative_path: str
    sha256: str
    size: int


def _natural_key(text: str):
    """相对路径自然排序，保证结果可复现（文档 §14.1）。"""
    parts = re.split(r"(\d+)", text)
    return [int(p) if p.isdigit() else p.lower() for p in parts]


def is_supported_image(path: Path) -> bool:
    return path.suffix.lower() in config.SUPPORTED_EXTENSIONS


def compute_sha256(path: Path, chunk_size: int = 1024 * 1024) -> str:
    """对原始文件计算 SHA-256（归一化前），用于去重与审计。"""
    h = hashlib.sha256()
    with path.open("rb") as f:
        while True:
            chunk = f.read(chunk_size)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def scan(
    input_path: Path,
    *,
    recursive: bool = True,
    input_type: str = "folder",
) -> list[ScannedFile]:
    """扫描单文件或文件夹，返回按自然排序的稳定列表。"""
    input_path = Path(input_path).resolve()
    results: list[ScannedFile] = []

    if input_type == "file":
        if input_path.is_file() and is_supported_image(input_path):
            results.append(
                ScannedFile(
                    path=str(input_path),
                    relative_path=input_path.name,
                    sha256=compute_sha256(input_path),
                    size=input_path.stat().st_size,
                )
            )
        return results

    if not input_path.is_dir():
        return results

    pattern = "**/*" if recursive else "*"
    candidates = [p for p in input_path.glob(pattern) if p.is_file() and is_supported_image(p)]
    for p in candidates:
        rel = p.relative_to(input_path).as_posix()
        results.append(
            ScannedFile(
                path=str(p),
                relative_path=rel,
                sha256=compute_sha256(p),
                size=p.stat().st_size,
            )
        )

    results.sort(key=lambda f: _natural_key(f.relative_path))
    return results


def split_duplicates(files: list[ScannedFile]) -> tuple[list[ScannedFile], list[ScannedFile]]:
    """同一 run 内相同哈希：首个保留，其余标记为重复（文档 Q09）。"""
    seen: set[str] = set()
    unique: list[ScannedFile] = []
    duplicates: list[ScannedFile] = []
    for f in files:
        if f.sha256 in seen:
            duplicates.append(f)
        else:
            seen.add(f.sha256)
            unique.append(f)
    return unique, duplicates
