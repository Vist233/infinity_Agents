from __future__ import annotations

from imagejudge.model.traits import TraitBatchExtractor, TraitDefinition, make_observation


def test_uncalibrated_physical_trait_is_not_fabricated():
    definition = TraitDefinition(
        trait_id="plant_height", version="1.0", name="Plant height",
        type="continuous", unit="mm", protocol="image + scale", calibration_required=True,
    )
    observation = make_observation(
        definition, run_id="run-1", image_id="a.png", specimen_id="a",
        value=123.4, unit="mm", calibrated=False, confidence=0.99,
    )
    assert observation.value is None
    assert observation.calibrated_confidence is None
    assert observation.review_status == "UNSUPPORTED"
    assert "CALIBRATION_REQUIRED" in observation.quality_flags


def test_category_and_allowed_values_are_structured():
    definition = TraitDefinition(
        trait_id="leaf_shape", version="1.0", name="Leaf shape",
        type="category", allowed_values=("round", "lanceolate"), protocol="visual rubric",
    )
    observation = make_observation(
        definition, run_id="run-1", image_id="a.png", specimen_id="a",
        value="round", model_or_rule_version="rule-v1",
    )
    assert observation.value == "round"
    assert observation.unit is None
    assert "CONFIDENCE_UNAVAILABLE" in observation.quality_flags


def test_batch_extractor_is_resumable_and_deduplicates(tmp_path):
    definition = TraitDefinition(
        trait_id="leaf_count", version="1.0", name="Leaf count",
        type="count", unit="count", protocol="count visible leaves",
    )
    image = tmp_path / "sample.png"
    image.write_bytes(b"not-a-real-png-but-a-readable-fixture")
    unsupported = tmp_path / "notes.txt"
    unsupported.write_text("ignore", encoding="utf-8")
    observations = TraitBatchExtractor().extract(
        [image, image, unsupported], definition, run_id="run-1",
    )
    assert len(observations) == 2
    assert all(item.image_id.startswith("image-") for item in observations)
    assert all(item.calibrated_confidence is None for item in observations)


def test_batch_extractor_handles_500_images_without_duplicate_rows(tmp_path):
    definition = TraitDefinition(
        trait_id="specimen_count", version="1.0", name="Specimen count",
        type="count", unit="count", protocol="local review",
    )
    paths = []
    for index in range(500):
        path = tmp_path / f"image-{index:04d}.png"
        path.write_bytes(b"controlled-image-fixture")
        paths.append(path)
    observations = TraitBatchExtractor().extract(paths + paths[:10], definition, run_id="run-500")
    assert len(observations) == 500
    assert len({item.image_id for item in observations}) == 500
