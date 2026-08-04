"""应用会话：聚合 Repository、凭据、认证与网关工厂。

mode:
- "platform": 平台账号登录（Worker 代理）
- "byok":     用户自带百炼 Key（直连）
- "offline":  仅查看历史任务，不能发起判断
"""
from __future__ import annotations

from .auth.byok import ByokSession
from .auth.cloudflare_login import DesktopAuthClient
from .auth.credential_store import CredentialStore
from .model.dashscope_gateway import DashScopeGateway
from .model.gateway import ModelGateway
from .model.worker_gateway import WorkerGateway
from .persistence.repository import Repository


class AppSession:
    def __init__(self, repo: Repository | None = None):
        self.repo = repo or Repository()
        self.store = CredentialStore()
        self.auth = DesktopAuthClient(self.store)
        self.byok = ByokSession()
        self.mode: str | None = None

    def create_gateway(self) -> ModelGateway:
        """按当前登录模式创建模型网关。"""
        if self.mode == "platform":
            return WorkerGateway(self.auth)
        if self.mode == "byok":
            key = self.byok.get_key()
            return DashScopeGateway(key or "")
        raise RuntimeError("未登录或离线模式，无法发起模型判断")

    def can_evaluate(self) -> bool:
        return self.mode in ("platform", "byok")

    def logout_platform(self) -> None:
        self.auth.logout()
        if self.mode == "platform":
            self.mode = None
