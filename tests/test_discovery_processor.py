from __future__ import annotations

import io
import hashlib
import zipfile

import pytest

from backend.discovery.client import DiscoveryGrant
from backend.discovery.dataset_inspector import DatasetInspectionError
from backend.discovery.processor import process_one


class FakeDiscoveryClient:
    def __init__(self, source: bytes, filename: str) -> None:
        self.grant = DiscoveryGrant("collection", "collection-1", "lease-token-123456", 1, 2_000_000_000)
        self.source = source
        self.filename = filename
        self.input_calls = 0
        self.saved_profile = None
        self.failed = None

    def poll(self):
        grant, self.grant = self.grant, None
        return grant

    def input(self, grant):
        self.input_calls += 1
        return {
            "kind": "collection",
            "collection_id": grant.work_id,
            "source_filename": self.filename,
            "source_size_bytes": len(self.source),
            "source_sha256": hashlib.sha256(self.source).hexdigest(),
        }

    def input_source(self, grant, maximum_bytes):
        assert len(self.source) <= maximum_bytes
        return self.source

    def input_source_to_file(self, grant, destination, maximum_bytes):
        assert len(self.source) <= maximum_bytes
        destination.write_bytes(self.source)
        return len(self.source), hashlib.sha256(self.source).hexdigest()

    def save_dataset_profile(self, grant, profile):
        self.saved_profile = profile
        return {"status": "ready"}

    def fail(self, grant, code, spam_status=None):
        self.failed = (code, spam_status)
        return {"status": "failed"}


def test_processor_preserves_edge_filename_for_zip_and_saves_profile(tmp_path):
    source = io.BytesIO()
    with zipfile.ZipFile(source, "w") as archive:
        archive.writestr("winequality-red.csv", "x,quality\n1,5\n2,6\n")
    client = FakeDiscoveryClient(source.getvalue(), "uploads/wine-data.zip")

    assert process_one(client, work_root=tmp_path) is True
    assert client.input_calls == 1
    assert client.saved_profile is not None
    assert client.saved_profile["files"][0]["path"] == "winequality-red.csv"
    assert client.failed is None


def test_processor_rejects_source_integrity_mismatch(tmp_path):
    client = FakeDiscoveryClient(b"a,b\n1,2\n", "data.csv")

    def mismatched_input(grant):
        return {
            "kind": "collection",
            "collection_id": grant.work_id,
            "source_filename": client.filename,
            "source_size_bytes": len(client.source) + 1,
            "source_sha256": hashlib.sha256(client.source).hexdigest(),
        }

    client.input = mismatched_input
    with pytest.raises(DatasetInspectionError, match="frozen Edge metadata"):
        process_one(client, work_root=tmp_path)
    assert client.saved_profile is None
    assert client.failed == ("DATASET_SOURCE_CHECKSUM_MISMATCH", None)
