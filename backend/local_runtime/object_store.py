"""Controlled local filesystem object store for Method/Dataset/Artifact bytes.

The database keeps only object keys, sizes, hashes and publication state; the
actual bytes live under a single configured root. Every path operation refuses
traversal, absolute keys, backslashes and symlinks so a malicious object key
can never read or write outside the store root.
"""

from __future__ import annotations

import hashlib
import os
import shutil
import uuid
from pathlib import Path
from typing import AsyncIterator, Iterable


class ObjectStoreError(RuntimeError):
    """The requested object operation is unsafe or unavailable."""


MAX_INPUT_BYTES = 25 * 1024 * 1024


def _validate_object_key(object_key: str) -> str:
    key = str(object_key or "").strip()
    if not key or len(key) > 512:
        raise ObjectStoreError("OBJECT_KEY_INVALID")
    if key.startswith("/") or "\\" in key or ":" in key:
        raise ObjectStoreError("OBJECT_KEY_INVALID")
    parts = key.split("/")
    if any(part in {"", ".", ".."} for part in parts):
        raise ObjectStoreError("OBJECT_KEY_INVALID")
    return key


class LocalObjectStore:
    def __init__(self, root: Path | str) -> None:
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        if not self.root.is_dir():
            raise ObjectStoreError("OBJECT_STORE_ROOT_INVALID")

    def resolve(self, object_key: str) -> Path:
        key = _validate_object_key(object_key)
        candidate = (self.root / key).resolve()
        if not candidate.is_relative_to(self.root):
            raise ObjectStoreError("OBJECT_KEY_ESCAPES_ROOT")
        for parent in candidate.parents:
            if parent == self.root:
                break
            if parent.is_symlink():
                raise ObjectStoreError("OBJECT_KEY_ESCAPES_ROOT")
        return candidate

    def _temporary_path(self, target: Path) -> Path:
        return target.with_name(f".{target.name}.{uuid.uuid4().hex}.part")

    def write_bytes(self, object_key: str, data: bytes, *, max_bytes: int = MAX_INPUT_BYTES) -> tuple[int, str]:
        if len(data) > max_bytes:
            raise ObjectStoreError("OBJECT_TOO_LARGE")
        target = self.resolve(object_key)
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = self._temporary_path(target)
        try:
            temporary.write_bytes(data)
            digest = hashlib.sha256(data).hexdigest()
            os.replace(temporary, target)
        except Exception:
            temporary.unlink(missing_ok=True)
            raise
        return len(data), digest

    async def write_stream(
        self,
        object_key: str,
        chunks: AsyncIterator[bytes],
        *,
        max_bytes: int,
    ) -> tuple[int, str]:
        target = self.resolve(object_key)
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = self._temporary_path(target)
        digest = hashlib.sha256()
        total = 0
        try:
            with temporary.open("wb") as handle:
                async for chunk in chunks:
                    total += len(chunk)
                    if total > max_bytes:
                        raise ObjectStoreError("OBJECT_TOO_LARGE")
                    digest.update(chunk)
                    handle.write(chunk)
            os.replace(temporary, target)
        except Exception:
            temporary.unlink(missing_ok=True)
            raise
        return total, digest.hexdigest()

    def read_path(self, object_key: str) -> Path:
        target = self.resolve(object_key)
        if not target.is_file() or target.is_symlink():
            raise ObjectStoreError("OBJECT_NOT_FOUND")
        return target

    def exists(self, object_key: str) -> bool:
        try:
            target = self.resolve(object_key)
        except ObjectStoreError:
            return False
        return target.is_file() and not target.is_symlink()

    def delete(self, object_key: str) -> None:
        try:
            target = self.resolve(object_key)
        except ObjectStoreError:
            return
        if target.is_file() and not target.is_symlink():
            target.unlink(missing_ok=True)

    def part_key(self, upload_id: str, part_number: int) -> str:
        return f"task-artifacts/parts/{_validate_object_key(upload_id)}/{part_number:05d}"

    def write_part(self, upload_id: str, part_number: int, data: bytes) -> tuple[int, str]:
        return self.write_bytes(self.part_key(upload_id, part_number), data, max_bytes=len(data))

    def iter_part_paths(self, upload_id: str, part_numbers: Iterable[int]) -> list[Path]:
        return [self.read_path(self.part_key(upload_id, part_number)) for part_number in part_numbers]

    def delete_parts(self, upload_id: str) -> None:
        try:
            directory = self.resolve(f"task-artifacts/parts/{_validate_object_key(upload_id)}")
        except ObjectStoreError:
            return
        if directory.is_dir() and not directory.is_symlink():
            shutil.rmtree(directory, ignore_errors=True)

    def assemble(
        self,
        object_key: str,
        part_paths: list[Path],
        *,
        max_bytes: int,
    ) -> tuple[int, str]:
        """Concatenate parts into the final object while hashing the stream."""
        target = self.resolve(object_key)
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = self._temporary_path(target)
        digest = hashlib.sha256()
        total = 0
        try:
            with temporary.open("wb") as handle:
                for part in part_paths:
                    if part.is_symlink() or not part.is_file():
                        raise ObjectStoreError("ARTIFACT_PART_MISSING")
                    with part.open("rb") as source:
                        while True:
                            chunk = source.read(1024 * 1024)
                            if not chunk:
                                break
                            total += len(chunk)
                            if total > max_bytes:
                                raise ObjectStoreError("OBJECT_TOO_LARGE")
                            digest.update(chunk)
                            handle.write(chunk)
            os.replace(temporary, target)
        except Exception:
            temporary.unlink(missing_ok=True)
            raise
        return total, digest.hexdigest()
