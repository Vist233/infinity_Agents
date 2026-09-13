from __future__ import annotations

from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "reassemble-r7-worker-image.ps1"
PART_PREFIX = "infinity-agents-worker-r7-8m-piece-part-"
PART_COUNT = 49
PART_BYTES = 8 * 1024 * 1024
ARCHIVE_BYTES = 406_582_272
ARCHIVE_SHA256 = "bdd3073f097da34d3226ea1f2d9b6182d0b5fa1bf9ede54412d4b2950a623774"


def expected_inventory() -> list[tuple[str, int]]:
    final_bytes = ARCHIVE_BYTES - (PART_COUNT - 1) * PART_BYTES
    return [
        (
            f"{PART_PREFIX}{index:03d}",
            PART_BYTES if index < PART_COUNT - 1 else final_bytes,
        )
        for index in range(PART_COUNT)
    ]


def test_known_r7_inventory_is_49_parts_and_matches_archive_size() -> None:
    inventory = expected_inventory()

    assert len(inventory) == 49
    assert inventory[0] == (f"{PART_PREFIX}000", PART_BYTES)
    assert inventory[-1] == (f"{PART_PREFIX}048", 3_929_088)
    assert sum(size for _, size in inventory) == ARCHIVE_BYTES


def test_a_reported_40_part_snapshot_is_rejected_as_incomplete() -> None:
    inventory = expected_inventory()
    observed_names = {name for name, _ in inventory[:40]}
    expected_names = {name for name, _ in inventory}

    assert expected_names - observed_names == {
        f"{PART_PREFIX}{index:03d}" for index in range(40, 49)
    }


def test_legacy_partial_name_is_not_an_accepted_r7_piece() -> None:
    accepted_names = {name for name, _ in expected_inventory()}

    assert "infinity-agents-worker-r7-piece-000" not in accepted_names


def test_script_has_non_overwriting_hash_gate_before_optional_docker_load() -> None:
    source = SCRIPT.read_text(encoding="utf-8")

    assert f"$PartCount = {PART_COUNT}" in source
    assert f"$ExpectedArchiveBytes = {ARCHIVE_BYTES}" in source
    assert ARCHIVE_SHA256 in source
    assert "[IO.FileMode]::CreateNew" in source
    assert "Move-Item -LiteralPath $temporaryPath -Destination $archivePath" in source
    assert "Get-FileHash -LiteralPath $temporaryPath -Algorithm SHA256" in source
    assert "if ($LoadDocker)" in source
    assert source.index("$candidateHash") < source.index("if ($LoadDocker)")
