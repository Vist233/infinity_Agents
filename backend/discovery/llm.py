"""Small runtime-only Moonshot JSON client for the Discovery processor."""

from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.request
from typing import Any
from urllib.parse import urlparse


class ModelClientError(RuntimeError):
    pass


def _base_url(value: str) -> str:
    normalized = value.strip().rstrip("/")
    parsed = urlparse(normalized)
    if parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ModelClientError("MOONSHOT_BASE_URL must be an HTTPS origin")
    return normalized


def _content_to_json(content: Any) -> Any:
    if isinstance(content, list):
        content = "".join(str(item.get("text", "")) for item in content if isinstance(item, dict))
    if not isinstance(content, str):
        raise ModelClientError("Moonshot returned non-text content")
    text = content.strip()
    fenced = re.fullmatch(r"```(?:json)?\s*(.*?)\s*```", text, flags=re.IGNORECASE | re.DOTALL)
    if fenced:
        text = fenced.group(1).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        raise ModelClientError("Moonshot returned invalid JSON") from exc


class MoonshotJsonClient:
    """Use the fixed kimi-k2.6 default without ever logging the API key."""

    def __init__(self, *, base_url: str | None = None, model: str | None = None, api_key: str | None = None) -> None:
        self.base_url = _base_url(base_url or os.environ.get("MOONSHOT_BASE_URL", "https://api.moonshot.cn/v1"))
        self.model = (model or os.environ.get("MOONSHOT_MODEL", "kimi-k2.6")).strip() or "kimi-k2.6"
        self._api_key = (api_key if api_key is not None else os.environ.get("MOONSHOT_API_KEY", "")).strip()
        if not self._api_key:
            raise ModelClientError("MOONSHOT_API_KEY is required at runtime")

    def complete_json(self, *, system_prompt: str, user_prompt: str, timeout_seconds: float = 60.0) -> Any:
        if len(system_prompt) > 32_000 or len(user_prompt) > 500_000:
            raise ModelClientError("Moonshot request is too large")
        payload = json.dumps({
            "model": self.model,
            # kimi-k2.6 currently accepts only temperature=1. Keep the
            # deterministic zero-temperature behavior for other compatible
            # Moonshot models unless their caller explicitly supplies a
            # different client in the future.
            "temperature": 1 if self.model.lower() == "kimi-k2.6" else 0,
            "response_format": {"type": "json_object"},
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
        }, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        request = urllib.request.Request(
            f"{self.base_url}/chat/completions",
            data=payload,
            method="POST",
            headers={"accept": "application/json", "content-type": "application/json", "authorization": f"Bearer {self._api_key}"},
        )
        try:
            with urllib.request.urlopen(request, timeout=max(1.0, min(float(timeout_seconds), 120.0))) as response:
                body = response.read(2_000_001)
        except urllib.error.HTTPError as exc:
            # Do not copy provider response text into logs or persisted errors.
            raise ModelClientError(f"Moonshot HTTP {exc.code}") from exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise ModelClientError("Moonshot transport failed") from exc
        if len(body) > 2_000_000:
            raise ModelClientError("Moonshot response is too large")
        try:
            envelope = json.loads(body.decode("utf-8"))
            content = envelope["choices"][0]["message"]["content"]
        except (UnicodeDecodeError, KeyError, IndexError, TypeError, json.JSONDecodeError) as exc:
            raise ModelClientError("Moonshot response envelope is invalid") from exc
        return _content_to_json(content)
