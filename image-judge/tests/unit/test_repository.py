"""Repository 事务、状态迁移与完整结构化结果持久化测试。"""
from __future__ import annotations

from datetime import timedelta

import pytest

from imagejudge.core.state_machine import (
    IllegalTransitionError,
    ItemStatus,
    OutboxStatus,
    RunStatus,
)
from imagejudge.persistence.models import utcnow


def _save(repo, item_id, *, category="class_02", status="CLASSIFIED", review=False, features=None):
    return repo.save_result_and_enqueue_export(
        item_id=item_id,
        task_type="CLASSIFICATION",
        predicted_category=category,
        result_status=status,
        reasoning_summary="结构化摘要",
        detail_json='{"candidate_categories": [], "spotting_features": []}',
        needs_human_review=review,
        review_reasons_json=["需要人工确认"] if review else [],
        spotting_features=features or [],
        model_id="m",
        request_id="req_1",
        prompt_version="2.0",
        schema_version="2.0",
        latency_ms=123,
    )


# ---------------------------------------------------------------------------
# 项目与 run 状态
# ---------------------------------------------------------------------------
def test_create_and_get_project(repo):
    pid = repo.create_project(
        name="p",
        reference_path="/tmp/ref.jpg",
        reference_sha256="a" * 64,
        prompt_text="t",
        prompt_version="2.0",
        model_id="m",
    )
    p = repo.get_project(pid)
    assert p is not None and p.name == "p"


def test_set_run_status_enforces_state_machine(repo, run_with_items):
    run_id = run_with_items
    with pytest.raises(IllegalTransitionError):
        repo.set_run_status(run_id, RunStatus.RUNNING)
    repo.set_run_status(run_id, RunStatus.SCANNING)
    repo.set_run_status(run_id, RunStatus.READY)
    repo.set_run_status(run_id, RunStatus.RUNNING)
    run = repo.get_run(run_id)
    assert run.status == RunStatus.RUNNING.value
    assert run.started_at is not None
    repo.set_run_status(run_id, RunStatus.READY, force=True)
    assert repo.get_run(run_id).status == RunStatus.READY.value


# ---------------------------------------------------------------------------
# 插入与领取
# ---------------------------------------------------------------------------
def test_insert_items_dedup_same_path(repo, run_with_items, tmp_path):
    run_id = run_with_items
    before = repo.update_run_totals(run_id)["total"]
    assert before == 3
    dup = [{"path": str(tmp_path / "inputs" / "img1.jpg")}]
    assert repo.insert_items(run_id, dup) == 0
    assert repo.update_run_totals(run_id)["total"] == 3


def test_claim_next_item_pending(repo, run_with_items):
    run_id = run_with_items
    claimed = repo.claim_next_item(run_id)
    assert claimed is not None
    assert claimed.attempt_count == 0
    item = repo.get_item(claimed.item_id)
    assert item.status == ItemStatus.PROCESSING.value
    assert repo.update_run_totals(run_id)["pending"] == 2


def test_claim_next_item_exhausted(repo, run_with_items):
    for _ in range(3):
        assert repo.claim_next_item(run_with_items) is not None
    assert repo.claim_next_item(run_with_items) is None


def test_claim_retry_wait_respects_next_retry_at(repo, run_with_items):
    first = repo.claim_next_item(run_with_items)
    second = repo.claim_next_item(run_with_items)
    third = repo.claim_next_item(run_with_items)
    repo.mark_item_failed(second.item_id, error_code="X", error_message="y")
    repo.mark_item_failed(third.item_id, error_code="X", error_message="y")
    repo.mark_item_retry_wait(
        first.item_id,
        utcnow() + timedelta(hours=1),
        error_code="RATE_LIMITED",
        error_message="限流",
    )
    assert repo.claim_next_item(run_with_items) is None
    from imagejudge.persistence.models import TaskItem

    with repo.session() as s, s.begin():
        s.get(TaskItem, first.item_id).next_retry_at = utcnow() - timedelta(seconds=1)
    again = repo.claim_next_item(run_with_items)
    assert again is not None and again.item_id == first.item_id
    assert again.attempt_count == 1
    assert repo.get_item(first.item_id).status == ItemStatus.PROCESSING.value


