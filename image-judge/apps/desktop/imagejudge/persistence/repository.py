"""Repository：SQLite 事务、状态迁移、查询与 outbox。

所有业务写入集中在此层：
- 结果入库与 CSV 导出事件必须位于同一 SQLite 事务（文档 §12.3）。
- 状态迁移前校验合法性（state_machine）。
- 启动恢复：遗留 PROCESSING 回收为 PENDING。
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from datetime import timedelta
from pathlib import Path

from sqlalchemy import func, select, update

from ..core.state_machine import (
    IllegalTransitionError,
    ItemStatus,
    OutboxStatus,
    RunStatus,
    can_transition_item,
    can_transition_outbox,
    can_transition_run,
)
from .db import get_session_factory
from .models import (
    AppSetting,
    EvaluationResult,
    ExportOutbox,
    ExportState,
    EvaluationSpottingFeature,
    Project,
    TaskItem,
    TaskRun,
    TraitDefinitionRecord,
    TraitObservationRecord,
    utcnow,
)
from ..model.traits import TraitDefinition, TraitObservation

logger = logging.getLogger("imagejudge.repository")


@dataclass
class ClaimedItem:
    """领取到的待处理项。"""

    item_id: int
    run_id: int
    path: str
    relative_path: str
    sha256: str
    attempt_count: int


class Repository:
    def __init__(self, db_path: Path | None = None):
        self._session_factory = get_session_factory(db_path)

    def session(self):
        return self._session_factory()

    # ------------------------------------------------------------------
    # 项目与运行
    # ------------------------------------------------------------------
    def create_project(
        self,
        *,
        name: str,
        reference_path: str,
        reference_sha256: str,
        prompt_text: str,
        prompt_version: str,
        model_id: str,
    ) -> int:
        with self.session() as s, s.begin():
            p = Project(
                name=name,
                reference_path=reference_path,
                reference_sha256=reference_sha256,
                prompt_text=prompt_text,
                prompt_version=prompt_version,
                model_id=model_id,
            )
            s.add(p)
        return p.id

    def get_project(self, project_id: int) -> Project | None:
        with self.session() as s:
            return s.get(Project, project_id)

    def create_run(
        self,
        *,
        project_id: int,
        input_type: str,
        input_path: str,
        recursive: bool,
        output_dir: str,
        csv_name: str,
        timeout_seconds: float,
        max_retries: int,
    ) -> int:
        with self.session() as s, s.begin():
            run = TaskRun(
                project_id=project_id,
                input_type=input_type,
                input_path=input_path,
                recursive=1 if recursive else 0,
                output_dir=output_dir,
                csv_name=csv_name,
                status=RunStatus.DRAFT.value,
                timeout_seconds=timeout_seconds,
                max_retries=max_retries,
            )
            s.add(run)
        return run.id

    def get_run(self, run_id: int) -> TaskRun | None:
        with self.session() as s:
            return s.get(TaskRun, run_id)

    def set_run_status(self, run_id: int, target: RunStatus, *, force: bool = False) -> None:
        with self.session() as s, s.begin():
            run = s.get(TaskRun, run_id)
            if run is None:
                raise ValueError(f"run {run_id} 不存在")
            current = RunStatus(run.status)
            if not force and not can_transition_run(current, target):
                raise IllegalTransitionError("task_run", current, target)
            run.status = target.value
            if target == RunStatus.RUNNING and run.started_at is None:
                run.started_at = utcnow()
            if target in (
                RunStatus.COMPLETED,
                RunStatus.COMPLETED_WITH_ERRORS,
                RunStatus.STOPPED,
                RunStatus.FAILED,
            ):
                run.finished_at = utcnow()

    def update_run_totals(self, run_id: int) -> dict:
        """按 task_items 重新统计（不信任缓存计数，文档 §15.3）。"""
        with self.session() as s, s.begin():
            rows = s.execute(
                select(TaskItem.status, func.count(TaskItem.id))
                .where(TaskItem.run_id == run_id)
                .group_by(TaskItem.status)
            ).all()
            counts = {status: n for status, n in rows}
            review = s.scalar(
                select(func.count(EvaluationResult.id))
                .join(TaskItem, TaskItem.id == EvaluationResult.item_id)
                .where(TaskItem.run_id == run_id, EvaluationResult.needs_human_review == 1)
            ) or 0
            run = s.get(TaskRun, run_id)
            if run is not None:
                run.total = sum(counts.values())
                run.succeeded = counts.get(ItemStatus.SUCCEEDED.value, 0)
                run.failed = counts.get(ItemStatus.FAILED.value, 0)
                run.review = review
            return {
                "total": sum(counts.values()),
                "succeeded": counts.get(ItemStatus.SUCCEEDED.value, 0),
                "failed": counts.get(ItemStatus.FAILED.value, 0),
                "review": review,
                "processing": counts.get(ItemStatus.PROCESSING.value, 0),
                "pending": counts.get(ItemStatus.PENDING.value, 0)
                + counts.get(ItemStatus.RETRY_WAIT.value, 0),
                "skipped": counts.get(ItemStatus.SKIPPED.value, 0),
                "cancelled": counts.get(ItemStatus.CANCELLED.value, 0),
            }

    # ------------------------------------------------------------------
    # 扫描与批量插入
    # ------------------------------------------------------------------
    def insert_items(self, run_id: int, items: list[dict]) -> int:
        """批量插入 task_items；同 run 内重复路径跳过。"""
        inserted = 0
        with self.session() as s, s.begin():
            existing = {
                p
                for (p,) in s.execute(
                    select(TaskItem.path).where(TaskItem.run_id == run_id)
                ).all()
            }
            for it in items:
                if it["path"] in existing:
                    continue
                s.add(
                    TaskItem(
                        run_id=run_id,
                        path=it["path"],
                        relative_path=it.get("relative_path", ""),
                        sha256=it.get("sha256", ""),
                        status=ItemStatus.PENDING.value,
                    )
                )
                existing.add(it["path"])
                inserted += 1
        return inserted

    def mark_duplicate_skipped(self, run_id: int, item_ids: list[int]) -> None:
        """同一 run 内相同哈希的重复项标记 SKIPPED（文档 §14.1/Q09）。"""
        if not item_ids:
            return
        with self.session() as s, s.begin():
            s.execute(
                update(TaskItem)
                .where(TaskItem.id.in_(item_ids), TaskItem.status == ItemStatus.PENDING.value)
                .values(status=ItemStatus.SKIPPED.value, error_code="DUPLICATE_SHA256")
            )

    # ------------------------------------------------------------------
    # 领取与结果入库
    # ------------------------------------------------------------------
    def claim_next_item(self, run_id: int) -> ClaimedItem | None:
        """领取一个 PENDING 或已到期的 RETRY_WAIT 项并置为 PROCESSING。"""
        now = utcnow()
        with self.session() as s, s.begin():
            candidate = s.execute(
                select(TaskItem)
                .where(TaskItem.run_id == run_id)
                .where(
                    (TaskItem.status == ItemStatus.PENDING.value)
                    | (
                        (TaskItem.status == ItemStatus.RETRY_WAIT.value)
                        & (TaskItem.next_retry_at <= now)
                    )
                )
                .order_by(TaskItem.id)
                .limit(1)
            ).scalar_one_or_none()
            if candidate is None:
                return None
            current = ItemStatus(candidate.status)
            if current == ItemStatus.RETRY_WAIT.value:
                candidate.status = ItemStatus.PENDING.value
                current = ItemStatus.PENDING
            if not can_transition_item(current, ItemStatus.PROCESSING):
                return None
            candidate.status = ItemStatus.PROCESSING.value
            return ClaimedItem(
                item_id=candidate.id,
                run_id=candidate.run_id,
                path=candidate.path,
                relative_path=candidate.relative_path,
                sha256=candidate.sha256,
                attempt_count=candidate.attempt_count,
            )

    def set_client_request_id(self, item_id: int, client_request_id: str) -> None:
        """请求发出前写入 client_request_id（幂等，文档 §15.2）。"""
        with self.session() as s, s.begin():
            s.execute(
                update(TaskItem)
                .where(TaskItem.id == item_id)
                .values(client_request_id=client_request_id)
            )

    def save_result_and_enqueue_export(
        self,
        *,
        item_id: int,
        task_type: str = "CLASSIFICATION",
        predicted_category: str = "",
        result_status: str = "",
        reasoning_summary: str = "",
        detail_json: str = "{}",
        needs_human_review: bool = False,
        review_reasons_json: str | list[str] = "[]",
        spotting_features: list[dict] | None = None,
        model_id: str = "",
        request_id: str = "",
        prompt_version: str = "2.0",
        schema_version: str = "2.0",
        latency_ms: int = 0,
        diagnostics: str = "",
    ) -> int:
        """文档 §12.3 关键事务：结果 + outbox 事件同一事务提交。"""
        if not isinstance(review_reasons_json, str):
            review_reasons_json = json.dumps(review_reasons_json, ensure_ascii=False)
        with self.session() as s, s.begin():
            item = s.get(TaskItem, item_id)
            if item is None:
                raise ValueError(f"item {item_id} 不存在")
            if item.status != ItemStatus.PROCESSING.value:
                raise IllegalTransitionError(
                    "task_item", ItemStatus(item.status), ItemStatus.SUCCEEDED
                )
            item.status = ItemStatus.SUCCEEDED.value
            item.finished_at = utcnow()
            item.duration_ms = latency_ms
            item.error_code = ""
            item.error_message = ""
            result = EvaluationResult(
                item_id=item_id,
                task_type=task_type,
                predicted_category=predicted_category,
                result_status=result_status,
                reasoning_summary=reasoning_summary,
                review_reasons_json=review_reasons_json,
                detail_json=detail_json,
                needs_human_review=1 if needs_human_review else 0,
                model_id=model_id,
                request_id=request_id,
                prompt_version=prompt_version,
                schema_version=schema_version,
                latency_ms=latency_ms,
                diagnostics=diagnostics,
            )
            s.add(result)
            s.flush()
            for index, feature in enumerate(spotting_features or []):
                feature = dict(feature)
                s.add(
                    EvaluationSpottingFeature(
                        evaluation_result_id=result.id,
                        feature_id=str(feature.get("feature_id", "")),
                        state=str(feature.get("state", "UNCLEAR")),
                        evidence=str(feature.get("evidence", "")),
                        supports_json=json.dumps(
                            feature.get("supports", []), ensure_ascii=False
                        ),
                        contradicts_json=json.dumps(
                            feature.get("contradicts", []), ensure_ascii=False
                        ),
                        sort_order=index,
                    )
                )
            s.add(
                ExportOutbox(
                    run_id=item.run_id,
                    item_id=item_id,
                    event_type="UPSERT_CSV_ROW",
                    status=OutboxStatus.PENDING.value,
                )
            )
        return result.id

    def mark_item_failed(
        self, item_id: int, *, error_code: str, error_message: str, latency_ms: int = 0
    ) -> None:
        with self.session() as s, s.begin():
            item = s.get(TaskItem, item_id)
            if item is None:
                return
            item.status = ItemStatus.FAILED.value
            item.attempt_count += 1
            item.finished_at = utcnow()
            item.duration_ms = latency_ms
            item.error_code = error_code
            item.error_message = error_message[:4000]
            s.add(
                ExportOutbox(
                    run_id=item.run_id,
                    item_id=item_id,
                    event_type="UPSERT_CSV_ROW",
                    status=OutboxStatus.PENDING.value,
                )
            )

    def mark_item_retry_wait(
        self, item_id: int, next_retry_at, *, error_code: str, error_message: str
    ) -> None:
        with self.session() as s, s.begin():
            item = s.get(TaskItem, item_id)
            if item is None:
                return
            item.status = ItemStatus.RETRY_WAIT.value
            item.attempt_count += 1
            item.next_retry_at = next_retry_at
            item.error_code = error_code
            item.error_message = error_message[:4000]

    def mark_item_cancelled(self, run_id: int) -> int:
        """停止时把尚未发出的 PENDING/RETRY_WAIT 置为 CANCELLED。"""
        with self.session() as s, s.begin():
            res = s.execute(
                update(TaskItem)
                .where(
                    TaskItem.run_id == run_id,
                    TaskItem.status.in_(
                        [ItemStatus.PENDING.value, ItemStatus.RETRY_WAIT.value]
                    ),
                )
                .values(status=ItemStatus.CANCELLED.value, finished_at=utcnow())
            )
            return res.rowcount or 0

    def requeue_failed(self, run_id: int) -> int:
        """“重试失败”：FAILED -> PENDING。"""
        with self.session() as s, s.begin():
            res = s.execute(
                update(TaskItem)
                .where(TaskItem.run_id == run_id, TaskItem.status == ItemStatus.FAILED.value)
                .values(
                    status=ItemStatus.PENDING.value,
                    next_retry_at=None,
                    error_code="",
                    error_message="",
                )
            )
            return res.rowcount or 0

    def has_more_retry_wait(self, run_id: int) -> bool:
        with self.session() as s:
            n = s.scalar(
                select(func.count(TaskItem.id)).where(
                    TaskItem.run_id == run_id,
                    TaskItem.status == ItemStatus.RETRY_WAIT.value,
                )
            )
            return bool(n)

    # ------------------------------------------------------------------
    # 启动恢复（文档 §15.3）
    # ------------------------------------------------------------------
    def recover_on_startup(self) -> dict:
        """回收遗留 PROCESSING、归位未正常结束的 run、重置 outbox PROCESSING。"""
        report = {"items_reclaimed": 0, "runs_paused": 0, "outbox_reset": 0}
        with self.session() as s, s.begin():
            res = s.execute(
                update(TaskItem)
                .where(TaskItem.status == ItemStatus.PROCESSING.value)
                .values(status=ItemStatus.PENDING.value, next_retry_at=None)
            )
            report["items_reclaimed"] = res.rowcount or 0

            res = s.execute(
                update(TaskRun)
                .where(
                    TaskRun.status.in_(
                        [
                            RunStatus.RUNNING.value,
                            RunStatus.STOPPING.value,
                            RunStatus.SCANNING.value,
                        ]
                    )
                )
                .values(status=RunStatus.PAUSED.value)
            )
            report["runs_paused"] = res.rowcount or 0

            res = s.execute(
                update(ExportOutbox)
                .where(ExportOutbox.status == OutboxStatus.PROCESSING.value)
                .values(status=OutboxStatus.RETRY_WAIT.value)
            )
            report["outbox_reset"] = res.rowcount or 0
        if any(report.values()):
            logger.info("启动恢复: %s", report)
        return report

    def find_resumable_runs(self) -> list[TaskRun]:
        with self.session() as s:
            return list(
                s.execute(
                    select(TaskRun)
                    .where(
                        TaskRun.status.in_(
                            [
                                RunStatus.READY.value,
                                RunStatus.PAUSED.value,
                                RunStatus.STOPPED.value,
                                RunStatus.COMPLETED_WITH_ERRORS.value,
                                RunStatus.FAILED.value,
                            ]
                        )
                    )
                    .order_by(TaskRun.id.desc())
                    .limit(20)
                ).scalars()
            )

    # ------------------------------------------------------------------
    # 查询（UI / CSV）
    # ------------------------------------------------------------------
    def get_item(self, item_id: int) -> TaskItem | None:
        with self.session() as s:
            return s.get(TaskItem, item_id)

    def get_result_for_item(self, item_id: int) -> EvaluationResult | None:
        with self.session() as s:
            return s.execute(
                select(EvaluationResult).where(EvaluationResult.item_id == item_id)
            ).scalar_one_or_none()

    def get_spotting_features_for_result(self, result_id: int) -> list[EvaluationSpottingFeature]:
        """读取已规范化保存的逐项视觉特征。"""
        with self.session() as s:
            return list(
                s.execute(
                    select(EvaluationSpottingFeature)
                    .where(EvaluationSpottingFeature.evaluation_result_id == result_id)
                    .order_by(EvaluationSpottingFeature.sort_order, EvaluationSpottingFeature.id)
                ).scalars()
            )

    def list_items_with_results(self, run_id: int) -> list[dict]:
        """CSV 快照与结果表共用的行查询（按 id 稳定排序）。"""
        with self.session() as s:
            rows = s.execute(
                select(TaskItem, EvaluationResult)
                .join(EvaluationResult, EvaluationResult.item_id == TaskItem.id, isouter=True)
                .where(TaskItem.run_id == run_id)
                .order_by(TaskItem.id)
            ).all()
            out = []
            for item, result in rows:
                out.append({"item": item, "result": result})
            return out

    # ------------------------------------------------------------------
    # outbox / export_state
    # ------------------------------------------------------------------
    def next_pending_outbox(self) -> ExportOutbox | None:
        """领取最早的 PENDING / 已到退避期的 RETRY_WAIT outbox 事件并置为 PROCESSING。"""
        with self.session() as s, s.begin():
            ev = s.execute(
                select(ExportOutbox)
                .where(
                    ExportOutbox.status.in_(
                        [OutboxStatus.PENDING.value, OutboxStatus.RETRY_WAIT.value]
                    )
                )
                .order_by(ExportOutbox.id)
                .limit(1)
            ).scalar_one_or_none()
            if ev is None:
                return None
            current = OutboxStatus(ev.status)
            if current == OutboxStatus.RETRY_WAIT.value:
                # 指数退避：未到重试时间则本次不领取
                backoff = min(2.0 ** max(ev.attempts, 1), 30.0)
                base = ev.updated_at or utcnow()
                if utcnow() - base < timedelta(seconds=backoff):
                    return None
            if not can_transition_outbox(current, OutboxStatus.PROCESSING):
                return None
            ev.status = OutboxStatus.PROCESSING.value
            ev.attempts += 1
            return ev

    def finish_outbox(
        self, outbox_id: int, *, ok: bool, error: str = "", failed: bool = False
    ) -> None:
        with self.session() as s, s.begin():
            ev = s.get(ExportOutbox, outbox_id)
            if ev is None:
                return
            if ok:
                ev.status = OutboxStatus.SYNCED.value
                ev.last_error = ""
            elif failed:
                ev.status = OutboxStatus.FAILED.value
                ev.last_error = error[:2000]
            else:
                ev.status = OutboxStatus.RETRY_WAIT.value
                ev.last_error = error[:2000]
            ev.updated_at = utcnow()

    def mark_outbox_synced_and_update_state(
        self, run_id: int, outbox_id: int, csv_path: str
    ) -> None:
        with self.session() as s, s.begin():
            ev = s.get(ExportOutbox, outbox_id)
            if ev is not None and ev.status == OutboxStatus.PROCESSING.value:
                ev.status = OutboxStatus.SYNCED.value
                ev.last_error = ""
                ev.updated_at = utcnow()
            state = s.get(ExportState, run_id)
            if state is None:
                s.add(
                    ExportState(
                        run_id=run_id,
                        csv_path=csv_path,
                        last_synced_outbox_id=outbox_id,
                        status="OK",
                    )
                )
            else:
                state.csv_path = csv_path
                state.last_synced_outbox_id = max(state.last_synced_outbox_id, outbox_id)
                state.status = "OK"

    def mark_pending_outbox_synced(self, run_id: int) -> int:
        """重建 CSV 后：该 run 的所有待同步事件视为已投影。"""
        with self.session() as s, s.begin():
            res = s.execute(
                update(ExportOutbox)
                .where(
                    ExportOutbox.run_id == run_id,
                    ExportOutbox.status.in_(
                        [
                            OutboxStatus.PENDING.value,
                            OutboxStatus.RETRY_WAIT.value,
                            OutboxStatus.PROCESSING.value,
                        ]
                    ),
                )
                .values(status=OutboxStatus.SYNCED.value, last_error="", updated_at=utcnow())
            )
            return res.rowcount or 0

    def pending_outbox_count(self, run_id: int | None = None) -> int:
        with self.session() as s:
            stmt = select(func.count(ExportOutbox.id)).where(
                ExportOutbox.status.in_(
                    [
                        OutboxStatus.PENDING.value,
                        OutboxStatus.RETRY_WAIT.value,
                        OutboxStatus.PROCESSING.value,
                    ]
                )
            )
            if run_id is not None:
                stmt = stmt.where(ExportOutbox.run_id == run_id)
            return int(s.scalar(stmt) or 0)

    def get_export_state(self, run_id: int) -> ExportState | None:
        with self.session() as s:
            return s.get(ExportState, run_id)

    # ------------------------------------------------------------------
    # 设置
    # ------------------------------------------------------------------
    def set_setting(self, key: str, value_json: str) -> None:
        with self.session() as s, s.begin():
            row = s.get(AppSetting, key)
            if row is None:
                s.add(AppSetting(key=key, value_json=value_json))
            else:
                row.value_json = value_json

    def get_setting(self, key: str) -> str | None:
        with self.session() as s:
            row = s.get(AppSetting, key)
            return row.value_json if row else None

    # ------------------------------------------------------------------
    # Versioned TraitDefinition / TraitObservation contract
    # ------------------------------------------------------------------
    def save_trait_definition(self, definition: TraitDefinition) -> int:
        """Persist a frozen trait definition exactly once per version."""
        with self.session() as s, s.begin():
            row = s.execute(
                select(TraitDefinitionRecord).where(
                    TraitDefinitionRecord.trait_id == definition.trait_id,
                    TraitDefinitionRecord.version == definition.version,
                )
            ).scalar_one_or_none()
            if row is None:
                row = TraitDefinitionRecord(
                    trait_id=definition.trait_id,
                    version=definition.version,
                    name=definition.name,
                    trait_type=definition.type,
                    unit=definition.unit or "",
                    allowed_values_json=json.dumps(definition.allowed_values, ensure_ascii=False),
                    protocol=definition.protocol,
                    calibration_required=1 if definition.calibration_required else 0,
                    qc_rules_json=json.dumps(definition.qc_rules, ensure_ascii=False, sort_keys=True),
                )
                s.add(row)
                s.flush()
            return int(row.id)

    def save_trait_observation(self, observation: TraitObservation) -> int:
        """Idempotently persist one image/trait observation for a run."""
        with self.session() as s, s.begin():
            row = s.execute(
                select(TraitObservationRecord).where(
                    TraitObservationRecord.run_id == observation.run_id,
                    TraitObservationRecord.image_id == observation.image_id,
                    TraitObservationRecord.trait_id == observation.trait_id,
                )
            ).scalar_one_or_none()
            values = {
                "specimen_id": observation.specimen_id,
                "value_json": json.dumps(observation.value, ensure_ascii=False),
                "unit": observation.unit or "",
                "calibrated_confidence": observation.calibrated_confidence,
                "quality_flags_json": json.dumps(observation.quality_flags, ensure_ascii=False),
                "model_or_rule_version": observation.model_or_rule_version,
                "review_status": observation.review_status,
                "image_sha256": observation.image_sha256 or "",
            }
            if row is None:
                row = TraitObservationRecord(
                    run_id=observation.run_id,
                    image_id=observation.image_id,
                    trait_id=observation.trait_id,
                    **values,
                )
                s.add(row)
                s.flush()
            else:
                for key, value in values.items():
                    setattr(row, key, value)
            return int(row.id)

    def list_trait_observations(self, run_id: str) -> list[TraitObservationRecord]:
        with self.session() as s:
            return list(
                s.execute(
                    select(TraitObservationRecord)
                    .where(TraitObservationRecord.run_id == run_id)
                    .order_by(TraitObservationRecord.id)
                ).scalars()
            )

    def trait_observation_counts(self, run_id: str) -> dict[str, int]:
        with self.session() as s:
            rows = s.execute(
                select(TraitObservationRecord.review_status, func.count(TraitObservationRecord.id))
                .where(TraitObservationRecord.run_id == run_id)
                .group_by(TraitObservationRecord.review_status)
            ).all()
            return {str(status): int(count) for status, count in rows}
