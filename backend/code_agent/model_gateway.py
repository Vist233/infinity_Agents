"""Attempt-scoped model gateway capability helpers.

The trusted Worker/Gateway boundary may hold a project Provider credential,
but a Claude Code Job receives only the short-lived URL/token/model tuple for
one Attempt.  This module is deliberately transport-neutral: deployment can
back the grant with an API route or a separate gateway without changing the
Job contract.
"""

from __future__ import annotations

import hashlib
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Mapping


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
