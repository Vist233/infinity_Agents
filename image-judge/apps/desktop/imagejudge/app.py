"""应用控制器：登录页 ↔ 主窗口路由、CSV 同步线程生命周期、启动恢复。"""
from __future__ import annotations

import logging
from pathlib import Path

from PySide6.QtCore import QObject, Signal
from PySide6.QtWidgets import QMessageBox

from . import config
from .export.csv_sync import CSVSyncThread
from .log import setup_logging
from .persistence.db import init_db
from .persistence.repository import Repository
from .session import AppSession
from .ui.login_window import LoginWindow
from .ui.main_window import MainWindow

logger = logging.getLogger("imagejudge.app")


class _BacklogBridge(QObject):
    """跨线程 CSV 积压通知桥接。"""

    changed = Signal(int)


class AppController(QObject):
    def __init__(self, verbose: bool = False):
        super().__init__()
        setup_logging(verbose)
        config.ensure_app_dirs()
        init_db()

        self.repo = Repository()
        report = self.repo.recover_on_startup()
        if any(report.values()):
            logger.info("启动恢复完成: %s", report)

        self.session = AppSession(self.repo)

        # CSV 同步线程（全局，消费所有 run 的 outbox）
        self._backlog_bridge = _BacklogBridge()
        self.csv_thread = CSVSyncThread(
            self.repo, on_backlog=self._backlog_bridge.changed.emit
        )
        self.csv_thread.start()

        self._login_window: LoginWindow | None = None
        self._main_window: MainWindow | None = None

    # ------------------------------------------------------------------
    def start(self) -> None:
        self.show_login()

    def show_login(self) -> None:
        if self._main_window is not None:
            self._main_window.close()
            self._main_window = None
        self._login_window = LoginWindow(self.session)
        self._login_window.login_succeeded.connect(self._on_login)
        self._login_window.show()

    def _on_login(self, mode: str) -> None:
        self.session.mode = mode
        self.show_main()

    def show_main(self) -> None:
        if self._login_window is not None:
            self._login_window.close()
            self._login_window = None
        self._main_window = MainWindow(
            self.session,
            backlog_signal=self._backlog_bridge.changed,
            csv_notify=self.csv_thread.notify,
        )
        self._main_window.controller = self  # 供退出登录返回登录页
        self._main_window.show()
        self._prompt_resume_if_needed()

    def _prompt_resume_if_needed(self) -> None:
        runs = self.repo.find_resumable_runs()
        resumable = [
            r for r in runs if r.status in ("PAUSED", "READY", "STOPPED") and r.total > 0
        ]
        if resumable and self._main_window is not None:
            latest = resumable[0]
            QMessageBox.information(
                self._main_window,
                "发现未完成任务",
                f"检测到未完成任务 #{latest.id}（{latest.status}，共 {latest.total} 项）。\n"
                "可在“历史任务”下拉框中选择后点击“继续”。",
            )

    # ------------------------------------------------------------------
    def shutdown(self) -> None:
        try:
            self.csv_thread.stop()
            self.csv_thread.join(timeout=3.0)
        except Exception:
            pass
        # 清理崩溃遗留的 CSV 临时文件
        self._cleanup_tmp_files()

    def _cleanup_tmp_files(self) -> None:
        try:
            with self.repo.session() as s:
                from sqlalchemy import select

                from .persistence.models import ExportState

                states = list(s.execute(select(ExportState)).scalars())
            for state in states:
                if not state.csv_path:
                    continue
                parent = Path(state.csv_path).parent
                if parent.exists():
                    for tmp in parent.glob("*.tmp"):
                        try:
                            tmp.unlink()
                        except OSError:
                            pass
        except Exception as exc:
            logger.warning("清理临时文件失败: %s", exc)
