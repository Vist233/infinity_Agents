"""Project-configurable Anthropic Messages provider boundary for Coding Jobs.

The worker may use this profile to construct an attempt-scoped gateway request,
but never passes a long-lived provider credential into a Job container.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any, Optional

import httpx

from backend.security import SecurityBoundaryError, redact_secrets, validate_outbound_url


def _sse_events(lines: list[str]) -> set[str]:
    events: set[str] = set()
    for line in lines:
        if line.startswith("event:"):
            events.add(line.split(":", 1)[1].strip())
    return events


@dataclass(frozen=True)
class CodingProviderProfile:
    protocol: str
    base_url: str
    model_id: str
    api_key: Optional[str]

    @classmethod
    def from_environment(cls) -> "CodingProviderProfile":
        base_url = (
            os.getenv("ATTEMPT_GATEWAY_URL")
            or os.getenv("CODING_PROVIDER_BASE_URL")
            or os.getenv("ANTHROPIC_BASE_URL")
            or "https://api.anthropic.com/v1"
        ).strip().rstrip("/")
        model_id = (
            os.getenv("ATTEMPT_MODEL_ID")
            or os.getenv("CODING_MODEL_ID")
            or os.getenv("ANTHROPIC_MODEL")
            or os.getenv("ANTHROPIC_MODEL_ID")
            or ""
        ).strip()
        api_key = (
            os.getenv("ATTEMPT_GATEWAY_TOKEN")
            or os.getenv("ANTHROPIC_AUTH_TOKEN")
            or os.getenv("CODING_PROVIDER_API_KEY")
            or os.getenv("ANTHROPIC_API_KEY")
        )
        if not model_id or len(model_id) > 200:
            raise SecurityBoundaryError("coding model ID is missing or too long")
        local_http = os.getenv("APP_ENV", "development").lower() in {"development", "test", "acceptance"}
        validated = validate_outbound_url(
            base_url,
            allow_http_local=local_http,
            allow_hosts={"localhost", "127.0.0.1", "::1"} if local_http else None,
        )
        return cls(
            protocol="anthropic-messages",
            base_url=validated,
            model_id=model_id,
            api_key=api_key.strip() if api_key else None,
        )


async def probe_coding_provider(profile: CodingProviderProfile, *, timeout: float = 5.0) -> dict[str, Any]:
    """Perform a non-secret reachability probe.

    Anthropic-compatible providers do not have to expose model discovery. A
    404/405 is therefore recorded as a valid, reachable probe result.
    """

    try:
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=False) as client:
            response = await client.get(f"{profile.base_url}/models")
        if response.status_code in {404, 405}:
            return {"reachable": True, "models_endpoint": "not_supported", "status_code": response.status_code}
        return {
            "reachable": response.status_code < 400,
            "models_endpoint": "supported" if response.status_code < 400 else "error",
            "status_code": response.status_code,
        }
    except Exception as exc:
        return {"reachable": False, "models_endpoint": "error", "error": redact_secrets(exc, max_chars=300)}


async def probe_coding_capabilities(profile: CodingProviderProfile, *, timeout: float = 10.0) -> dict[str, Any]:
    """Probe count_tokens, non-stream Messages, stream and tool-use semantics."""
    headers = {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
    }
    if profile.api_key:
        headers["x-api-key"] = profile.api_key
    base = {
        "model": profile.model_id,
        "max_tokens": 16,
        "messages": [{"role": "user", "content": "provider-probe"}],
    }
    result: dict[str, Any] = {"protocol": profile.protocol, "model_id": profile.model_id, "models": await probe_coding_provider(profile, timeout=timeout)}
    try:
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=False) as client:
            count = await client.post(f"{profile.base_url}/messages/count_tokens", headers=headers, json=base)
            message = await client.post(f"{profile.base_url}/messages", headers=headers, json=base)
            tool = await client.post(
                f"{profile.base_url}/messages",
                headers=headers,
                json={**base, "tools": [{"name": "probe_tool", "description": "synthetic", "input_schema": {"type": "object"}}]},
            )
            stream_lines: list[str] = []
            async with client.stream("POST", f"{profile.base_url}/messages", headers=headers, json={**base, "stream": True}) as stream:
                stream_status = stream.status_code
                async for line in stream.aiter_lines():
                    stream_lines.append(line[:2000])
                    if len(stream_lines) >= 100:
                        break
        count_payload = count.json() if count.status_code < 400 else {}
        message_payload = message.json() if message.status_code < 400 else {}
        tool_payload = tool.json() if tool.status_code < 400 else {}
        tool_blocks = tool_payload.get("content", []) if isinstance(tool_payload, dict) else []
        capabilities = {
            "count_tokens": count.status_code < 400 and isinstance(count_payload, dict) and "input_tokens" in count_payload,
            "messages": message.status_code < 400 and isinstance(message_payload, dict) and message_payload.get("type") == "message",
            "stream": stream_status < 400 and {"message_start", "content_block_delta", "message_stop"}.issubset(_sse_events(stream_lines)),
            "tool_use": tool.status_code < 400 and any(isinstance(block, dict) and block.get("type") == "tool_use" for block in tool_blocks),
        }
        statuses = {"count_tokens": count.status_code, "messages": message.status_code, "stream": stream_status, "tool_use": tool.status_code}
        return {**result, "ready": all(capabilities.values()), "statuses": statuses, "capabilities": capabilities}
    except Exception as exc:
        return {**result, "ready": False, "error": redact_secrets(exc, max_chars=300)}
