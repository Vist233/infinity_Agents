"""任务引擎：扫描、队列、并发、重试、恢复（文档 §14、§15）。

- 独立 QThread 内运行 asyncio 事件循环，避免阻塞 Qt 主线程（§5.1）。
- 平台模式固定 Semaphore(1)；Worker 仍是最终权威（§14.2）。
- 通过 Qt Signal 上报单项结果、统计变化、日志；主线程只更新 UI。
- 暂停=停止领取；停止=取消未发出的任务；结果先落 SQLite。
"""
from __future__ import annotations

import asyncio
import json
import logging
import uuid
from datetime import timedelta
from pathlib import Path

from PySide6.QtCore import QThread, Signal

from .. import config
from ..core.image_preprocess import ImagePreprocessError, prepare_image
from ..core.prompting import build_messages_payload
from ..core.state_machine import ItemStatus, RunStatus
from ..log import RunLogger
from ..model.gateway import EvaluateRequest, ModelGateway
from ..model.schemas import GatewayError, parse_evaluation_output
from ..persistence.models import utcnow

logger = logging.getLogger("imagejudge.task_engine")


def _backoff_seconds(attempt: int) -> float:
    """指数退避（文档 §15.1）。"""
    delay = config.RETRY_BACKOFF_BASE_SECONDS * (2 ** max(attempt, 0))
    return min(delay, config.RETRY_BACKOFF_MAX_SECONDS)


def _now_plus(seconds: float):
    return utcnow() + timedelta(seconds=seconds)


