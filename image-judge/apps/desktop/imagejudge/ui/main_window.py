"""主任务页（文档 §6.2）。

参考图 / 输入源 / 判断规则 / 输出 / 运行参数 / 操作 / 进度 / 结果表。
Qt 主线程不做网络调用、图片压缩或大量 CSV 写入（§5.1）。
"""
from __future__ import annotations

import logging
import shutil
from pathlib import Path

from PySide6.QtCore import QObject, Qt, QThread, QTimer, Signal
from PySide6.QtGui import QDesktopServices, QPixmap
from PySide6.QtWidgets import (
    QCheckBox,
    QComboBox,
    QDoubleSpinBox,
    QFileDialog,
    QFormLayout,
    QGridLayout,
    QGroupBox,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QLineEdit,
    QMainWindow,
    QMessageBox,
    QPlainTextEdit,
    QProgressBar,
    QPushButton,
    QRadioButton,
    QSpinBox,
    QTableView,
    QToolButton,
    QVBoxLayout,
    QWidget,
)

from .. import config
from ..core import scanner
from ..core.prompting import DEFAULT_CRITERIA
from ..core.state_machine import RunStatus
from ..core.task_engine import TaskEngine
from ..export.csv_sync import rebuild_csv
from ..persistence.models import TaskItem, TaskRun
from ..ui.dialogs.result_detail_dialog import ResultDetailDialog
from ..ui.result_table_model import ResultTableModel
from sqlalchemy import select

logger = logging.getLogger("imagejudge.ui.main")

IMAGE_FILTER = "图片 (*.jpg *.jpeg *.png *.webp)"


class _CollapsibleSection(QWidget):
    """A compact disclosure panel for low-frequency settings."""

    def __init__(self, title: str, body: QWidget, *, collapsed: bool = True, parent=None):
        super().__init__(parent)
        self._body = body
        self._toggle = QToolButton()
        self._toggle.setText(title)
        self._toggle.setCheckable(True)
        self._toggle.setChecked(not collapsed)
        self._toggle.setToolButtonStyle(Qt.ToolButtonTextBesideIcon)
        self._toggle.setStyleSheet(
            "QToolButton { border: 0; padding: 5px 2px; font-weight: 600; }"
            "QToolButton:hover { color: #0969da; }"
        )
        self._toggle.clicked.connect(self._set_expanded)

        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(2)
        layout.addWidget(self._toggle)
        layout.addWidget(self._body)
        self._set_expanded(not collapsed)

    def _set_expanded(self, expanded: bool) -> None:
        self._toggle.setArrowType(Qt.DownArrow if expanded else Qt.RightArrow)
        self._body.setVisible(expanded)


class _ScanWorker(QObject):
    """后台扫描：遍历、过滤、哈希（避免阻塞 UI）。"""

    finished_ok = Signal(list, list)  # unique, duplicates
    finished_err = Signal(str)

    def __init__(self, input_path: str, input_type: str, recursive: bool, skip_hashes: set[str]):
        super().__init__()
        self._input_path = input_path
        self._input_type = input_type
        self._recursive = recursive
        self._skip_hashes = skip_hashes

    def run(self) -> None:
        try:
            files = scanner.scan(
                Path(self._input_path),
                recursive=self._recursive,
                input_type=self._input_type,
            )
            unique, duplicates = scanner.split_duplicates(files)
            if self._skip_hashes:
                unique = [f for f in unique if f.sha256 not in self._skip_hashes]
            self.finished_ok.emit(
                [vars(f) for f in unique], [vars(f) for f in duplicates]
            )
        except Exception as exc:  # pragma: no cover
            logger.exception("扫描失败")
            self.finished_err.emit(str(exc))


