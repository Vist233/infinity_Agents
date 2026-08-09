"""结构化日志：app.log 滚动日志 + 按 run 分文件的 task.log。

日志脱敏规则：不写 Authorization、API Key、OIDC refresh token、
完整图片 Base64 或完整 prompt 中的敏感内容。
"""
from __future__ import annotations

import logging
import re
import tempfile
from logging.handlers import RotatingFileHandler
from pathlib import Path

from . import config

_SENSITIVE_PATTERNS = [
    re.compile(r"(?i)(authorization\s*[:=]\s*)bearer\s+[a-z0-9._\-]+"),
    re.compile(r"(?i)(api[_-]?key\s*[:=]\s*)[a-z0-9._\-]{8,}"),
    re.compile(r"(?i)(refresh[_-]?token\s*[:=]\s*)[a-z0-9._\-]{8,}"),
    re.compile(r"(?i)(access[_-]?token\s*[:=]\s*)[a-z0-9._\-]{8,}"),
]


def redact(text: str) -> str:
    """对日志文本做基础脱敏。"""
    for pat in _SENSITIVE_PATTERNS:
        text = pat.sub(lambda m: m.group(1) + "***", text)
    return text


class _RedactFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        return redact(super().format(record))


_FORMAT = "%(asctime)s [%(levelname)s] %(name)s: %(message)s"


def setup_logging(verbose: bool = False) -> logging.Logger:
    """初始化全局日志：控制台 + app.log（10MB x 5 滚动）。"""
    config.ensure_app_dirs()
    root = logging.getLogger()
    root.setLevel(logging.DEBUG if verbose else logging.INFO)

    # 清理重复 handler（重复调用 setup 时）
    for h in list(root.handlers):
        root.removeHandler(h)

    fmt = _RedactFormatter(_FORMAT)

    console = logging.StreamHandler()
    console.setLevel(logging.DEBUG if verbose else logging.INFO)
    console.setFormatter(fmt)
    root.addHandler(console)

    file_handler = RotatingFileHandler(
        config.app_logs_dir() / "app.log",
        maxBytes=10 * 1024 * 1024,
        backupCount=5,
        encoding="utf-8",
    )
    file_handler.setLevel(logging.DEBUG)
    file_handler.setFormatter(fmt)
    root.addHandler(file_handler)

    return logging.getLogger("imagejudge")


class RunLogger:
    """按 run 分文件的任务日志（logs/runs/<run_id>.log）。"""

    def __init__(self, run_id: int | str):
        path: Path = config.app_run_logs_dir() / f"{run_id}.log"
        path.parent.mkdir(parents=True, exist_ok=True)
        self._logger = logging.getLogger(f"imagejudge.run.{run_id}")
        self._logger.setLevel(logging.DEBUG)
        self._logger.propagate = False
        if not self._logger.handlers:
            try:
                handler = logging.FileHandler(path, encoding="utf-8")
            except (OSError, PermissionError):
                # A locked-down desktop/test account may not be able to create
                # the platform default Application Support directory.  Keep
                # run logging alive in a private temp directory instead of
                # failing the whole task engine.
                fallback = Path(tempfile.gettempdir()) / "imagejudge" / "logs" / "runs" / f"{run_id}.log"
                fallback.parent.mkdir(parents=True, exist_ok=True)
                handler = logging.FileHandler(fallback, encoding="utf-8")
            handler.setFormatter(_RedactFormatter(_FORMAT))
            self._logger.addHandler(handler)

    def info(self, msg: str, *args) -> None:
        self._logger.info(msg, *args)

    def warning(self, msg: str, *args) -> None:
        self._logger.warning(msg, *args)

    def error(self, msg: str, *args) -> None:
        self._logger.error(msg, *args)

    def debug(self, msg: str, *args) -> None:
        self._logger.debug(msg, *args)
