"""登录页：平台账号登录 / 使用自己的 Token（文档 §6.1）。

- 平台登录优先系统浏览器；成功后只接收一次性 code。
- BYOK 验证手动输入的 Key 后进入主界面；Key 只在本次进程内存中使用。
- 无可用 Token 时不能发起模型判断，但可打开历史任务（离线说明）。
"""
from __future__ import annotations

import logging

from PySide6.QtCore import QObject, QThread, Qt, Signal
from PySide6.QtWidgets import (
    QCheckBox,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMessageBox,
    QPushButton,
    QStackedWidget,
    QTabWidget,
    QVBoxLayout,
    QWidget,
)

from ..auth.byok import ByokError

logger = logging.getLogger("imagejudge.ui.login")


class _PlatformLoginWorker(QObject):
    finished_ok = Signal(dict)
    finished_err = Signal(str)

    def __init__(self, auth_client):
        super().__init__()
        self._auth = auth_client

    def run(self) -> None:
        try:
            info = self._auth.login_blocking()
            self.finished_ok.emit(info)
        except Exception as exc:
            logger.exception("平台登录失败")
            self.finished_err.emit(str(exc))


class _ByokVerifyWorker(QObject):
    finished_ok = Signal()
    finished_err = Signal(str)

    def __init__(self, byok_session, api_key: str):
        super().__init__()
        self._byok = byok_session
        self._api_key = api_key

    def run(self) -> None:
        try:
            self._byok.verify_key(self._api_key)
            self._byok.set_key(self._api_key)
            self.finished_ok.emit()
        except ByokError as exc:
            self.finished_err.emit(str(exc))
        except Exception as exc:  # pragma: no cover
            self.finished_err.emit(f"验证失败: {exc}")


