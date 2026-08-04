"""Cloudflare Worker platform proxy gateway (docs §9, §19.2).

The authenticated desktop client calls the hosted vision model through the
authorization bridge; the client never receives ``DASHSCOPE_API_KEY``.
"""
from __future__ import annotations

import json
import logging
import time
from typing import Protocol

import httpx

from .. import config
from ..core.prompting import REPAIR_SUFFIX
from .gateway import EvaluateRequest, GatewayRawResult, ModelGateway
from .schemas import GatewayError

logger = logging.getLogger("imagejudge.gateway.worker")

_MAX_TOKEN_REFRESH_PER_CALL = 1


class TokenProvider(Protocol):
    async def get_access_token(self, force_refresh: bool = False) -> str: ...


class WorkerGateway(ModelGateway):
    name = "platform-worker"

    def __init__(
        self,
        token_provider: TokenProvider,
        base_url: str | None = None,
        client: httpx.AsyncClient | None = None,
    ):
        self._tokens = token_provider
        self._base_url = (base_url or config.WORKER_BASE_URL).rstrip("/")
        self._owns_client = client is None
        self._client = client or httpx.AsyncClient(
            timeout=httpx.Timeout(config.DEFAULT_TIMEOUT_SECONDS, connect=config.CONNECT_TIMEOUT_SECONDS)
        )

    async def evaluate(self, req: EvaluateRequest) -> GatewayRawResult:
        task_rules = req.task_rules + (REPAIR_SUFFIX if req.repair else "")
        for attempt_refresh in range(_MAX_TOKEN_REFRESH_PER_CALL + 1):
            token = await self._tokens.get_access_token()
            try:
                return await self._post(req, task_rules, token)
            except GatewayError as err:
                # Refresh the token once after a 401/403 response.
                if err.status_code in (401, 403) and attempt_refresh < _MAX_TOKEN_REFRESH_PER_CALL:
                    logger.info("Platform token expired; refreshing and retrying")
                    await self._tokens.get_access_token(force_refresh=True)
                    continue
                raise
        raise GatewayError(config.ERR_AUTH_EXPIRED, "Platform authentication failed", retryable=False)

    async def _post(self, req: EvaluateRequest, task_rules: str, token: str) -> GatewayRawResult:
        url = f"{self._base_url}/api/v1/evaluate"
        headers = {"Authorization": f"Bearer {token}"}
        data = {
            "client_request_id": req.client_request_id,
            "model": config.MODEL_ID,
            "prompt_version": req.prompt_version,
            "task_rules": task_rules,
            "output_schema_version": req.output_schema_version,
        }
        start = time.monotonic()
        try:
            with open(req.reference_path, "rb") as ref, open(req.target_path, "rb") as tgt:
                files = {
                    "reference_image": (ref.name.split("\\")[-1].split("/")[-1], ref.read()),
                    "target_image": (tgt.name.split("\\")[-1].split("/")[-1], tgt.read()),
                }
            resp = await self._client.post(
                url, data=data, files=files, headers=headers, timeout=req.timeout_seconds
            )
        except httpx.TimeoutException as exc:
            raise GatewayError(config.ERR_TIMEOUT, f"Request timed out: {exc}", retryable=True) from exc
        except httpx.HTTPError as exc:
            raise GatewayError(config.ERR_NETWORK, f"Network error: {exc}", retryable=True) from exc
        except OSError as exc:
            raise GatewayError(config.ERR_FILE_INVALID, f"Unable to read image: {exc}", retryable=False) from exc

        latency_ms = int((time.monotonic() - start) * 1000)
        return self._interpret(resp, latency_ms)

    def _interpret(self, resp: httpx.Response, latency_ms: int) -> GatewayRawResult:
        retry_after = _parse_retry_after(resp.headers.get("Retry-After"))

        if resp.status_code == 429:
            body = _safe_json(resp)
            err = body.get("error", {}) if isinstance(body, dict) else {}
            code = err.get("code", config.ERR_RATE_LIMITED)
            raise GatewayError(
                code,
                err.get("message", "Platform rate limit reached"),
                retryable=code == config.ERR_CONCURRENCY_LIMIT,
                retry_after=retry_after,
                request_id=err.get("request_id", ""),
                status_code=429,
            )
        if resp.status_code in (401, 403):
            raise GatewayError(
                config.ERR_AUTH_EXPIRED,
                "Platform authentication expired; please sign in again",
                retryable=False,
                status_code=resp.status_code,
            )
        if resp.status_code >= 500:
            body = _safe_json(resp)
            err = body.get("error", {}) if isinstance(body, dict) else {}
            raise GatewayError(
                err.get("code", config.ERR_MODEL_ERROR),
                err.get("message", f"Platform service error {resp.status_code}"),
                retryable=bool(err.get("retryable", True)),
                retry_after=retry_after,
                request_id=err.get("request_id", ""),
                status_code=resp.status_code,
            )
        if resp.status_code != 200:
            body = _safe_json(resp)
            err = body.get("error", {}) if isinstance(body, dict) else {}
            raise GatewayError(
                err.get("code", config.ERR_MODEL_ERROR),
                err.get("message", f"Request failed with status {resp.status_code}"),
                retryable=bool(err.get("retryable", False)),
                request_id=err.get("request_id", ""),
                status_code=resp.status_code,
            )

        body = resp.json()
        result = body.get("result")
        if result is None:
            raise GatewayError(
                config.ERR_INVALID_OUTPUT, "Platform response is missing result", retryable=True
            )
        raw_text = result if isinstance(result, str) else json.dumps(result, ensure_ascii=False)
        diagnostics = dict(body.get("usage") or {})
        diagnostics["rate_limit_remaining"] = resp.headers.get("X-RateLimit-Remaining")
        return GatewayRawResult(
            raw_text=raw_text,
            request_id=body.get("server_request_id", ""),
            latency_ms=latency_ms,
            diagnostics=diagnostics,
        )

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()


def _safe_json(resp: httpx.Response):
    try:
        return resp.json()
    except Exception:
        return {}


def _parse_retry_after(value: str | None) -> float | None:
    if not value:
        return None
    try:
        return float(value)
    except ValueError:
        return None