class TaskEngine(QThread):
    """执行单个 task_run 的引擎线程。"""

    item_updated = Signal(int, dict)      # item_id, payload
    stats_updated = Signal(dict)          # 统计字典
    log_message = Signal(str, str)        # level, message
    run_state_changed = Signal(str)       # run 状态
    run_finished = Signal(int, str)       # run_id, final_status

    def __init__(
        self,
        repo,
        gateway: ModelGateway,
        *,
        run_id: int,
        reference_path: str,
        criteria_text: str,
        max_retries: int = config.DEFAULT_MAX_RETRIES,
        timeout_seconds: float = config.DEFAULT_TIMEOUT_SECONDS,
        concurrency: int = config.PLATFORM_CONCURRENCY,
        parent=None,
    ):
        super().__init__(parent)
        self._repo = repo
        self._gateway = gateway
        self._run_id = run_id
        self._reference_path = reference_path
        self._criteria_text = criteria_text
        self._max_retries = max_retries
        self._timeout = timeout_seconds
        self._concurrency = max(1, int(concurrency))

        self._loop: asyncio.AbstractEventLoop | None = None
        self._pause_event: asyncio.Event | None = None
        self._stop_requested = False
        self._halt_reason = ""
        self._run_logger = RunLogger(run_id)

    # ------------------------------------------------------------------
    # 控制接口（主线程调用）
    # ------------------------------------------------------------------
    def pause(self) -> None:
        self._log("INFO", "请求暂停")
        if self._loop and self._pause_event:
            self._loop.call_soon_threadsafe(self._pause_event.clear)

    def resume(self) -> None:
        self._log("INFO", "恢复执行")
        if self._loop and self._pause_event:
            self._loop.call_soon_threadsafe(self._pause_event.set)

    def stop(self) -> None:
        self._log("INFO", "请求停止")
        self._stop_requested = True
        if self._loop and self._pause_event:
            # 解除暂停以便循环退出
            self._loop.call_soon_threadsafe(self._pause_event.set)

    def _log(self, level: str, message: str) -> None:
        self._run_logger.info("%s: %s", level, message)
        self.log_message.emit(level, message)

    # ------------------------------------------------------------------
    # 线程入口
    # ------------------------------------------------------------------
    def run(self) -> None:  # QThread 入口
        self._loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self._loop)
        self._pause_event = asyncio.Event()
        self._pause_event.set()
        try:
            final_status = self._loop.run_until_complete(self._run_async())
        except Exception as exc:  # 不让线程静默崩溃
            logger.exception("任务引擎异常")
            self._log("ERROR", f"任务引擎异常: {exc}")
            final_status = RunStatus.FAILED.value
            try:
                self._repo.set_run_status(self._run_id, RunStatus.FAILED, force=True)
            except Exception:
                pass
        finally:
            try:
                self._loop.run_until_complete(self._gateway.aclose())
            except Exception:
                pass
            self._loop.close()
        self.run_finished.emit(self._run_id, final_status)

    async def _run_async(self) -> str:
        # 预处理参考图（一次），失败则整个 run 失败
        try:
            reference = await asyncio.to_thread(prepare_image, Path(self._reference_path))
        except ImagePreprocessError as exc:
            self._log("ERROR", f"参考图片无效: {exc}")
            self._repo.set_run_status(self._run_id, RunStatus.FAILED, force=True)
            return RunStatus.FAILED.value

        self._repo.set_run_status(self._run_id, RunStatus.RUNNING)
        self.run_state_changed.emit(RunStatus.RUNNING.value)
        self._emit_stats()

        prompt = build_messages_payload(self._criteria_text)
        workers = [
            asyncio.create_task(self._worker_loop(reference, prompt))
            for _ in range(self._concurrency)
        ]
        await asyncio.gather(*workers)

        return self._finalize()

    async def _worker_loop(self, reference, prompt) -> None:
        """Claim and process items until the run is drained or stopped."""
        while not self._stop_requested:
            await self._pause_event.wait()
            if self._stop_requested:
                return

            item = await asyncio.to_thread(self._repo.claim_next_item, self._run_id)
            if item is None:
                if await asyncio.to_thread(self._repo.has_more_retry_wait, self._run_id):
                    await asyncio.sleep(0.5)
                    continue
                return

            await self._process_item(item, reference, prompt)

    def _finalize(self) -> str:
        if self._stop_requested:
            self._repo.mark_item_cancelled(self._run_id)
            status = RunStatus.STOPPED
            self._repo.set_run_status(self._run_id, status, force=True)
            reason = f"（{self._halt_reason}）" if self._halt_reason else ""
            self._log("INFO", f"任务已停止{reason}")
        else:
            totals = self._repo.update_run_totals(self._run_id)
            status = (
                RunStatus.COMPLETED_WITH_ERRORS
                if totals.get("failed", 0) > 0
                else RunStatus.COMPLETED
            )
            self._repo.set_run_status(self._run_id, status, force=True)
            self._log("INFO", f"任务结束: {status.value}")
        self._emit_stats()
        self.run_state_changed.emit(status.value)
        return status.value

    # ------------------------------------------------------------------
    # 单项处理
    # ------------------------------------------------------------------
    async def _process_item(self, item, reference, prompt) -> None:
        item_id = item.item_id
        client_request_id = uuid.uuid4().hex
        self._repo.set_client_request_id(item_id, client_request_id)
        self._log("INFO", f"开始处理 item={item_id} {item.relative_path}")
        self._emit_item(item_id, {"status": ItemStatus.PROCESSING.value})

        # 预处理目标图
        try:
            target = await asyncio.to_thread(prepare_image, Path(item.path))
        except ImagePreprocessError as exc:
            self._repo.mark_item_failed(
                item_id, error_code=exc.code, error_message=str(exc)
            )
            self._log("WARNING", f"图片无效 item={item_id}: {exc}")
            self._emit_item(item_id, {"status": ItemStatus.FAILED.value, "error_code": exc.code})
            self._emit_stats()
            return

        request = EvaluateRequest(
            reference_data_url=reference.data_url,
            target_data_url=target.data_url,
            reference_path=self._reference_path,
            target_path=item.path,
            system_prompt=prompt.system_prompt,
            user_prompt=prompt.user_prompt,
            # Worker 旧接口只转发 task_rules；把 2.0 分类约束一并带上，
            # 保证平台模式与 BYOK 模式使用同一份输出契约。
            task_rules=f"{prompt.system_prompt}\n\n{prompt.user_prompt}",
            prompt_version=prompt.prompt_version,
            output_schema_version=prompt.schema_version,
            client_request_id=client_request_id,
            timeout_seconds=self._timeout,
        )

        attempt = item.attempt_count
        while True:
            if self._stop_requested:
                return
            try:
                raw = await self._gateway.evaluate(request)
                parsed, _repaired = await self._parse_with_repair(raw, request)
                self._on_success(item_id, parsed, raw, prompt)
                return
            except GatewayError as exc:
                # 认证失效 / 额度用尽：不逐张重试，直接中止整个 run（文档 §15.1）
                if exc.code in (
                    config.ERR_AUTH_EXPIRED,
                    config.ERR_QUOTA_EXCEEDED,
                    config.ERR_PLATFORM_MODEL_NOT_CONFIGURED,
                ):
                    self._repo.mark_item_failed(
                        item_id,
                        error_code=exc.code,
                        error_message=exc.message,
                        latency_ms=0,
                    )
                    self._halt_reason = exc.message
                    self._stop_requested = True
                    self._log("ERROR", f"任务中止: {exc.code} {exc.message}")
                    self._emit_item(
                        item_id, {"status": ItemStatus.FAILED.value, "error_code": exc.code}
                    )
                    self._emit_stats()
                    return
                if not exc.retryable or attempt >= self._max_retries:
                    self._repo.mark_item_failed(
                        item_id,
                        error_code=exc.code,
                        error_message=exc.message,
                        latency_ms=0,
                    )
                    self._log("ERROR", f"item={item_id} 失败: {exc.code} {exc.message}")
                    self._emit_item(
                        item_id, {"status": ItemStatus.FAILED.value, "error_code": exc.code}
                    )
                    self._emit_stats()
                    return
                # 可重试：计算等待时间
                wait = exc.retry_after if exc.retry_after else _backoff_seconds(attempt)
                attempt += 1
                next_retry_at = _now_plus(wait)
                self._repo.mark_item_retry_wait(
                    item_id,
                    next_retry_at,
                    error_code=exc.code,
                    error_message=exc.message,
                )
                self._log(
                    "WARNING",
                    f"item={item_id} 重试({attempt}/{self._max_retries}) 等待 {wait:.1f}s: {exc.code}",
                )
                self._emit_item(item_id, {"status": ItemStatus.RETRY_WAIT.value})
                self._emit_stats()
                # claim 会按 next_retry_at 到期后重新领取
                await asyncio.sleep(min(wait, 1.0))
                return

    async def _parse_with_repair(self, raw, request):
        """Pydantic 校验；失败进行一次强化 JSON 约束的修复重试（文档 §11.5）。"""
        try:
            return parse_evaluation_output(raw.raw_text), False
        except Exception as first_err:
            self._log("WARNING", f"输出不符合 Schema，进行修复重试: {first_err}")
            request.repair = True
            repaired_raw = await self._gateway.evaluate(request)
            try:
                return parse_evaluation_output(repaired_raw.raw_text), True
            except Exception as second_err:
                raise GatewayError(
                    config.ERR_MODEL_OUTPUT_INVALID,
                    f"模型输出无法通过 Schema 校验: {second_err}",
                    retryable=False,
                    request_id=repaired_raw.request_id,
                ) from second_err

    def _on_success(self, item_id, parsed, raw, prompt) -> None:
        detail = parsed.model_dump()
        review_reasons = list(parsed.review.reasons)
        review_required = (
            parsed.review.required
            or parsed.status in {"REVIEW", "UNKNOWN"}
            or any(feature.state == "UNCLEAR" for feature in parsed.spotting_features)
        )
        if parsed.status == "UNKNOWN" and not review_reasons:
            review_reasons.append("参考图中没有足够明确的匹配类别")
        if parsed.status == "REVIEW" and not review_reasons:
            review_reasons.append("类别特征存在冲突或证据不足")
        self._repo.save_result_and_enqueue_export(
            item_id=item_id,
            task_type=parsed.task_type,
            predicted_category=parsed.predicted_category,
            result_status=parsed.status,
            reasoning_summary=parsed.reasoning_summary,
            detail_json=json.dumps(detail, ensure_ascii=False),
            needs_human_review=review_required,
            review_reasons_json=json.dumps(review_reasons, ensure_ascii=False),
            spotting_features=[feature.model_dump() for feature in parsed.spotting_features],
            model_id=config.MODEL_ID,
            request_id=raw.request_id,
            prompt_version=prompt.prompt_version,
            schema_version=prompt.schema_version,
            latency_ms=raw.latency_ms,
            diagnostics=json.dumps(raw.diagnostics, ensure_ascii=False)[:2000],
        )
        self._log(
            "INFO",
            f"item={item_id} 成功 category={parsed.predicted_category} status={parsed.status}",
        )
        self._emit_item(
            item_id,
            {
                "status": ItemStatus.SUCCEEDED.value,
                "predicted_category": parsed.predicted_category,
                "result_status": parsed.status,
                "reasoning_summary": parsed.reasoning_summary,
                "needs_human_review": review_required,
                "review_reasons": review_reasons,
            },
        )
        self._emit_stats()

    # ------------------------------------------------------------------
    # 信号
    # ------------------------------------------------------------------
    def _emit_item(self, item_id: int, payload: dict) -> None:
        self.item_updated.emit(item_id, payload)

    def _emit_stats(self) -> None:
        try:
            totals = self._repo.update_run_totals(self._run_id)
            self.stats_updated.emit(totals)
        except Exception as exc:
            logger.warning("统计失败: %s", exc)
