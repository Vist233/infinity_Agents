"""端到端集成测试：扫描 → 入库 → 领取 → 结果校验 → 落库 → CSV 投影。

不依赖 Qt 与网络，模拟任务引擎的核心数据流（文档 §14、§12、§13）。
"""
from __future__ import annotations

import csv
import json

from imagejudge.core.prompting import REPAIR_SUFFIX, build_messages_payload, build_user_prompt
from imagejudge.core.scanner import compute_sha256, scan, split_duplicates
from imagejudge.core.state_machine import RunStatus
from imagejudge.export.csv_sync import CSV_HEADER, CSVSyncer
from imagejudge.model.schemas import parse_evaluation_output

JPEG_BYTES = (
    b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00"
    b"\xff\xd9"
)


def _make_images(tmp_path):
    inputs = tmp_path / "inputs"
    inputs.mkdir()
    (inputs / "img2.jpg").write_bytes(JPEG_BYTES + b"2")
    (inputs / "img10.jpg").write_bytes(JPEG_BYTES + b"10")
    (inputs / "img1.jpg").write_bytes(JPEG_BYTES + b"1")
    # 与 img1 内容相同 → 重复
    (inputs / "img1_copy.jpg").write_bytes(JPEG_BYTES + b"1")
    # 不支持的格式
    (inputs / "notes.txt").write_text("not an image")
    # 子目录（recursive）
    sub = inputs / "sub"
    sub.mkdir()
    (sub / "img3.png").write_bytes(b"\x89PNG\r\n\x1a\nfake")
    return inputs


def test_scan_natural_order_and_dedup(tmp_path):
    inputs = _make_images(tmp_path)
    files = scan(inputs, recursive=True)
    rels = [f.relative_path for f in files]
    # 自然排序：img1 < img2 < img10；txt 被过滤；子目录被包含
    assert rels[0] == "img1.jpg"
    assert "img10.jpg" in rels
    assert rels.index("img2.jpg") < rels.index("img10.jpg")
    assert not any(r.endswith(".txt") for r in rels)
    assert "sub/img3.png" in rels

    unique, duplicates = split_duplicates(files)
    dup_names = {d.relative_path for d in duplicates}
    assert dup_names == {"img1_copy.jpg"}
    assert len(unique) == len(files) - 1


def test_scan_single_file(tmp_path):
    inputs = _make_images(tmp_path)
    files = scan(inputs / "img1.jpg", input_type="file")
    assert len(files) == 1
    assert files[0].sha256 == compute_sha256(inputs / "img1.jpg")


def test_full_pipeline_with_fake_model(repo, tmp_path, sample_output_text):
    """模拟一次完整 run：扫描入库 → 全部成功 → CSV 投影一致。"""
    inputs = _make_images(tmp_path)
    output_dir = tmp_path / "output"
    output_dir.mkdir()

    # ---- 扫描与去重 ----
    files = scan(inputs, recursive=True)
    unique, duplicates = split_duplicates(files)

    # ---- 建项目与 run ----
    reference = tmp_path / "reference.jpg"
    reference.write_bytes(JPEG_BYTES)
    project_id = repo.create_project(
        name="集成测试",
        reference_path=str(reference),
        reference_sha256=compute_sha256(reference),
        prompt_text="判断是否一致",
        prompt_version="2.0",
        model_id="qwen3-vl-235b-a22b-instruct",
    )
    run_id = repo.create_run(
        project_id=project_id,
        input_type="folder",
        input_path=str(inputs),
        recursive=True,
        output_dir=str(output_dir),
        csv_name="results_live.csv",
        timeout_seconds=60.0,
        max_retries=2,
    )
    repo.set_run_status(run_id, RunStatus.SCANNING)
    all_items = [{"path": f.path, "relative_path": f.relative_path, "sha256": f.sha256} for f in files]
    assert repo.insert_items(run_id, all_items) == len(files)
    repo.set_run_status(run_id, RunStatus.READY)
    repo.set_run_status(run_id, RunStatus.RUNNING)

    # ---- 重复项标记 SKIPPED（需要 item_id）----
    dup_paths = {d.path for d in duplicates}
    with repo.session() as s:
        from imagejudge.persistence.models import TaskItem
        from sqlalchemy import select

        dup_ids = [
            i.id
            for i in s.execute(select(TaskItem).where(TaskItem.run_id == run_id)).scalars()
            if i.path in dup_paths
        ]
    repo.mark_duplicate_skipped(run_id, dup_ids)

    # ---- 模拟引擎：逐项领取、"模型"返回、校验、落库 ----
    processed = 0
    while True:
        claimed = repo.claim_next_item(run_id)
        if claimed is None:
            break
        # 模拟模型原始输出并通过 Schema 校验
        output = parse_evaluation_output(sample_output_text)
        repo.set_client_request_id(claimed.item_id, f"req_{claimed.item_id}")
        repo.save_result_and_enqueue_export(
            item_id=claimed.item_id,
            task_type=output.task_type,
            predicted_category=output.predicted_category,
            result_status=output.status,
            reasoning_summary=output.reasoning_summary,
            detail_json=output.model_dump_json(),
            needs_human_review=output.review.required,
            review_reasons_json=output.review.reasons,
            spotting_features=[feature.model_dump() for feature in output.spotting_features],
            model_id="qwen3-vl-235b-a22b-instruct",
            request_id=f"srv_{claimed.item_id}",
            prompt_version="2.0",
            schema_version="2.0",
            latency_ms=100 + claimed.item_id,
        )
        processed += 1
    assert processed == len(unique)

    totals = repo.update_run_totals(run_id)
    assert totals["succeeded"] == len(unique)
    assert totals["skipped"] == len(duplicates)
    assert totals["total"] == len(files)
    repo.set_run_status(run_id, RunStatus.COMPLETED)

    # ---- CSV 投影 ----
    syncer = CSVSyncer(repo)
    while syncer.sync_pending() > 0:
        pass
    assert repo.pending_outbox_count(run_id) == 0

    csv_path = output_dir / "results_live.csv"
    rows = list(csv.reader(csv_path.read_text(encoding="utf-8-sig").splitlines()))
    assert rows[0] == CSV_HEADER
    assert len(rows) == 1 + len(files)
    skipped_rows = [r for r in rows[1:] if r[2] == "SKIPPED"]
    assert len(skipped_rows) == len(duplicates)
    assert all(r[5] == "DUPLICATE_SHA256" for r in skipped_rows)
    succeeded_rows = [r for r in rows[1:] if r[2] == "CLASSIFIED"]
    assert len(succeeded_rows) == len(unique)
    assert all(r[1] == "class_02" for r in succeeded_rows)


