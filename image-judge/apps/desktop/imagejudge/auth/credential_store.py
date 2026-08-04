"""进程内会话凭据。

客户端不读取、不写入任何系统钥匙串或凭据管理器。平台令牌和 BYOK
Key 只在当前进程的这个小容器里存在，退出程序后自然清除。
"""
from __future__ import annotations


class CredentialStore:
    """保持旧调用接口，但实现仅使用进程内存。"""

    def __init__(self):
        self._memory: dict[str, str] = {}

    def set(self, key: str, value: str) -> bool:
        self._memory[key] = value
        return True

    def get(self, key: str) -> str | None:
        return self._memory.get(key)

    def delete(self, key: str) -> None:
        self._memory.pop(key, None)

    def clear_platform(self) -> None:
        self.delete("platform.refresh_token")
        self.delete("platform.access_token")

    def clear_byok(self) -> None:
        self.delete("byok.dashscope_api_key")
