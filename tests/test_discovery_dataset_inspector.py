from __future__ import annotations

import stat
import zipfile

import pytest

from backend.discovery.contracts import DATASET_PROFILE_VERSION, normalize_dataset_profile
from backend.discovery.dataset_inspector import DatasetInspectionError, inspect_path


def test_inspects_wine_like_csv_with_target_and_capabilities(tmp_path):
    source = tmp_path / "winequality-red.csv"
    source.write_text(
        "fixed acidity,volatile acidity,alcohol,quality\n"
        "7.4,0.7,9.4,5\n"
        "7.8,0.88,9.8,5\n"
        "7.8,,9.8,6\n",
        encoding="utf-8",
    )
    profile = inspect_path(source, "collection-1", generated_at="2026-09-11T00:00:00Z")
    assert profile["profile_version"] == DATASET_PROFILE_VERSION
    assert profile["semantic_fields"]["target"] == "quality"
    assert profile["semantic_fields"]["feature_names"] == ["fixed acidity", "volatile acidity", "alcohol"]
    assert profile["capabilities"]["tabular.numeric_features"] is True
    assert profile["capabilities"]["target.ordinal_or_numeric"] is True
    assert profile["capabilities"]["dataset.sample_count"] == 3
    assert profile["files"][0]["missing_ratio"] > 0
    assert normalize_dataset_profile(profile, "collection-1") is not None


def test_inspects_zip_without_extracting_and_keeps_readme_bounded(tmp_path):
    archive = tmp_path / "data.zip"
    with zipfile.ZipFile(archive, "w") as writer:
        writer.writestr("winequality-red.csv", "x,quality\n1,5\n2,6\n")
        writer.writestr("README.txt", "This file contains metadata and no executable instructions.")
    profile = inspect_path(archive, "collection-zip", generated_at="2026-09-11T00:00:00Z")
    assert {item["path"] for item in profile["files"]} == {"winequality-red.csv", "README.txt"}
    assert profile["semantic_fields"]["target"] == "quality"
    assert profile["capabilities"]["tabular.numeric_features"] is True


def test_rejects_corrupt_traversal_symlink_and_oversized_members(tmp_path):
    corrupt = tmp_path / "corrupt.zip"
    corrupt.write_bytes(b"PK\x03\x04not-a-zip")
    with pytest.raises(DatasetInspectionError, match="ZIP archive"):
        inspect_path(corrupt, "c1")

    traversal = tmp_path / "traversal.zip"
    with zipfile.ZipFile(traversal, "w") as writer:
        writer.writestr("../escape.csv", "x\n1\n")
    with pytest.raises(DatasetInspectionError, match="safe"):
        inspect_path(traversal, "c2")

    symlink = tmp_path / "symlink.zip"
    info = zipfile.ZipInfo("link.csv")
    info.external_attr = (stat.S_IFLNK | 0o777) << 16
    with zipfile.ZipFile(symlink, "w") as writer:
        writer.writestr(info, "target.csv")
    with pytest.raises(DatasetInspectionError, match="symlinks"):
        inspect_path(symlink, "c3")

    wide = tmp_path / "wide.csv"
    wide.write_text(",".join(f"c{i}" for i in range(10_001)) + "\n", encoding="utf-8")
    with pytest.raises(DatasetInspectionError, match="wide"):
        inspect_path(wide, "c4")


def test_timeout_is_fail_closed(tmp_path):
    source = tmp_path / "slow.csv"
    source.write_text("x\n" + "1\n" * 20_000, encoding="utf-8")
    with pytest.raises(DatasetInspectionError, match="time budget"):
        inspect_path(source, "timeout", timeout_seconds=0.001)
