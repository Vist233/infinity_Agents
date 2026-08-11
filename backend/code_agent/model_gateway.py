"""Attempt-scoped model gateway capability helpers.

The trusted Worker/Gateway boundary may hold a project Provider credential,
but a Claude Code Job receives only the short-lived URL/token/model tuple for
one Attempt.  This module is deliberately transport-neutral: deployment can
back the grant with an API route or a separate gateway without changing the
Job contract.
"""

from __future__ import annotations

import hashlib
import base64
import json
import os
import secrets
import hmac
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Mapping


@dataclass(frozen=True)
class AttemptGatewayGrant:
    attempt_id: int
    base_url: str
    model_id: str
    token: str
    expires_at: str

    @property
    def token_fingerprint(self) -> str:
        return hashlib.sha256(self.token.encode("utf-8")).hexdigest()[:12]


def mint_attempt_grant(
    attempt_id: int,
    base_url: str,
    model_id: str,
    *,
    ttl_seconds: int = 900,
) -> AttemptGatewayGrant:
    """Mint a bounded, opaque capability for one Attempt.

    The caller is responsible for persisting only a hash or handing the raw
    token directly to the gateway.  This helper never logs or serializes a
    provider credential.
    """
    if attempt_id <= 0 or not base_url.strip() or not model_id.strip():
        raise ValueError("attempt gateway fields are required")
    if ttl_seconds < 30 or ttl_seconds > 3600:
        raise ValueError("attempt gateway TTL is outside the safety range")
    expires = datetime.now(timezone.utc) + timedelta(seconds=ttl_seconds)
    return AttemptGatewayGrant(
        attempt_id=attempt_id,
        base_url=base_url.rstrip("/"),
        model_id=model_id.strip(),
        token=secrets.token_urlsafe(32),
        expires_at=expires.isoformat(),
    )


def job_environment(grant: AttemptGatewayGrant) -> dict[str, str]:
    """Return only the standard Claude Code names allowed into a Job."""
    return {
        "ANTHROPIC_BASE_URL": grant.base_url,
        "ANTHROPIC_AUTH_TOKEN": grant.token,
        "ANTHROPIC_MODEL": grant.model_id,
    }


def has_long_lived_provider_secret(environment: Mapping[str, str]) -> bool:
    """Detect forbidden long-lived credential names in a Job environment."""
    forbidden = {
        "ANTHROPIC_API_KEY",
        "STEPFUN_API_KEY",
        "OPENAI_API_KEY",
        "OIDC_ACCESS_TOKEN",
        "DATABASE_URL",
        "REDIS_URL",
        "WORKER_CREDENTIAL",
    }
    return any(name in environment and bool(environment[name]) for name in forbidden)


def _capability_signing_key() -> bytes:
    """Return the operator-controlled key used for gateway capabilities."""
    raw = os.getenv("MODEL_GATEWAY_SIGNING_SECRET", "").strip()
    if not raw:
        raw = os.getenv("SECRET_STORE_KEK", "").strip()
    if not raw:
        if os.getenv("APP_ENV", "development").lower() not in {"development", "dev", "test"}:
            raise RuntimeError("MODEL_GATEWAY_SIGNING_SECRET is required outside development/test")
        raw = "infinity-agents-development-gateway"
    return hashlib.sha256(raw.encode("utf-8")).digest()


def _b64_json(value: Mapping[str, Any]) -> str:
    return base64.urlsafe_b64encode(
        json.dumps(value, separators=(",", ":"), sort_keys=True).encode("utf-8")
    ).decode("ascii").rstrip("=")


def _decode_b64_json(value: str) -> dict[str, Any]:
    padded = value + "=" * (-len(value) % 4)
    decoded = base64.urlsafe_b64decode(padded.encode("ascii"))
    payload = json.loads(decoded.decode("utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("gateway capability payload is invalid")
    return payload


def mint_gateway_capability(
    *,
    grant_id: str,
    task_id: str,
    attempt_id: int,
    owner_user_id: str,
    provider_profile_id: str | None,
    ttl_seconds: int = 900,
) -> tuple[str, str]:
    """Mint a signed, attempt-bound token without embedding a provider secret."""
    if not grant_id or not task_id or attempt_id <= 0 or not owner_user_id:
        raise ValueError("gateway capability identity is incomplete")
    if ttl_seconds < 30 or ttl_seconds > 3600:
        raise ValueError("gateway capability TTL is outside the safety range")
    expires_at = int(datetime.now(timezone.utc).timestamp()) + ttl_seconds
    payload = {
        "v": 1,
        "grant_id": grant_id,
        "task_id": task_id,
        "attempt_id": attempt_id,
        "owner_user_id": owner_user_id,
        "provider_profile_id": provider_profile_id or "",
        "jti": secrets.token_urlsafe(18),
        "exp": expires_at,
    }
    body = _b64_json(payload)
    signature = hmac.new(_capability_signing_key(), body.encode("ascii"), hashlib.sha256).digest()
    token = f"{body}.{base64.urlsafe_b64encode(signature).decode('ascii').rstrip('=')}"
    return token, datetime.fromtimestamp(expires_at, timezone.utc).isoformat()


def verify_gateway_capability(token: str, *, grant_id: str) -> dict[str, Any]:
    """Verify signature, binding, and expiry for a model gateway request."""
    try:
        body, encoded_signature = str(token or "").split(".", 1)
        padded = encoded_signature + "=" * (-len(encoded_signature) % 4)
        supplied = base64.urlsafe_b64decode(padded.encode("ascii"))
        expected = hmac.new(_capability_signing_key(), body.encode("ascii"), hashlib.sha256).digest()
        if not hmac.compare_digest(supplied, expected):
            raise ValueError("gateway capability signature is invalid")
        payload = _decode_b64_json(body)
    except (ValueError, TypeError, json.JSONDecodeError) as exc:
        raise ValueError("gateway capability is invalid") from exc
    if payload.get("v") != 1 or payload.get("grant_id") != grant_id:
        raise ValueError("gateway capability binding is invalid")
    try:
        expires_at = int(payload["exp"])
        attempt_id = int(payload["attempt_id"])
    except (KeyError, TypeError, ValueError) as exc:
        raise ValueError("gateway capability claims are invalid") from exc
    if expires_at <= int(datetime.now(timezone.utc).timestamp()) or attempt_id <= 0:
        raise ValueError("gateway capability has expired")
    if not payload.get("task_id") or not payload.get("owner_user_id"):
        raise ValueError("gateway capability claims are incomplete")
    return payload
