"""全局配置与常量。

集中定义应用名称、数据目录、模型参数、提示词版本与默认运行参数。
平台模型密钥、OIDC client secret 等敏感信息绝不在此出现。
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# 应用基本信息
# ---------------------------------------------------------------------------
APP_NAME = "ImageJudge"
APP_DISPLAY_NAME = "本地视觉批量判定客户端"
APP_VERSION = "0.2.0"

# ---------------------------------------------------------------------------
# 模型配置
# ---------------------------------------------------------------------------
MODEL_ID = "qwen3-vl-235b-a22b-instruct"

# 提示词与输出 Schema 版本（写入每条结果，用于审计）
PROMPT_VERSION = "2.0"
OUTPUT_SCHEMA_VERSION = "2.0"

# 阿里云百炼（DashScope）OpenAI 兼容接口默认 Base URL（BYOK 直连）
DASHSCOPE_BASE_URL = os.environ.get(
    "IMAGEJUDGE_DASHSCOPE_BASE_URL",
    "https://dashscope.aliyuncs.com/compatible-mode/v1",
)

# Cloudflare 桌面授权桥接 / API Worker 域名
WORKER_BASE_URL = os.environ.get(
    "IMAGEJUDGE_WORKER_BASE_URL",
    "https://infinity.zhangyvjing.com/image-judge",
)

# Zhang Auth OIDC（仅供 Worker 侧参考；客户端不直接访问 token endpoint）
ZHANG_AUTH_ISSUER = "https://auth.zhangyvjing.com"

# ---------------------------------------------------------------------------
# 运行参数默认值
# ---------------------------------------------------------------------------
DEFAULT_TIMEOUT_SECONDS = 120.0
CONNECT_TIMEOUT_SECONDS = 10.0
DEFAULT_MAX_RETRIES = 2
DEFAULT_TEMPERATURE = 0.0
DEFAULT_MAX_TOKENS = 2048

# 平台模式由 Worker 硬性限制为单并发；BYOK 默认 5，可由用户调整。
PLATFORM_CONCURRENCY = 1
DEFAULT_BYOK_CONCURRENCY = 5
MAX_BYOK_CONCURRENCY = 16

# 每日平台额度（由 Worker 强制，客户端仅用于展示）
DAILY_QUOTA = 30

# ---------------------------------------------------------------------------
# 图片处理
# ---------------------------------------------------------------------------
SUPPORTED_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}
MAX_IMAGE_LONG_SIDE = 2048          # 超过时按比例缩放，禁止拉伸
MAX_IMAGE_BYTES = 10 * 1024 * 1024  # 单张原图上限 10MB
JPEG_QUALITY = 90

# ---------------------------------------------------------------------------
# 重试与恢复
# ---------------------------------------------------------------------------
RETRY_BACKOFF_BASE_SECONDS = 2.0
RETRY_BACKOFF_MAX_SECONDS = 60.0
CSV_SYNC_BACKOFF_BASE_SECONDS = 2.0
CSV_SYNC_BACKOFF_MAX_SECONDS = 30.0
CSV_SYNC_POLL_SECONDS = 0.5
PROCESSING_RECLAIM_SECONDS = 0      # 启动恢复：遗留 PROCESSING 立即回收

# ---------------------------------------------------------------------------
# 数据目录
# ---------------------------------------------------------------------------


def _base_data_dir() -> Path:
    """跨平台的用户数据根目录（Windows 为 %LOCALAPPDATA%）。"""
    if sys.platform == "win32":
        base = Path(os.environ.get("LOCALAPPDATA") or (Path.home() / "AppData" / "Local"))
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support"
    else:
        base = Path(os.environ.get("XDG_DATA_HOME") or (Path.home() / ".local" / "share"))
    return base / APP_NAME


def app_data_dir() -> Path:
    return _base_data_dir() / "data"


def app_logs_dir() -> Path:
    return _base_data_dir() / "logs"


def app_run_logs_dir() -> Path:
    return app_logs_dir() / "runs"


def app_cache_dir() -> Path:
    return _base_data_dir() / "cache" / "thumbnails"


def app_config_dir() -> Path:
    return _base_data_dir() / "config"


def database_path() -> Path:
    return app_data_dir() / "app.db"


def ensure_app_dirs() -> None:
    """启动时创建全部本地数据目录。"""
    for d in (
        app_data_dir(),
        app_logs_dir(),
        app_run_logs_dir(),
        app_cache_dir(),
        app_config_dir(),
    ):
        d.mkdir(parents=True, exist_ok=True)


# loopback 登录回调允许的范围（仅本机）
LOOPBACK_HOST = "127.0.0.1"
CUSTOM_SCHEME_REDIRECT = "imagejudge://auth/callback"
LOGIN_TIMEOUT_SECONDS = 300

# 错误码常量（与 Worker 标准错误响应保持一致）
ERR_CONCURRENCY_LIMIT = "CONCURRENCY_LIMIT"
ERR_RATE_LIMITED = "RATE_LIMITED"
ERR_AUTH_EXPIRED = "AUTH_EXPIRED"
ERR_QUOTA_EXCEEDED = "QUOTA_EXCEEDED"
ERR_MODEL_ERROR = "MODEL_ERROR"
ERR_INVALID_IMAGE = "INVALID_IMAGE"
ERR_INVALID_OUTPUT = "INVALID_OUTPUT"
ERR_FILE_INVALID = "FILE_INVALID"
ERR_MODEL_OUTPUT_INVALID = "MODEL_OUTPUT_INVALID"
ERR_NETWORK = "NETWORK_ERROR"
ERR_TIMEOUT = "TIMEOUT"
ERR_PLATFORM_MODEL_NOT_CONFIGURED = "PLATFORM_MODEL_NOT_CONFIGURED"
