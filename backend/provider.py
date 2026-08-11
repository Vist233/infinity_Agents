"""Single-model provider profile and capability checks.

The local MVP has one model boundary.  The provider may be StepFun, an
OpenAI-compatible spy, or another compatible endpoint, but callers never
choose a provider per request and credentials never enter task payloads.
"""

from __future__ import annotations

import os
import json
from dataclasses import dataclass
from typing import Any, Optional

import httpx

from backend.security import SecurityBoundaryError, redact_secrets, validate_outbound_url


def _sse_payloads(lines: list[str]) -> list[dict[str, Any]]:
    """Decode bounded JSON SSE data without retaining provider content."""
    payloads: list[dict[str, Any]] = []
    for line in lines:
        if not line.startswith("data:"):
            continue
        data = line[5:].strip()
        if not data or data == "[DONE]":
            continue
        try:
            value = json.loads(data)
        except ValueError:
            continue
        if isinstance(value, dict):
            payloads.append(value)
    return payloads


@dataclass(frozen=True)
class ProviderProfile:
    purpose: str
    protocol: str
    base_url: str
    model_id: str
    api_key: Optional[str]

    @classmethod
    def from_environment(cls, purpose: str = "analysis") -> "ProviderProfile":
        if purpose != "analysis":
            raise ValueError("the local MVP exposes one analysis model profile")
        base_url = (
            os.getenv("ANALYSIS_PROVIDER_BASE_URL")
            or os.getenv("STEPFUN_BASE_URL")
            or "https://api.stepfun.com/v1"
        ).strip().rstrip("/")
        model_id = (
            os.getenv("ANALYSIS_MODEL_ID")
            or os.getenv("STEPFUN_MODEL_ID")
            or "step-3.5-flash"
        ).strip()
        api_key = (
            os.getenv("ANALYSIS_PROVIDER_API_KEY")
            or os.getenv("STEPFUN_API_KEY")
        )
        if not model_id or len(model_id) > 200:
            raise SecurityBoundaryError("analysis model ID is missing or too long")
        local_http = os.getenv("APP_ENV", "development").lower() in {"development", "test", "acceptance"}
        validated = validate_outbound_url(
            base_url,
            allow_http_local=local_http,
            allow_hosts={"localhost", "127.0.0.1", "::1"} if local_http else None,
        )
        return cls(
            purpose=purpose,
            protocol="openai-compatible-chat-completions",
            base_url=validated,
            model_id=model_id,
            api_key=api_key.strip() if api_key else None,
        )


async def probe_provider(profile: ProviderProfile, *, timeout: float = 5.0) -> dict[str, Any]:
    """Probe the provider without requiring a ``/models`` endpoint.

    A 404/405 is a valid result for providers that intentionally omit model
    discovery.  The probe only records protocol metadata and never logs the
    API key or response body.
    """

    url = f"{profile.base_url}/models"
    try:
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=False) as client:
            response = await client.get(url)
        if response.status_code in {404, 405}:
            return {"reachable": True, "models_endpoint": "not_supported", "status_code": response.status_code}
        if response.status_code >= 400:
            return {"reachable": False, "models_endpoint": "error", "status_code": response.status_code}
        payload = response.json()
        return {
            "reachable": True,
            "models_endpoint": "supported",
            "status_code": response.status_code,
            "model_count": len(payload.get("data", [])) if isinstance(payload, dict) else 0,
        }
    except Exception as exc:
        return {"reachable": False, "models_endpoint": "error", "error": redact_secrets(exc, max_chars=300)}


async def probe_analysis_capabilities(profile: ProviderProfile, *, timeout: float = 10.0) -> dict[str, Any]:
    """Run stream/tool/JSON-schema Analysis checks using synthetic content only."""
    headers = {"Content-Type": "application/json"}
    if profile.api_key:
        headers["Authorization"] = f"Bearer {profile.api_key}"
    body = {
        "model": profile.model_id,
        "messages": [
            {"role": "system", "content": "Return only the word READY."},
            {"role": "user", "content": "provider-probe"},
        ],
        "temperature": 0,
        "max_tokens": 8,
    }
    result = {"protocol": profile.protocol, "model_id": profile.model_id, "models": await probe_provider(profile, timeout=timeout)}
    try:
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=False) as client:
            response = await client.post(f"{profile.base_url}/chat/completions", headers=headers, json=body)
            tool_response = await client.post(
                f"{profile.base_url}/chat/completions",
                headers=headers,
                json={**body, "tools": [{"type": "function", "function": {"name": "probe_tool", "parameters": {"type": "object"}}}]},
            )
            schema_response = await client.post(
                f"{profile.base_url}/chat/completions",
                headers=headers,
                json={**body, "response_format": {"type": "json_schema", "json_schema": {"name": "probe", "schema": {"type": "object"}}}},
            )
            stream_lines: list[str] = []
            async with client.stream(
                "POST", f"{profile.base_url}/chat/completions", headers=headers,
                json={**body, "stream": True},
            ) as stream_response:
                async for line in stream_response.aiter_lines():
                    stream_lines.append(line[:2000])
                    if len(stream_lines) >= 100:
                        break
        if response.status_code in {401, 403}:
            return {**result, "ready": False, "chat": "unauthorized", "status_code": response.status_code}
        if response.status_code >= 400:
            return {**result, "ready": False, "chat": "error", "status_code": response.status_code}
        payload = response.json()
        choices = payload.get("choices", []) if isinstance(payload, dict) else []
        tool_payload = tool_response.json() if tool_response.status_code < 400 else {}
        schema_payload = schema_response.json() if schema_response.status_code < 400 else {}
        stream_payloads = _sse_payloads(stream_lines)
        has_tool = any(
            isinstance(choice, dict) and (choice.get("message") or {}).get("tool_calls")
            for choice in tool_payload.get("choices", [])
        )
        schema_content = ""
        schema_choices = schema_payload.get("choices", [])
        if schema_choices and isinstance(schema_choices[0], dict):
            schema_content = str((schema_choices[0].get("message") or {}).get("content") or "")
        capabilities = {
            "json": bool(choices),
            "stream": bool(stream_response.status_code < 400 and stream_payloads),
            "tool_call": bool(tool_response.status_code < 400 and has_tool),
            "json_schema": bool(schema_response.status_code < 400 and schema_content),
        }
        return {
            **result,
            "ready": all(capabilities.values()),
            "chat": "json",
            "statuses": {"chat": response.status_code, "tool_call": tool_response.status_code, "json_schema": schema_response.status_code, "stream": stream_response.status_code},
            "capabilities": capabilities,
        }
    except Exception as exc:
        return {**result, "ready": False, "chat": "error", "error": redact_secrets(exc, max_chars=300)}
