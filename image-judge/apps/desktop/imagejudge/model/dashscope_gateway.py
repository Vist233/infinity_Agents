"""DashScope（阿里云百炼）BYOK 直连网关（文档 §8.2、§10）。

用户自带 API Key 直连百炼 OpenAI 兼容接口，不经过平台 Worker。
Key 只在当前进程内存中使用；不写系统钥匙串、SQLite、CSV 或日志。
"""
from __future__ import annotations

import logging
import time

import httpx

from .. import config
from ..core.prompting import REPAIR_SUFFIX
from .gateway import EvaluateRequest, GatewayRawResult, ModelGateway
from .schemas import GatewayError, json_schema_dict

logger = logging.getLogger("imagejudge.gateway.dashscope")


class DashScopeGateway(ModelGateway):
    name = "dashscope-byok"

    def __init__(self, api_key: str, base_url: str | None = None, client: httpx.AsyncClient | None = None):
        if not api_key:
            raise GatewayError("AUTH_EXPIRED", "缺少百炼 API Key", retryable=False)
        self._api_key = api_key
        self._base_url = (base_url or config.DASHSCOPE_BASE_URL).rstrip("/")
        self._owns_client = client is None
        self._client = client or httpx.AsyncClient(
            timeout=httpx.Timeout(config.DEFAULT_TIMEOUT_SECONDS, connect=config.CONNECT_TIMEOUT_SECONDS)
        )
        self._use_json_schema = True

    def _build_messages(self, req: EvaluateRequest) -> list[dict]:
        """构造两图请求：image[0]=REFERENCE，image[1]=TARGET，顺序严格固定。"""
        user_text = req.user_prompt + (REPAIR_SUFFIX if req.repair else "")
        return [
            {"role": "system", "content": req.system_prompt},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": user_text},
                    {"type": "image_url", "image_url": {"url": req.reference_data_url}},
                    {"type": "image_url", "image_url": {"url": req.target_data_url}},
                ],
            },
        ]

    def _response_format(self) -> dict:
        if self._use_json_schema:
            return {
                "type": "json_schema",
                "json_schema": {
                    "name": "evaluation_result",
                    "schema": json_schema_dict(),
                },
            }
        return {"type": "json_object"}

    async def evaluate(self, req: EvaluateRequest) -> GatewayRawResult:
        url = f"{self._base_url}/chat/completions"
        payload = {
            "model": config.MODEL_ID,
            "messages": self._build_messages(req),
            "temperature": config.DEFAULT_TEMPERATURE,
            "max_tokens": config.DEFAULT_MAX_TOKENS,
            "response_format": self._response_format(),
        }
        headers = {
            "Authorization": f"Bearer {self._api_key}",
            "Content-Type": "application/json",
            "X-DashScope-DataInspection": "disable",
        }
        start = time.monotonic()
        try:
            resp = await self._client.post(
                url, json=payload, headers=headers, timeout=req.timeout_seconds
            )
        except httpx.TimeoutException as exc:
            raise GatewayError(config.ERR_TIMEOUT, f"请求超时: {exc}", retryable=True) from exc
        except httpx.HTTPError as exc:
            raise GatewayError(config.ERR_NETWORK, f"网络错误: {exc}", retryable=True) from exc

        latency_ms = int((time.monotonic() - start) * 1000)
        request_id = resp.headers.get("x-request-id") or resp.headers.get("x-dashscope-request-id", "")

        if resp.status_code == 401 or resp.status_code == 403:
            raise GatewayError(
                config.ERR_AUTH_EXPIRED,
                "百炼 API Key 无效或无权限，请检查 Key",
                retryable=False,
                request_id=request_id,
                status_code=resp.status_code,
            )
        if resp.status_code == 429:
            retry_after = _parse_retry_after(resp.headers.get("Retry-After"))
            raise GatewayError(
                config.ERR_RATE_LIMITED,
                "百炼限流，请稍后重试",
                retryable=True,
                retry_after=retry_after,
                request_id=request_id,
                status_code=429,
            )
        if resp.status_code >= 500:
            raise GatewayError(
                config.ERR_MODEL_ERROR,
                f"模型服务错误 {resp.status_code}",
                retryable=True,
                request_id=request_id,
                status_code=resp.status_code,
            )
        if resp.status_code != 200:
            # 若 json_schema 不被支持，降级到 json_object 重试
            if self._use_json_schema and resp.status_code == 400 and "response_format" in resp.text:
                self._use_json_schema = False
                logger.info("百炼不支持 response_format=json_schema，降级为 json_object")
                return await self.evaluate(req)
            raise GatewayError(
                config.ERR_MODEL_ERROR,
                f"请求失败 {resp.status_code}: {resp.text[:300]}",
                retryable=False,
                request_id=request_id,
                status_code=resp.status_code,
            )

        data = resp.json()
        try:
            raw_text = data["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError) as exc:
            raise GatewayError(
                config.ERR_INVALID_OUTPUT,
                "响应结构异常，缺少 choices/message/content",
                retryable=True,
                request_id=request_id,
            ) from exc

        usage = data.get("usage", {})
        return GatewayRawResult(
            raw_text=raw_text,
            request_id=request_id,
            latency_ms=latency_ms,
            diagnostics={
                "model": data.get("model", config.MODEL_ID),
                "input_tokens": usage.get("prompt_tokens"),
                "output_tokens": usage.get("completion_tokens"),
            },
        )

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()


def _parse_retry_after(value: str | None) -> float | None:
    if not value:
        return None
    try:
        return float(value)
    except ValueError:
        return None