class MainWindow(QMainWindow):
    def __init__(self, session, backlog_signal: Signal | None = None, csv_notify=None):
        super().__init__()
        self._session = session
        self._csv_notify = csv_notify  # callable: 唤醒 CSV 同步线程
        self._engine: TaskEngine | None = None
        self._scan_thread: QThread | None = None
        self._scan_worker: _ScanWorker | None = None
        self._current_run_id: int | None = None
        self._item_paths: dict[int, str] = {}

        self.setWindowTitle(f"{config.APP_DISPLAY_NAME} v{config.APP_VERSION}")
        self.resize(1180, 820)
        self._build_ui()
        self._refresh_run_list()
        self._update_button_states()

        if backlog_signal is not None:
            backlog_signal.connect(self._on_backlog)

        self._timer = QTimer(self)
        self._timer.timeout.connect(self._poll_backlog)
        self._timer.start(3000)

    # ------------------------------------------------------------------
    # UI 构建
    # ------------------------------------------------------------------
    def _build_ui(self) -> None:
        central = QWidget()
        root = QVBoxLayout(central)

        top = QHBoxLayout()
        top.addStretch()
        self._user_label = QLabel(self._user_text())
        top.addWidget(self._user_label)
        self._change_auth_btn = QPushButton("更换 API / 登录")
        self._change_auth_btn.setToolTip("重新选择平台账号或 BYOK API Key")
        self._change_auth_btn.clicked.connect(self._change_auth)
        top.addWidget(self._change_auth_btn)
        root.addLayout(top)

        # 上部：配置区（两列）
        config_area = QHBoxLayout()
        config_area.addWidget(self._build_reference_box(), 1)
        config_area.addWidget(self._build_input_box(), 1)
        config_area.addWidget(
            _CollapsibleSection("输出设置", self._build_output_box()),
            1,
        )
        root.addLayout(config_area)

        root.addWidget(
            _CollapsibleSection("判断规则（高级）", self._build_rules_box())
        )

        params_panel = QWidget()
        params_row = QHBoxLayout(params_panel)
        params_row.setContentsMargins(0, 0, 0, 0)
        params_row.addWidget(QLabel("请求超时(秒):"))
        self._timeout_spin = QDoubleSpinBox()
        self._timeout_spin.setRange(10, 600)
        self._timeout_spin.setValue(config.DEFAULT_TIMEOUT_SECONDS)
        params_row.addWidget(self._timeout_spin)
        params_row.addWidget(QLabel("最大重试:"))
        self._retry_spin = QSpinBox()
        self._retry_spin.setRange(0, 5)
        self._retry_spin.setValue(config.DEFAULT_MAX_RETRIES)
        params_row.addWidget(self._retry_spin)
        self._skip_processed = QCheckBox("跳过已处理文件")
        params_row.addWidget(self._skip_processed)
        params_row.addWidget(QLabel("并发:"))
        self._concurrency_spin = QSpinBox()
        self._concurrency_spin.setRange(1, config.MAX_BYOK_CONCURRENCY)
        if self._session.mode == "byok":
            self._concurrency_spin.setValue(config.DEFAULT_BYOK_CONCURRENCY)
            self._concurrency_spin.setToolTip("BYOK mode: choose 1–16 concurrent requests")
        else:
            self._concurrency_spin.setValue(config.PLATFORM_CONCURRENCY)
            self._concurrency_spin.setEnabled(False)
            self._concurrency_spin.setToolTip("Platform mode is limited to one request")
        params_row.addWidget(self._concurrency_spin)
        concurrency_note = QLabel(
            "(platform fixed)" if self._session.mode == "platform" else "(BYOK)"
        )
        concurrency_note.setStyleSheet("color:#666;")
        params_row.addWidget(concurrency_note)
        params_row.addStretch()

        # 历史任务选择
        params_row.addWidget(QLabel("历史任务:"))
        self._run_combo = QComboBox()
        self._run_combo.setMinimumWidth(260)
        self._run_combo.currentIndexChanged.connect(self._on_run_selected)
        params_row.addWidget(self._run_combo)
        root.addWidget(
            _CollapsibleSection("运行参数与历史任务（高级）", params_panel)
        )

        # 操作按钮
        actions = QHBoxLayout()
        self._start_btn = QPushButton("开始判断")
        self._pause_btn = QPushButton("暂停")
        self._resume_btn = QPushButton("继续")
        self._stop_btn = QPushButton("停止")
        self._retry_failed_btn = QPushButton("重试失败")
        self._rebuild_csv_btn = QPushButton("重建 CSV")
        self._export_btn = QPushButton("导出副本")
        for btn in (self._start_btn, self._pause_btn, self._resume_btn, self._stop_btn):
            actions.addWidget(btn)
        actions.addStretch()
        self._backlog_label = QLabel("")
        actions.addWidget(self._backlog_label)
        root.addLayout(actions)

        secondary_actions = QWidget()
        secondary_layout = QHBoxLayout(secondary_actions)
        secondary_layout.setContentsMargins(0, 0, 0, 0)
        for btn in (self._retry_failed_btn, self._rebuild_csv_btn, self._export_btn):
            secondary_layout.addWidget(btn)
        secondary_layout.addStretch()
        root.addWidget(_CollapsibleSection("更多操作（高级）", secondary_actions))

        self._start_btn.clicked.connect(self._start_run)
        self._pause_btn.clicked.connect(lambda: self._engine and self._engine.pause())
        self._resume_btn.clicked.connect(self._resume_run)
        self._stop_btn.clicked.connect(lambda: self._engine and self._engine.stop())
        self._retry_failed_btn.clicked.connect(self._retry_failed)
        self._rebuild_csv_btn.clicked.connect(self._rebuild_csv)
        self._export_btn.clicked.connect(self._export_copy)

        # 进度区
        progress_box = QGroupBox("进度")
        pgrid = QGridLayout(progress_box)
        self._stat_labels: dict[str, QLabel] = {}
        for i, key in enumerate(
            ["total", "pending", "processing", "succeeded", "failed", "review", "remaining"]
        ):
            label = QLabel("--")
            label.setStyleSheet("font-size: 15px; font-weight: bold;")
            names = {
                "total": "总数",
                "pending": "等待",
                "processing": "处理中",
                "succeeded": "成功",
                "failed": "失败",
                "review": "人工复核",
                "remaining": "剩余",
            }
            pgrid.addWidget(QLabel(names[key] + ":"), 0, i)
            pgrid.addWidget(label, 1, i)
            self._stat_labels[key] = label
        root.addWidget(progress_box)

        self._progress_bar = QProgressBar()
        root.addWidget(self._progress_bar)
        self._current_file_label = QLabel("当前文件：-")
        root.addWidget(self._current_file_label)

        # 结果表
        self._table_model = ResultTableModel(self)
        self._table = QTableView()
        self._table.setModel(self._table_model)
        self._table.horizontalHeader().setSectionResizeMode(QHeaderView.Interactive)
        self._table.setAlternatingRowColors(True)
        self._table.doubleClicked.connect(self._open_detail)
        root.addWidget(self._table, 1)

        self.setCentralWidget(central)

    def _user_text(self) -> str:
        mode = self._session.mode
        if mode == "platform":
            return "Platform · Connected"
        if mode == "byok":
            return "BYOK · Connected"
        return "Offline · History only"

    def _build_reference_box(self) -> QGroupBox:
        box = QGroupBox("参考图")
        layout = QVBoxLayout(box)
        self._ref_thumb = QLabel()
        self._ref_thumb.setMinimumHeight(120)
        self._ref_thumb.setAlignment(Qt.AlignCenter)
        self._ref_thumb.setStyleSheet("border:1px solid #ccc;")
        layout.addWidget(self._ref_thumb)
        self._ref_path_label = QLabel("未选择")
        self._ref_path_label.setWordWrap(True)
        layout.addWidget(self._ref_path_label)
        self._ref_hash_label = QLabel("")
        self._ref_hash_label.setStyleSheet("color:#666;")
        layout.addWidget(self._ref_hash_label)
        btn = QPushButton("选择 / 更换参考图")
        btn.clicked.connect(self._choose_reference)
        layout.addWidget(btn)
        return box

    def _build_input_box(self) -> QGroupBox:
        box = QGroupBox("输入源")
        layout = QVBoxLayout(box)
        row = QHBoxLayout()
        self._input_file_radio = QRadioButton("单文件")
        self._input_folder_radio = QRadioButton("文件夹")
        self._input_folder_radio.setChecked(True)
        row.addWidget(self._input_file_radio)
        row.addWidget(self._input_folder_radio)
        row.addStretch()
        layout.addLayout(row)
        self._input_path_label = QLabel("未选择")
        self._input_path_label.setWordWrap(True)
        layout.addWidget(self._input_path_label)
        self._recursive_check = QCheckBox("递归子目录")
        self._recursive_check.setChecked(True)
        layout.addWidget(self._recursive_check)
        btn = QPushButton("选择输入")
        btn.clicked.connect(self._choose_input)
        layout.addWidget(btn)
        note = QLabel("支持格式：JPG / JPEG / PNG / WEBP")
        note.setStyleSheet("color:#666;")
        layout.addWidget(note)
        layout.addStretch()
        return box

    def _build_output_box(self) -> QGroupBox:
        box = QGroupBox("输出")
        layout = QVBoxLayout(box)
        form = QFormLayout()
        self._output_dir_edit = QLineEdit(str(Path.home() / "Desktop"))
        form.addRow("输出目录:", self._output_dir_edit)
        self._csv_name_edit = QLineEdit("results_live.csv")
        form.addRow("CSV 文件名:", self._csv_name_edit)
        layout.addLayout(form)
        row = QHBoxLayout()
        open_dir_btn = QPushButton("打开输出目录")
        open_dir_btn.clicked.connect(self._open_output_dir)
        open_csv_btn = QPushButton("打开 results_live.csv")
        open_csv_btn.clicked.connect(self._open_csv_file)
        row.addWidget(open_dir_btn)
        row.addWidget(open_csv_btn)
        layout.addLayout(row)
        layout.addStretch()
        return box

    def _build_rules_box(self) -> QGroupBox:
        box = QGroupBox("判断规则")
        layout = QVBoxLayout(box)
        self._rules_edit = QPlainTextEdit(DEFAULT_CRITERIA)
        self._rules_edit.setFixedHeight(90)
        layout.addWidget(self._rules_edit)
        row = QHBoxLayout()
        restore_btn = QPushButton("恢复默认提示词")
        restore_btn.clicked.connect(lambda: self._rules_edit.setPlainText(DEFAULT_CRITERIA))
        row.addWidget(restore_btn)
        version = QLabel(f"提示词版本：{config.PROMPT_VERSION}　输出 Schema 版本：{config.OUTPUT_SCHEMA_VERSION}")
        version.setStyleSheet("color:#666;")
        row.addWidget(version)
        row.addStretch()
        layout.addLayout(row)
        return box

    # ------------------------------------------------------------------
    # 选择器
    # ------------------------------------------------------------------
    def _choose_reference(self) -> None:
        path, _ = QFileDialog.getOpenFileName(self, "选择参考图片", "", IMAGE_FILTER)
        if not path:
            return
        self._reference_path = path
        self._ref_path_label.setText(path)
        pixmap = QPixmap(path)
        if not pixmap.isNull():
            self._ref_thumb.setPixmap(
                pixmap.scaled(220, 120, Qt.KeepAspectRatio, Qt.SmoothTransformation)
            )
        try:
            digest = scanner.compute_sha256(Path(path))
            self._ref_hash_label.setText(f"SHA-256: {digest[:16]}…")
            self._reference_sha256 = digest
        except OSError:
            self._reference_sha256 = ""

    def _choose_input(self) -> None:
        if self._input_file_radio.isChecked():
            path, _ = QFileDialog.getOpenFileName(self, "选择待判断图片", "", IMAGE_FILTER)
            self._input_type = "file"
        else:
            path = QFileDialog.getExistingDirectory(self, "选择图片文件夹")
            self._input_type = "folder"
        if path:
            self._input_path = path
            self._input_path_label.setText(path)

    # ------------------------------------------------------------------
    # 启动任务
    # ------------------------------------------------------------------
    def _start_run(self) -> None:
        if not self._session.can_evaluate():
            QMessageBox.warning(self, "未登录", "请先登录（平台账号或 BYOK）后再发起判断。")
            return
        ref = getattr(self, "_reference_path", "")
        if not ref or not Path(ref).is_file():
            QMessageBox.warning(self, "缺少参考图", "请先选择一张参考图片。")
            return
        input_path = getattr(self, "_input_path", "")
        if not input_path or not Path(input_path).exists():
            QMessageBox.warning(self, "缺少输入", "请选择单张图片或图片文件夹。")
            return
        output_dir = self._output_dir_edit.text().strip()
        if not output_dir:
            QMessageBox.warning(self, "缺少输出目录", "请填写输出目录。")
            return
        Path(output_dir).mkdir(parents=True, exist_ok=True)

        self._start_btn.setEnabled(False)
        self._current_file_label.setText("正在扫描文件…")

        skip_hashes: set[str] = set()
        if self._skip_processed.isChecked():
            skip_hashes = self._succeeded_hashes()

        self._scan_worker = _ScanWorker(
            input_path, self._input_type, self._recursive_check.isChecked(), skip_hashes
        )
        self._scan_thread = QThread(self)
        self._scan_worker.moveToThread(self._scan_thread)
        self._scan_thread.started.connect(self._scan_worker.run)
        self._scan_worker.finished_ok.connect(self._on_scanned)
        self._scan_worker.finished_err.connect(self._on_scan_error)
        self._scan_worker.finished_ok.connect(self._scan_thread.quit)
        self._scan_worker.finished_err.connect(self._scan_thread.quit)
        self._scan_thread.start()

    def _succeeded_hashes(self) -> set[str]:
        repo = self._session.repo
        try:
            with repo.session() as s:
                rows = s.execute(
                    select(TaskItem.sha256).where(
                        TaskItem.status == "SUCCEEDED", TaskItem.sha256 != ""
                    )
                ).all()
                return {r[0] for r in rows}
        except Exception:
            return set()

    def _on_scan_error(self, message: str) -> None:
        self._start_btn.setEnabled(True)
        self._current_file_label.setText("当前文件：-")
        QMessageBox.critical(self, "扫描失败", message)

    def _on_scanned(self, unique: list[dict], duplicates: list[dict]) -> None:
        repo = self._session.repo
        if not unique:
            self._start_btn.setEnabled(True)
            self._current_file_label.setText("当前文件：-")
            QMessageBox.information(self, "无可处理文件", "没有找到支持的图片文件。")
            return
        try:
            project_id = repo.create_project(
                name=Path(getattr(self, "_reference_path", "")).name,
                reference_path=getattr(self, "_reference_path", ""),
                reference_sha256=getattr(self, "_reference_sha256", ""),
                prompt_text=self._rules_edit.toPlainText(),
                prompt_version=config.PROMPT_VERSION,
                model_id=config.MODEL_ID,
            )
            run_id = repo.create_run(
                project_id=project_id,
                input_type=self._input_type,
                input_path=getattr(self, "_input_path", ""),
                recursive=self._recursive_check.isChecked(),
                output_dir=self._output_dir_edit.text().strip(),
                csv_name=self._csv_name_edit.text().strip() or "results_live.csv",
                timeout_seconds=self._timeout_spin.value(),
                max_retries=self._retry_spin.value(),
            )
            repo.set_run_status(run_id, RunStatus.SCANNING, force=True)
            repo.insert_items(run_id, unique)
            dup_ids = []
            if duplicates:
                repo.insert_items(run_id, duplicates)
                with repo.session() as s:
                    dup_ids = [
                        i.id
                        for (i,) in s.execute(
                            select(TaskItem).where(
                                TaskItem.run_id == run_id,
                                TaskItem.sha256.in_([d["sha256"] for d in duplicates]),
                            )
                        ).all()
                    ]
                repo.mark_duplicate_skipped(run_id, dup_ids)
            repo.set_run_status(run_id, RunStatus.READY, force=True)
        except Exception as exc:
            logger.exception("创建任务失败")
            self._start_btn.setEnabled(True)
            QMessageBox.critical(self, "创建任务失败", str(exc))
            return
        self._launch_engine(run_id)

    # ------------------------------------------------------------------
    # 引擎控制
    # ------------------------------------------------------------------
    def _launch_engine(self, run_id: int) -> None:
        repo = self._session.repo
        run = repo.get_run(run_id)
        project = repo.get_project(run.project_id)
        self._current_run_id = run_id
        try:
            gateway = self._session.create_gateway()
        except Exception as exc:
            QMessageBox.critical(self, "无法创建模型网关", str(exc))
            self._start_btn.setEnabled(True)
            return

        self._engine = TaskEngine(
            repo,
            gateway,
            run_id=run_id,
            reference_path=project.reference_path,
            criteria_text=project.prompt_text or DEFAULT_CRITERIA,
            max_retries=run.max_retries,
            timeout_seconds=run.timeout_seconds,
            concurrency=(
                config.PLATFORM_CONCURRENCY
                if self._session.mode == "platform"
                else self._concurrency_spin.value()
            ),
            parent=self,
        )
        self._engine.item_updated.connect(self._on_item_updated)
        self._engine.stats_updated.connect(self._on_stats)
        self._engine.log_message.connect(self._on_engine_log)
        self._engine.run_finished.connect(self._on_run_finished)
        self._table_model.load_from_repo(repo, run_id)
        self._item_paths = {
            entry["item"].id: entry["item"].relative_path
            for entry in repo.list_items_with_results(run_id)
        }
        self._engine.start()
        self._update_button_states(running=True)

    def _resume_run(self) -> None:
        if self._engine is not None and self._engine.isRunning():
            self._engine.resume()
            self._update_button_states(running=True)
            return
        # 引擎已停止：恢复当前选中的 run
        if self._current_run_id is not None:
            self._launch_engine(self._current_run_id)

    def _retry_failed(self) -> None:
        if self._current_run_id is None:
            return
        n = self._session.repo.requeue_failed(self._current_run_id)
        if n == 0:
            QMessageBox.information(self, "重试失败", "没有失败项可重试。")
            return
        self._launch_engine(self._current_run_id)

    def _on_run_finished(self, run_id: int, status: str) -> None:
        self._update_button_states(running=False)
        self._current_file_label.setText("当前文件：-")
        self._table_model.load_from_repo(self._session.repo, run_id)
        self._refresh_run_list()
        if self._csv_notify:
            self._csv_notify()

    # ------------------------------------------------------------------
    # 信号处理
    # ------------------------------------------------------------------
    def _on_item_updated(self, item_id: int, payload: dict) -> None:
        self._table_model.update_item(item_id, payload)
        if payload.get("status") == "PROCESSING":
            self._current_file_label.setText(
                f"当前文件：{self._item_paths.get(item_id, item_id)}"
            )
        if self._csv_notify and payload.get("status") in ("SUCCEEDED", "FAILED"):
            self._csv_notify()

    def _on_stats(self, stats: dict) -> None:
        done = (
            stats.get("succeeded", 0)
            + stats.get("failed", 0)
            + stats.get("skipped", 0)
            + stats.get("cancelled", 0)
        )
        total = stats.get("total", 0)
        self._stat_labels["total"].setText(str(total))
        self._stat_labels["pending"].setText(str(stats.get("pending", 0)))
        self._stat_labels["processing"].setText(str(stats.get("processing", 0)))
        self._stat_labels["succeeded"].setText(str(stats.get("succeeded", 0)))
        self._stat_labels["failed"].setText(str(stats.get("failed", 0)))
        self._stat_labels["review"].setText(str(stats.get("review", 0)))
        self._stat_labels["remaining"].setText(str(max(total - done, 0)))
        self._progress_bar.setMaximum(max(total, 1))
        self._progress_bar.setValue(done)

    def _on_engine_log(self, level: str, message: str) -> None:
        logger.info("[engine] %s: %s", level, message)

    def _on_backlog(self, pending: int) -> None:
        if pending > 0:
            self._backlog_label.setText(f"CSV 同步积压：{pending}")
            self._backlog_label.setStyleSheet("color:#9a6700;")
        else:
            self._backlog_label.setText("CSV 已同步")
            self._backlog_label.setStyleSheet("color:#1a7f37;")

    def _poll_backlog(self) -> None:
        try:
            pending = self._session.repo.pending_outbox_count()
            self._on_backlog(pending)
        except Exception:
            pass

    # ------------------------------------------------------------------
    # 历史任务
    # ------------------------------------------------------------------
    def _refresh_run_list(self) -> None:
        self._run_combo.blockSignals(True)
        self._run_combo.clear()
        for run in self._session.repo.find_resumable_runs():
            label = f"#{run.id} [{run.status}] {Path(run.input_path).name or run.input_path}"
            self._run_combo.addItem(label, run.id)
        self._run_combo.blockSignals(False)
        if self._current_run_id is not None:
            idx = self._run_combo.findData(self._current_run_id)
            if idx >= 0:
                self._run_combo.setCurrentIndex(idx)

    def _on_run_selected(self, index: int) -> None:
        run_id = self._run_combo.itemData(index)
        if run_id is None:
            return
        self._current_run_id = run_id
        repo = self._session.repo
        run = repo.get_run(run_id)
        if run:
            self._table_model.load_from_repo(repo, run_id)
            self._item_paths = {
                entry["item"].id: entry["item"].relative_path
                for entry in repo.list_items_with_results(run_id)
            }
            stats = repo.update_run_totals(run_id)
            self._on_stats(stats)

    # ------------------------------------------------------------------
    # CSV / 输出
    # ------------------------------------------------------------------
    def _csv_path(self) -> Path | None:
        if self._current_run_id is None:
            return None
        run = self._session.repo.get_run(self._current_run_id)
        if not run or not run.output_dir:
            return None
        return Path(run.output_dir) / (run.csv_name or "results_live.csv")

    def _rebuild_csv(self) -> None:
        csv_path = self._csv_path()
        if csv_path is None:
            QMessageBox.information(self, "重建 CSV", "请先选择或运行一个任务。")
            return
        try:
            n = rebuild_csv(self._session.repo, self._current_run_id, csv_path)
            self._session.repo.mark_pending_outbox_synced(self._current_run_id)
            QMessageBox.information(self, "重建 CSV", f"已从数据库重建 {n} 行：\n{csv_path}")
        except OSError as exc:
            QMessageBox.critical(self, "重建 CSV 失败", str(exc))

    def _export_copy(self) -> None:
        csv_path = self._csv_path()
        if csv_path is None or not csv_path.exists():
            QMessageBox.information(self, "导出副本", "尚无可导出的 CSV 文件。")
            return
        target, _ = QFileDialog.getSaveFileName(self, "导出 CSV 副本", csv_path.name, "CSV (*.csv)")
        if target:
            shutil.copyfile(csv_path, target)

    def _open_output_dir(self) -> None:
        path = self._output_dir_edit.text().strip()
        if path and Path(path).exists():
            QDesktopServices.openUrl(Path(path).as_uri())

    def _open_csv_file(self) -> None:
        csv_path = self._csv_path()
        if csv_path and csv_path.exists():
            QDesktopServices.openUrl(csv_path.as_uri())
        else:
            QMessageBox.information(self, "打开 CSV", "CSV 文件尚不存在。")

    # ------------------------------------------------------------------
    # 详情 / 其他
    # ------------------------------------------------------------------
    def _open_detail(self, index) -> None:
        item_id = self._table_model.item_id_at(index.row())
        if item_id is None:
            return
        run = self._session.repo.get_run(self._current_run_id) if self._current_run_id else None
        project = self._session.repo.get_project(run.project_id) if run else None
        reference = project.reference_path if project else ""
        dialog = ResultDetailDialog(self._session.repo, item_id, reference, self)
        dialog.exec()

    def _change_auth(self) -> None:
        if self._session.mode == "platform":
            self._session.logout_platform()
        elif self._session.mode == "byok":
            self._session.byok.clear()
        self._session.mode = None
        from ..ui.login_window import LoginWindow  # 延迟导入避免循环

        window = self.window()
        controller = getattr(window, "controller", None)
        if controller is not None:
            controller.show_login()
        else:
            self.close()

    def _update_button_states(self, running: bool | None = None) -> None:
        if running is None:
            running = self._engine is not None and self._engine.isRunning()
        self._start_btn.setEnabled(not running)
        self._pause_btn.setEnabled(running)
        self._resume_btn.setEnabled(True)
        self._stop_btn.setEnabled(running)
        self._retry_failed_btn.setEnabled(not running)
        self._rebuild_csv_btn.setEnabled(True)
        self._export_btn.setEnabled(True)

    def closeEvent(self, event):  # noqa: N802
        if self._engine is not None and self._engine.isRunning():
            answer = QMessageBox.question(
                self,
                "任务进行中",
                "任务仍在运行，退出后下次启动可恢复。确定退出吗？",
            )
            if answer != QMessageBox.Yes:
                event.ignore()
                return
            self._engine.stop()
            self._engine.wait(3000)
        if self._scan_thread is not None and self._scan_thread.isRunning():
            self._scan_thread.quit()
            self._scan_thread.wait(2000)
        super().closeEvent(event)
