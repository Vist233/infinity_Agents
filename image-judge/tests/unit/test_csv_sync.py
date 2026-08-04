"""CSV 原子快照与 outbox 消费测试。"""
from __future__ import annotations

import csv
from pathlib import Path

from imagejudge.export.csv_sync import (
    CSV_HEADER,
    CSVSyncer,
    build_row,
    rebuild_csv,
    write_snapshot_atomic,
)


def test_write_snapshot_atomic_bom_crlf(tmp_path):
    csv_path = tmp_path / "out.csv"
    write_snapshot_atomic(csv_path, [["1", "a.jpg"], ["2", "b.jpg"]])
    raw = csv_path.read_bytes()
    assert raw.startswith(b"\xef\xbb\xbf")
    text = raw.decode("utf-8-sig")
    assert "\r\n" in text
    lines = text.strip().split("\r\n")
    assert len(lines) == 3
    assert not list(tmp_path.glob("*.tmp"))


def test_write_snapshot_replaces_existing(tmp_path):
    csv_path = tmp_path / "out.csv"
    write_snapshot_atomic(csv_path, [["1"]])
    write_snapshot_atomic(csv_path, [["2"], ["3"]])
    rows = list(csv.reader(csv_path.read_text(encoding="utf-8-sig").splitlines()))
    assert rows[1:] == [["2"], ["3"]]


def test_csv_header_matches_user_projection():
    assert CSV_HEADER == [
        "图片ID",
        "预测类别",
        "状态",
        "需Review",
        "Reasoning摘要",
        "错误类型",
        "错误说明",
    ]


class _FakeItem:
    id = 42
    path = "/data/inputs/img1.jpg"
    relative_path = "img1.jpg"
    sha256 = "1" * 64
    status = "SUCCEEDED"
    attempt_count = 1
    duration_ms = 500
    finished_at = None
    error_code = ""
    error_message = ""


class _FakeResult:
    predicted_category = "class_02"
    result_status = "REVIEW"
    reasoning_summary = "关键轮廓不确定"
    review_reasons_json = '["关键特征不清楚"]'
    detail_json = '{"spotting_features": []}'
    needs_human_review = 1
    model_id = "qwen3-vl-235b-a22b-instruct"
    request_id = "req_x"


def test_build_row_fields():
    row = build_row(7, _FakeItem(), _FakeResult(), "2026-01-01 00:00:00")
    assert row[0] == "42"
    assert row[1] == "class_02"
    assert row[2] == "REVIEW"
    assert row[3] == "是"
    assert "关键轮廓不确定" in row[4]
    assert "关键特征不清楚" in row[4]
    assert row[5] == ""
    assert row[6] == ""
    assert len(row) == len(CSV_HEADER)


def test_build_row_without_result():
    item = _FakeItem()
    item.status = "FAILED"
    item.error_code = "MODEL_ERROR"
    item.error_message = "上游模型失败"
    row = build_row(1, item, None, "")
    assert row[0] == "42"
    assert row[2] == "FAILED"
    assert row[3] == "否"
    assert row[5] == "MODEL_ERROR"
    assert row[6] == "上游模型失败"


def test_rebuild_csv_from_repo(repo, run_with_items, tmp_path):
    run_id = run_with_items
    claimed = repo.claim_next_item(run_id)
    repo.save_result_and_enqueue_export(
        item_id=claimed.item_id,
        task_type="CLASSIFICATION",
        predicted_category="class_02",
        result_status="CLASSIFIED",
        reasoning_summary="ok",
        detail_json='{"spotting_features": []}',
        needs_human_review=False,
        review_reasons_json=[],
        spotting_features=[],
        model_id="m",
        request_id="r1",
        prompt_version="2.0",
        schema_version="2.0",
        latency_ms=10,
    )
    csv_path = tmp_path / "results_live.csv"
    count = rebuild_csv(repo, run_id, csv_path)
    assert count == 3
    rows = list(csv.reader(csv_path.read_text(encoding="utf-8-sig").splitlines()))
    assert rows[0] == CSV_HEADER
    assert len(rows) == 4
    assert any(r[2] == "CLASSIFIED" and r[1] == "class_02" for r in rows[1:])


def test_csv_syncer_consumes_outbox(repo, run_with_items, tmp_path):
    run_id = run_with_items
    from imagejudge.persistence.models import TaskRun

    with repo.session() as s, s.begin():
        s.get(TaskRun, run_id).output_dir = str(tmp_path)

    claimed = repo.claim_next_item(run_id)
    repo.save_result_and_enqueue_export(
        item_id=claimed.item_id,
        task_type="CLASSIFICATION",
        predicted_category="class_03",
        result_status="REVIEW",
        reasoning_summary="需要人工确认",
        detail_json="{}",
        needs_human_review=True,
        review_reasons_json=["目标图模糊"],
        spotting_features=[],
        model_id="m",
        request_id="r2",
        prompt_version="2.0",
        schema_version="2.0",
        latency_ms=5,
    )
    assert repo.pending_outbox_count(run_id) == 1

    syncer = CSVSyncer(repo)
    processed = syncer.sync_pending()
    assert processed == 1
    assert repo.pending_outbox_count(run_id) == 0

    csv_path = tmp_path / "results_live.csv"
    assert csv_path.exists()
    state = repo.get_export_state(run_id)
    assert state is not None
    assert Path(state.csv_path) == csv_path
    assert state.status == "OK"
    assert syncer.sync_pending() == 0
