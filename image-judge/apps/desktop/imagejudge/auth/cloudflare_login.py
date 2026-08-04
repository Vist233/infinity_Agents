"""平台账号登录：Cloudflare 桌面授权桥接 + 两层 PKCE（文档 §8.1）。

桌面端是 public client，不接触 Zhang Auth client secret：
1. 桌面端生成 state / code_verifier / S256 challenge，启动本机 loopback 回调。
2. 系统浏览器打开桥接 Worker /desktop/authorize。
3. Worker 完成 Zhang Auth OIDC 登录后，重定向回 loopback 携带一次性 code。
4. 桌面端 POST /desktop/token 交换平台代理 access/refresh token。
refresh token 只存当前进程内存，退出后需要重新登录。
"""
from __future__ import annotations

import base64
import hashlib
import http.server
import logging
import secrets
import threading
import time
import urllib.parse
import webbrowser
from dataclasses import dataclass

import httpx

from .. import config

logger = logging.getLogger("imagejudge.auth")


class LoginError(RuntimeError):
    pass


# ---------------------------------------------------------------------------
# loopback 一次性回调服务器
# ---------------------------------------------------------------------------
class _CallbackHandler(http.server.BaseHTTPRequestHandler):
    server_version = "ImageJudgeAuth/0.1"

    def do_GET(self):  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path != "/callback":
            self.send_response(404)
            self.end_headers()
            return
        params = urllib.parse.parse_qs(parsed.query)
        self.server.result = {  # type: ignore[attr-defined]
            "code": params.get("code", [""])[0],
            "state": params.get("state", [""])[0],
            "error": params.get("error", [""])[0],
        }
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(
            "<html><body style='font-family:sans-serif'>"
            "<h3>Login complete. You can close this page and return to ImageJudge.</h3>"
            "</body></html>".encode("utf-8")
        )
        threading.Thread(target=self.server.shutdown, daemon=True).start()

    def log_message(self, fmt, *args):  # 静默
        return


@dataclass
class LoopbackServer:
    server: http.server.HTTPServer
    port: int
    redirect_uri: str
    thread: threading.Thread

    @property
    def result(self) -> dict | None:
        return getattr(self.server, "result", None)

    def wait(self, timeout: float) -> dict | None:
        self.thread.join(timeout)
        return self.result

    def close(self) -> None:
        try:
            self.server.server_close()
        except OSError:
            pass


def start_loopback_server() -> LoopbackServer:
    """在本机随机端口启动一次性回调服务（文档 §8.1 步骤 1）。"""
    for _ in range(5):
        port = secrets.randbelow(20000) + 30000
        try:
            server = http.server.HTTPServer((config.LOOPBACK_HOST, port), _CallbackHandler)
        except OSError:
            continue
        server.result = None  # type: ignore[attr-defined]
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        return LoopbackServer(
            server=server,
            port=port,
            redirect_uri=f"http://{config.LOOPBACK_HOST}:{port}/callback",
            thread=thread,
        )
    raise LoginError("Unable to start a local login callback port")


# ---------------------------------------------------------------------------
# PKCE 工具
# ---------------------------------------------------------------------------
def generate_pkce() -> tuple[str, str]:
    verifier = secrets.token_urlsafe(48)
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    challenge = base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
    return verifier, challenge


# ---------------------------------------------------------------------------
# 桌面授权客户端
# ---------------------------------------------------------------------------
class DesktopAuthClient:
    """对接桥接 Worker 的 authorize/token/refresh/logout 契约（文档 §19.1）。"""

    def __init__(self, credential_store, base_url: str | None = None):
        self._store = credential_store
        self._base_url = (base_url or config.WORKER_BASE_URL).rstrip("/")
        self._access_token: str | None = None
        self._expires_at: float = 0.0
        self.user_email: str = ""
        self.user_name: str = ""

    # ---------------- 登录流程（阻塞，供登录线程调用） ----------------
    def login_blocking(self, timeout: float | None = None) -> dict:
        """完整登录：打开浏览器 → 等待回调 → 交换 token。返回用户信息。"""
        timeout = timeout or config.LOGIN_TIMEOUT_SECONDS
        verifier, challenge = generate_pkce()
        state = secrets.token_urlsafe(24)
        loopback = start_loopback_server()
        try:
            authorize_url = (
                f"{self._base_url}/desktop/authorize?"
                + urllib.parse.urlencode(
                    {
                        "redirect_uri": loopback.redirect_uri,
                        "state": state,
                        "code_challenge": challenge,
                        "code_challenge_method": "S256",
                    }
                )
            )
            logger.info("打开系统浏览器进行平台登录")
            if not webbrowser.open(authorize_url):
                raise LoginError(f"Unable to open the browser. Open this URL manually: {authorize_url}")

            result = loopback.wait(timeout)
            if result is None:
                raise LoginError("Login timed out: no callback was received")
            if result.get("error"):
                raise LoginError(f"Login failed: {result['error']}")
            if result.get("state") != state:
                raise LoginError("Login callback state validation failed")
            code = result.get("code")
            if not code:
                raise LoginError("Login callback is missing code")
            return self._exchange_code(code, verifier, loopback.redirect_uri)
        finally:
            loopback.close()

    def _exchange_code(self, code: str, verifier: str, redirect_uri: str) -> dict:
        resp = httpx.post(
            f"{self._base_url}/desktop/token",
            data={
                "code": code,
                "code_verifier": verifier,
                "redirect_uri": redirect_uri,
            },
            timeout=30.0,
        )
        if resp.status_code != 200:
            raise LoginError(f"Token exchange failed: {resp.status_code} {resp.text[:200]}")
        data = resp.json()
        self._apply_tokens(data)
        self.user_email = data.get("email", "")
        self.user_name = data.get("name", "")
        logger.info("Platform login succeeded: %s", self.user_email)
        return {"email": self.user_email, "name": self.user_name}

    def _apply_tokens(self, data: dict) -> None:
        self._access_token = data.get("access_token")
        expires_in = float(data.get("expires_in", 900))
        self._expires_at = time.monotonic() + expires_in
        refresh = data.get("refresh_token")
        if refresh:
            # refresh token 只存当前进程内存
            self._store.set("platform.refresh_token", refresh)

    # ---------------- 令牌获取 / 刷新（异步，供网关调用） ----------------
    async def get_access_token(self, force_refresh: bool = False) -> str:
        if not force_refresh and self._access_token and time.monotonic() < self._expires_at - 30:
            return self._access_token
        refresh = self._store.get("platform.refresh_token")
        if not refresh:
            raise LoginError("No valid platform credentials; please sign in again")
        await self._refresh_async(refresh)
        return self._access_token or ""

    async def _refresh_async(self, refresh_token: str) -> None:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                f"{self._base_url}/desktop/refresh",
                data={"refresh_token": refresh_token},
            )
        if resp.status_code != 200:
            raise LoginError("Platform token refresh failed; please sign in again")
        self._apply_tokens(resp.json())

    # ---------------- 注销（文档 §8.4） ----------------
    def logout(self) -> None:
        refresh = self._store.get("platform.refresh_token")
        try:
            httpx.post(
                f"{self._base_url}/desktop/logout",
                data={"refresh_token": refresh or ""},
                timeout=15.0,
            )
        except httpx.HTTPError as exc:
            logger.warning("Logout request failed (ignored): %s", exc)
        self._access_token = None
        self._expires_at = 0.0
        self._store.clear_platform()
        self.user_email = ""
        self.user_name = ""

    def has_saved_refresh_token(self) -> bool:
        return bool(self._store.get("platform.refresh_token"))
