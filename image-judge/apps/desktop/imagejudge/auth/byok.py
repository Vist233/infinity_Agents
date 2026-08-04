"""BYOK：用户手动填写的阿里云百炼 API Key（文档 §8.2）。

- Key 只存当前进程内存，不上传平台、不写 SQLite/CSV/日志，也不接触系统钥匙串。
- 平台每日 30 次额度与并发限制不适用于 BYOK；额度由用户账户负责。
- 客户端仍固定并发 1。
"""
from __future__ import annotations

import logging

import httpx

from .. import config
logger = logging.getLogger("imagejudge.auth.byok")


class ByokError(RuntimeError):
    pass


class ByokSession:
    def __init__(self):
        self._api_key: str | None = None

    def set_key(self, api_key: str) -> None:
        """设置本次进程使用的 Key。"""
        self._api_key = api_key.strip()

    def get_key(self) -> str | None:
        return self._api_key

    def clear(self) -> None:
        self._api_key = None

    def verify_key(self, api_key: str | None = None, timeout: float = 20.0) -> bool:
        """用受保护的 models 列表接口验证 Key 有效性。"""
        key = api_key or self._api_key
        if not key:
            raise ByokError("请先填写 API Key")
        url = f"{config.DASHSCOPE_BASE_URL.rstrip('/')}/models"
        try:
            resp = httpx.get(
                url,
                headers={"Authorization": f"Bearer {key}"},
                timeout=timeout,
            )
        except httpx.HTTPError as exc:
            raise ByokError(f"无法连接百炼服务: {exc}") from exc
        if resp.status_code == 401 or resp.status_code == 403:
            raise ByokError("API Key 无效或没有权限")
        if resp.status_code != 200:
            raise ByokError(f"验证失败: HTTP {resp.status_code}")
        return True
