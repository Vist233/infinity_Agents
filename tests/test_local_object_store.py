from __future__ import annotations

import hashlib

import pytest

from backend.local_runtime.object_store import LocalObjectStore, ObjectStoreError


@pytest.fixture
def store(tmp_path):
    return LocalObjectStore(tmp_path / "objects")


def test_write_and_read_roundtrip(store, tmp_path):
    data = b"local-object-bytes" * 64
    size, sha256 = store.write_bytes("inputs/dataset/file.bin", data)
    assert size == len(data)
    assert sha256 == hashlib.sha256(data).hexdigest()
    path = store.read_path("inputs/dataset/file.bin")
    assert path.read_bytes() == data
    assert store.exists("inputs/dataset/file.bin")


def test_rejects_traversal_and_invalid_keys(store):
    for bad_key in ["", "/absolute", "a/../b", "a//b", "a\\b", "a:b", "."]:
        with pytest.raises(ObjectStoreError, match="OBJECT_KEY_INVALID"):
            store.resolve(bad_key)


def test_rejects_symlink_escape(store, tmp_path):
    outside = tmp_path / "outside.txt"
    outside.write_text("secret")
    link = store.root / "link"
    try:
        link.symlink_to(outside)
    except OSError:
        pytest.skip("symlinks unsupported on this platform")
    with pytest.raises(ObjectStoreError):
        store.read_path("link")


def test_write_stream_enforces_limit(store):
    async def chunks():
        for _ in range(4):
            yield b"x" * 1024

    import asyncio

    size, _ = asyncio.run(store.write_stream("stream/a.bin", chunks(), max_bytes=8192))
    assert size == 4096

    async def too_big():
        yield b"y" * 100

    with pytest.raises(ObjectStoreError, match="OBJECT_TOO_LARGE"):
        asyncio.run(store.write_stream("stream/b.bin", too_big(), max_bytes=10))


def test_multipart_assemble_and_cleanup(store):
    payload_a = b"part-one-" * 10
    payload_b = b"part-two-" * 10
    store.write_part("upload-1", 1, payload_a)
    store.write_part("upload-1", 2, payload_b)
    parts = store.iter_part_paths("upload-1", [1, 2])
    total, sha256 = store.assemble("task-artifacts/out.zip", parts, max_bytes=1 << 20)
    combined = payload_a + payload_b
    assert total == len(combined)
    assert sha256 == hashlib.sha256(combined).hexdigest()
    store.delete_parts("upload-1")
    assert not store.exists(store.part_key("upload-1", 1))
    store.delete("task-artifacts/out.zip")
    assert not store.exists("task-artifacts/out.zip")


def test_assemble_enforces_max_bytes(store):
    store.write_part("upload-2", 1, b"z" * 64)
    parts = store.iter_part_paths("upload-2", [1])
    with pytest.raises(ObjectStoreError, match="OBJECT_TOO_LARGE"):
        store.assemble("task-artifacts/big.zip", parts, max_bytes=8)
    assert not store.exists("task-artifacts/big.zip")