# ---------------------------------------------------------------------------
# 结果入库与 outbox（同一事务）
# ---------------------------------------------------------------------------
def test_save_result_and_enqueue_export(repo, run_with_items):
    claimed = repo.claim_next_item(run_with_items)
    features = [
        {
            "feature_id": "top_closed",
            "state": "PRESENT",
            "evidence": "顶部轮廓连续闭合",
            "supports": ["class_02"],
            "contradicts": ["class_01"],
        },
        {
            "feature_id": "side_open",
            "state": "UNCLEAR",
            "evidence": "侧边被阴影遮挡",
            "supports": [],
            "contradicts": [],
        },
    ]
    result_id = _save(repo, claimed.item_id, review=True, features=features)
    assert result_id > 0
    item = repo.get_item(claimed.item_id)
    assert item.status == ItemStatus.SUCCEEDED.value
    assert repo.pending_outbox_count(run_with_items) == 1
    result = repo.get_result_for_item(claimed.item_id)
    assert result is not None
    assert result.result_status == "CLASSIFIED"
    assert result.predicted_category == "class_02"
    stored = repo.get_spotting_features_for_result(result.id)
    assert [feature.feature_id for feature in stored] == ["top_closed", "side_open"]
    assert stored[0].supports_json == '["class_02"]'


def test_save_result_requires_processing(repo, run_with_items):
    claimed = repo.claim_next_item(run_with_items)
    _save(repo, claimed.item_id)
    with pytest.raises(IllegalTransitionError):
        _save(repo, claimed.item_id)


def test_mark_item_failed_and_requeue(repo, run_with_items):
    claimed = repo.claim_next_item(run_with_items)
    repo.mark_item_failed(claimed.item_id, error_code="MODEL_ERROR", error_message="boom")
    item = repo.get_item(claimed.item_id)
    assert item.status == ItemStatus.FAILED.value
    assert item.attempt_count == 1
    assert repo.pending_outbox_count(run_with_items) == 1
    assert repo.requeue_failed(run_with_items) == 1
    assert repo.get_item(claimed.item_id).status == ItemStatus.PENDING.value


def test_mark_duplicate_skipped(repo, run_with_items):
    assert repo.update_run_totals(run_with_items)["skipped"] == 0
    repo.mark_duplicate_skipped(run_with_items, [1, 2])
    assert repo.get_item(1).status == ItemStatus.SKIPPED.value
    assert repo.get_item(1).error_code == "DUPLICATE_SHA256"


def test_mark_item_cancelled(repo, run_with_items):
    repo.claim_next_item(run_with_items)
    cancelled = repo.mark_item_cancelled(run_with_items)
    assert cancelled == 2
    assert repo.update_run_totals(run_with_items)["cancelled"] == 2


# ---------------------------------------------------------------------------
# 启动恢复与 outbox
# ---------------------------------------------------------------------------
def test_recover_on_startup(repo, run_with_items):
    run_id = run_with_items
    repo.set_run_status(run_id, RunStatus.SCANNING)
    repo.set_run_status(run_id, RunStatus.READY)
    repo.set_run_status(run_id, RunStatus.RUNNING)
    repo.claim_next_item(run_id)
    report = repo.recover_on_startup()
    assert report["items_reclaimed"] == 1
    assert report["runs_paused"] == 1
    assert repo.get_run(run_id).status == RunStatus.PAUSED.value
    assert any(r.id == run_id for r in repo.find_resumable_runs())


def test_outbox_retry_backoff_blocks_immediate_claim(repo, run_with_items):
    claimed = repo.claim_next_item(run_with_items)
    _save(repo, claimed.item_id)
    ev = repo.next_pending_outbox()
    assert ev is not None and ev.status == OutboxStatus.PROCESSING.value
    repo.finish_outbox(ev.id, ok=False, error="file locked")
    assert repo.next_pending_outbox() is None
    assert repo.pending_outbox_count(run_with_items) == 1


def test_mark_pending_outbox_synced(repo, run_with_items):
    claimed = repo.claim_next_item(run_with_items)
    repo.mark_item_failed(claimed.item_id, error_code="X", error_message="y")
    assert repo.pending_outbox_count(run_with_items) == 1
    assert repo.mark_pending_outbox_synced(run_with_items) == 1
    assert repo.pending_outbox_count(run_with_items) == 0


def test_update_run_totals_review_count(repo, run_with_items):
    claimed = repo.claim_next_item(run_with_items)
    _save(repo, claimed.item_id, status="REVIEW", review=True)
    totals = repo.update_run_totals(run_with_items)
    assert totals["succeeded"] == 1
    assert totals["review"] == 1
    assert totals["total"] == 3


def test_settings_roundtrip(repo):
    assert repo.get_setting("k") is None
    repo.set_setting("k", '{"a": 1}')
    assert repo.get_setting("k") == '{"a": 1}'
    repo.set_setting("k", '{"a": 2}')
    assert repo.get_setting("k") == '{"a": 2}'
