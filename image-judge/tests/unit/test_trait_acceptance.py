import json

from imagejudge.model.traits import TraitDefinition
from imagejudge.model.trait_acceptance import TraitBatchAcceptance


def test_trait_acceptance_persists_500_inputs_and_resumes_without_duplicate_rows(tmp_path):
    inputs = []
    for index in range(498):
        path = tmp_path / f"nested-{index // 100}" / f"样本-{index:04d}.png"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(f"controlled-{index}".encode())
        inputs.append(path)
    duplicate = tmp_path / "duplicate.png"
    duplicate.write_bytes(b"controlled-0")
    unsupported = tmp_path / "notes.txt"
    unsupported.write_text("not an image", encoding="utf-8")
    inputs.extend([duplicate, unsupported])
    definition = TraitDefinition(
        trait_id="leaf_class", version="1.0", name="Leaf class", type="category",
        allowed_values=("healthy", "review"), protocol="controlled local rubric",
    )
    runner = TraitBatchAcceptance(tmp_path / "run.sqlite", tmp_path / "evidence")
    first = runner.run(inputs, definition, run_id="trait-500")
    second = runner.run(inputs, definition, run_id="trait-500")
    assert first["total"] == second["total"] == 500
    assert second["statuses"]["REVIEW"] == 498
    assert second["statuses"]["SKIPPED"] == 1
    assert second["statuses"]["UNSUPPORTED"] == 1
    rows = runner.repository.list_trait_observations("trait-500")
    assert len(rows) == 500
    assert len({row.image_id for row in rows}) == 500
    qc = json.loads((tmp_path / "evidence" / "qc.json").read_text(encoding="utf-8"))
    assert qc["absolute_paths_in_evidence"] is False


def test_trait_acceptance_never_assigns_confidence_without_calibration(tmp_path):
    path = tmp_path / "one.png"
    path.write_bytes(b"fixture")
    definition = TraitDefinition(
        trait_id="height", version="1.0", name="Height", type="continuous", unit="mm",
        protocol="requires scale", calibration_required=True,
    )
    result = TraitBatchAcceptance(tmp_path / "run.sqlite", tmp_path / "evidence").run([path], definition, run_id="calibration")
    assert result["statuses"]["UNSUPPORTED"] == 1
