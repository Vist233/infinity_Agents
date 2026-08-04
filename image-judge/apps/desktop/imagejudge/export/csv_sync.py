"""CSV 实时输出：原子临时文件快照 + outbox 消费（文档 §13）。

CSV 是 SQLite 的外部投影，不是业务事实源：
- 每个结果先写 SQLite（含 outbox 事件），提交后由本模块生成快照。
- UTF-8 with BOM、CRLF、固定表头、标准 CSV quoting。
- 写入临时文件 → flush + fsync → 原子替换，避免半截文件。
- 文件被占用/替换失败时保留同步积压，后台指数退避重试，不影响 SQLite。
"""
from __future__ import annotations

import csv
import io
import json
import logging
import os
import tempfile
import threading
import time
from pathlib import Path

from .. import config

logger = logging.getLogger("imagejudge.csv_sync")

# 用户 CSV 是 SQLite 的精简投影；完整 spotting_features 保存在 SQLite。
CSV_HEADER = [
    "图片ID",
    "预测类别",
    "状态",
    "需Review",
    "Reasoning摘要",
    "错误类型",
    "错误说明",
]


class CSVSyncError(RuntimeError):
    pass


def _fmt_time(value) -> str:
    if not value:
        return ""
    try:
        return value.strftime("%Y-%m-%d %H:%M:%S")
    except Exception:
        return str(value)


def build_row(index: int, item, result, synced_at: str) -> list[str]:
    """把 (task_item, evaluation_result) 转成一行 CSV 值。"""
    predicted_category = result.predicted_category if result is not None else ""
    result_status = result.result_status if result is not None else ""
    reasoning_summary = result.reasoning_summary if result is not None else ""
    review_required = bool(result and result.needs_human_review)
    review_reasons = []
    if result is not None:
        try:
            review_reasons = json.loads(result.review_reasons_json or "[]")
        except (TypeError, ValueError):
            review_reasons = []
    if review_reasons:
        suffix = "；".join(str(reason) for reason in review_reasons)
        reasoning_summary = (
            f"{reasoning_summary}；复核原因：{suffix}"
            if reasoning_summary
            else f"复核原因：{suffix}"
        )
    return [
        str(getattr(item, "id", index)),
        predicted_category,
        result_status or item.status,
        "是" if review_required else "否",
        reasoning_summary,
        item.error_code,
        getattr(item, "error_message", ""),
    ]


def write_snapshot_atomic(csv_path: Path, rows: list[list[str]]) -> None:
    """原子快照：写入 .tmp → flush + fsync → os.replace。

    写入期间崩溃只会留下 .tmp 文件，可安全清理（文档 §13.4）。
    """
    csv_path = Path(csv_path)
    csv_path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(
        prefix=csv_path.name + ".", suffix=".tmp", dir=str(csv_path.parent)
    )
    tmp_path = Path(tmp_path)
    try:
        with os.fdopen(fd, "w", newline="", encoding="utf-8-sig") as fh:
            writer = csv.writer(fh, quoting=csv.QUOTE_MINIMAL, lineterminator="\r\n")
            writer.writerow(CSV_HEADER)
            for row in rows:
                writer.writerow(row)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp_path, csv_path)
    except Exception:
        # 清理残留 tmp
        try:
            if tmp_path.exists():
                tmp_path.unlink()
        except OSError:
            pass
        raise


def rebuild_csv(repo, run_id: int, csv_path: Path) -> int:
    """从 SQLite 全量重建 CSV 快照，返回行数（文档 §13.4 步骤 5）。"""
    rows = repo.list_items_with_results(run_id)
    synced_at = time.strftime("%Y-%m-%d %H:%M:%S")
    out = [build_row(i + 1, r["item"], r["result"], synced_at) for i, r in enumerate(rows)]
    write_snapshot_atomic(csv_path, out)
    return len(out)


class CSVSyncer:
    """同步器：消费 export_outbox，把 SQLite 结果投影到 CSV。

    只更新导出状态，不改变业务结果（文档 §5.1）。
    """

    def __init__(self, repo):
        self._repo = repo

    def sync_pending(self, max_events: int | None = None) -> int:
        """处理待同步 outbox 事件；返回处理数量。"""
        processed = 0
        while True:
            if max_events is not None and processed >= max_events:
                break
            ev = self._repo.next_pending_outbox()
            if ev is None:
                break
            ok = self._sync_one(ev)
            processed += 1
            if not ok:
                # 失败采用指数退避；交由下一次轮询重试
                break
        return processed

    def _sync_one(self, ev) -> bool:
        run_id = ev.run_id
        run = self._repo.get_run(run_id)
        csv_path = self._csv_path_for(run)
        try:
            rebuild_csv(self._repo, run_id, csv_path)
            self._repo.mark_outbox_synced_and_update_state(run_id, ev.id, str(csv_path))
            return True
        except PermissionError as exc:
            self._fail(ev, f"文件被占用，稍后重试: {exc}")
            return False
        except OSError as exc:
            self._fail(ev, f"CSV 写入失败: {exc}")
            return False

    def _fail(self, ev, message: str) -> None:
        self._repo.finish_outbox(ev.id, ok=False, error=message)
        logger.warning("CSV 同步失败(outbox=%s): %s", ev.id, message)

    def _csv_path_for(self, run) -> Path:
        output_dir = Path(run.output_dir) if run and run.output_dir else Path.cwd()
        csv_name = run.csv_name if run and run.csv_name else "results_live.csv"
        return output_dir / csv_name


class CSVSyncThread(threading.Thread):
    """后台线程：周期性消费 outbox，直到停止。"""

    def __init__(self, repo, poll_seconds: float | None = None, on_backlog=None):
        super().__init__(name="CSVSyncThread", daemon=True)
        self._syncer = CSVSyncer(repo)
        self._repo = repo
        self._poll = poll_seconds or config.CSV_SYNC_POLL_SECONDS
        self._stop_event = threading.Event()
        self._wakeup = threading.Event()
        self._on_backlog = on_backlog  # callback(pending_count)

    def notify(self) -> None:
        """有新 outbox 事件时立即唤醒。"""
        self._wakeup.set()

    def stop(self) -> None:
        self._stop_event.set()
        self._wakeup.set()

    def run(self) -> None:
        while not self._stop_event.is_set():
            try:
                processed = self._syncer.sync_pending()
            except Exception as exc:  # 不允许后台线程崩溃
                logger.exception("CSV 同步线程异常: %s", exc)
                processed = 0
            pending = self._repo.pending_outbox_count()
            if self._on_backlog:
                try:
                    self._on_backlog(pending)
                except Exception:
                    pass
            if processed == 0:
                self._wakeup.wait(self._poll)
            self._wakeup.clear()