def test_prompt_bundle_contents():
    bundle = build_messages_payload("比较颜色是否一致")
    assert "REFERENCE" in bundle.system_prompt
    assert "TARGET" in bundle.system_prompt
    assert "比较颜色是否一致" in bundle.user_prompt
    assert bundle.prompt_version == "2.0"
    assert "CLASSIFIED" in bundle.system_prompt
    assert "spotting_features" in bundle.system_prompt
    # 空规则回退默认
    assert "category" in build_user_prompt("")
    # 修复后缀强调 JSON
    assert "JSON" in REPAIR_SUFFIX


def test_startup_recovery_then_resume(repo, tmp_path, sample_output_text):
    """模拟崩溃恢复：PROCESSING 回收、run 转 PAUSED、续跑完成。"""
    inputs = _make_images(tmp_path)
    reference = tmp_path / "ref.jpg"
    reference.write_bytes(JPEG_BYTES)
    project_id = repo.create_project(
        name="恢复测试", reference_path=str(reference), reference_sha256="b" * 64,
        prompt_text="", prompt_version="2.0", model_id="m",
    )
    run_id = repo.create_run(
        project_id=project_id, input_type="folder", input_path=str(inputs),
        recursive=False, output_dir=str(tmp_path), csv_name="r.csv",
        timeout_seconds=60, max_retries=1,
    )
    files = scan(inputs, recursive=False)
    repo.insert_items(run_id, [{"path": f.path, "relative_path": f.relative_path, "sha256": f.sha256} for f in files])
    repo.set_run_status(run_id, RunStatus.SCANNING)
    repo.set_run_status(run_id, RunStatus.READY)
    repo.set_run_status(run_id, RunStatus.RUNNING)
    repo.claim_next_item(run_id)  # 崩溃时遗留 PROCESSING

    report = repo.recover_on_startup()
    assert report["items_reclaimed"] == 1
    assert repo.get_run(run_id).status == RunStatus.PAUSED.value

    # 续跑
    repo.set_run_status(run_id, RunStatus.RUNNING)
    count = 0
    while True:
        claimed = repo.claim_next_item(run_id)
        if claimed is None:
            break
        out = parse_evaluation_output(sample_output_text)
        repo.save_result_and_enqueue_export(
            item_id=claimed.item_id,
            task_type=out.task_type,
            predicted_category=out.predicted_category,
            result_status=out.status,
            reasoning_summary=out.reasoning_summary,
            detail_json=out.model_dump_json(),
            needs_human_review=out.review.required,
            review_reasons_json=out.review.reasons,
            spotting_features=[feature.model_dump() for feature in out.spotting_features],
            model_id="m",
            request_id="",
            prompt_version="2.0",
            schema_version="2.0",
            latency_ms=1,
        )
        count += 1
    assert count == len(files)
    repo.set_run_status(run_id, RunStatus.COMPLETED)
    assert repo.update_run_totals(run_id)["succeeded"] == len(files)