class LoginWindow(QWidget):
    login_succeeded = Signal(str)  # mode: "platform" | "byok"

    def __init__(self, session, parent=None):
        super().__init__(parent)
        self._session = session
        self._thread: QThread | None = None
        self._worker: QObject | None = None
        self.setWindowTitle("ImageJudge 登录")
        self.resize(560, 460)
        self._build_ui()

    def _build_ui(self) -> None:
        root = QVBoxLayout(self)

        title = QLabel("本地视觉批量判定客户端")
        title.setStyleSheet("font-size: 20px; font-weight: bold;")
        title.setAlignment(Qt.AlignCenter)
        subtitle = QLabel("请选择登录方式后开始使用")
        subtitle.setAlignment(Qt.AlignCenter)
        root.addWidget(title)
        root.addWidget(subtitle)

        self._tabs = QTabWidget()
        self._tabs.addTab(self._build_platform_tab(), "平台账号登录")
        self._tabs.addTab(self._build_byok_tab(), "使用自己的 Token")
        root.addWidget(self._tabs)

        self._status = QLabel("")
        self._status.setWordWrap(True)
        self._status.setAlignment(Qt.AlignCenter)
        root.addWidget(self._status)

        offline = QLabel(
            "提示：没有可用 Token 时无法发起模型判断，但仍可以打开历史任务查看结果。"
        )
        offline.setWordWrap(True)
        offline.setStyleSheet("color: #666;")
        root.addWidget(offline)

        self._open_history_btn = QPushButton("打开历史任务（离线）")
        self._open_history_btn.clicked.connect(lambda: self.login_succeeded.emit("offline"))
        root.addWidget(self._open_history_btn)

    # ---------------- 平台登录 ----------------
    def _build_platform_tab(self) -> QWidget:
        page = QWidget()
        layout = QVBoxLayout(page)
        layout.addWidget(
            QLabel("使用平台账号登录：将在系统浏览器中完成 Zhang Auth 认证。")
        )
        note = QLabel("平台模式每用户每天最多 30 次判断，同时仅 1 个在途请求。")
        note.setWordWrap(True)
        note.setStyleSheet("color: #666;")
        layout.addWidget(note)
        self._platform_btn = QPushButton("在浏览器中登录")
        self._platform_btn.clicked.connect(self._start_platform_login)
        layout.addWidget(self._platform_btn)
        layout.addStretch()
        return page

    def _start_platform_login(self) -> None:
        self._set_busy(True, "正在打开浏览器，请完成登录…")
        self._worker = _PlatformLoginWorker(self._session.auth)
        self._thread = QThread(self)
        self._worker.moveToThread(self._thread)
        self._thread.started.connect(self._worker.run)
        self._worker.finished_ok.connect(self._on_platform_ok)
        self._worker.finished_err.connect(self._on_platform_err)
        self._worker.finished_ok.connect(self._thread.quit)
        self._worker.finished_err.connect(self._thread.quit)
        self._thread.start()

    def _on_platform_ok(self, info: dict) -> None:
        self._session.mode = "platform"
        email = info.get("email", "")
        self._set_busy(False, f"Login successful: {email}")
        self.login_succeeded.emit("platform")

    def _on_platform_err(self, message: str) -> None:
        self._set_busy(False, "")
        QMessageBox.critical(self, "Platform login failed", message)

    # ---------------- BYOK ----------------
    def _build_byok_tab(self) -> QWidget:
        page = QWidget()
        layout = QVBoxLayout(page)
        layout.addWidget(QLabel("填写你的阿里云百炼 API Key，客户端将直连百炼（不经平台）。"))
        self._key_edit = QLineEdit()
        self._key_edit.setPlaceholderText("sk-...")
        self._key_edit.setEchoMode(QLineEdit.Password)
        layout.addWidget(self._key_edit)

        self._show_key = QCheckBox("显示 Key")
        self._show_key.toggled.connect(self._toggle_show_key)
        layout.addWidget(self._show_key)

        self._byok_btn = QPushButton("验证并进入")
        self._byok_btn.clicked.connect(self._start_byok)
        layout.addWidget(self._byok_btn)

        privacy = QLabel("你的 Key 只用于本次本地运行，不上传平台，不写入 SQLite、CSV、日志或系统钥匙串。")
        privacy.setWordWrap(True)
        privacy.setStyleSheet("color: #666;")
        layout.addWidget(privacy)
        layout.addStretch()
        return page

    def _toggle_show_key(self, checked: bool) -> None:
        self._key_edit.setEchoMode(QLineEdit.Normal if checked else QLineEdit.Password)

    def _start_byok(self) -> None:
        api_key = self._key_edit.text().strip()
        if not api_key:
            QMessageBox.warning(self, "缺少 Key", "请先填写阿里云百炼 API Key")
            return
        self._set_busy(True, "正在验证 API Key…")
        self._worker = _ByokVerifyWorker(self._session.byok, api_key)
        self._thread = QThread(self)
        self._worker.moveToThread(self._thread)
        self._thread.started.connect(self._worker.run)
        self._worker.finished_ok.connect(self._on_byok_ok)
        self._worker.finished_err.connect(self._on_byok_err)
        self._worker.finished_ok.connect(self._thread.quit)
        self._worker.finished_err.connect(self._thread.quit)
        self._thread.start()

    def _on_byok_ok(self) -> None:
        self._session.mode = "byok"
        self._set_busy(False, "API key verified")
        self.login_succeeded.emit("byok")

    def _on_byok_err(self, message: str) -> None:
        self._set_busy(False, "")
        QMessageBox.critical(self, "验证失败", message)

    # ---------------- 公共 ----------------
    def _set_busy(self, busy: bool, message: str) -> None:
        self._platform_btn.setEnabled(not busy)
        self._byok_btn.setEnabled(not busy)
        self._status.setText(message)

    def closeEvent(self, event):  # noqa: N802
        if self._thread is not None and self._thread.isRunning():
            self._thread.quit()
            self._thread.wait(2000)
        super().closeEvent(event)
