"""OIDC access-token validation for the Infinity Agent API.

The browser authenticates with zhang-auth; this module verifies the signed
access token locally against the issuer's JWKS and exposes only its subject.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import time
from dataclasses import dataclass
from typing import Any
from http.cookies import SimpleCookie

import httpx
import jwt
from fastapi import HTTPException, Request, WebSocket, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from backend.core.config import settings


@dataclass(frozen=True)
class Principal:
    user_id: str
    issuer: str = ""
    subject: str = ""
    email: str | None = None
    session_id: str | None = None


SESSION_COOKIE_NAME = os.getenv("SESSION_COOKIE_NAME", "infinity_session")
CSRF_COOKIE_NAME = os.getenv("CSRF_COOKIE_NAME", "infinity_csrf")
_COOKIE_VERSION = "v1"


def _session_secret() -> bytes:
    value = os.getenv("SESSION_COOKIE_SECRET", "")
    if not value:
        if os.getenv("APP_ENV", "development").lower() in {"production", "prod"}:
            raise RuntimeError("SESSION_COOKIE_SECRET is required in production")
        value = "development-only-change-this-session-secret"
    return value.encode("utf-8")


def _b64(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _unb64(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def create_session_cookie(principal: Principal, *, ttl_seconds: int = 8 * 60 * 60) -> str:
    now = int(time.time())
    payload = {
        "sub": principal.user_id,
        "iss": principal.issuer or os.getenv("OIDC_ISSUER", "local").rstrip("/"),
        "sid": principal.session_id or secrets.token_urlsafe(18),
        "iat": now,
        "exp": now + max(60, ttl_seconds),
    }
    if principal.email:
        payload["email"] = principal.email
    encoded = _b64(json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8"))
    signature = _b64(hmac.new(_session_secret(), f"{_COOKIE_VERSION}.{encoded}".encode("ascii"), hashlib.sha256).digest())
    return f"{_COOKIE_VERSION}.{encoded}.{signature}"


def principal_from_session_cookie(value: str) -> Principal:
    try:
        version, encoded, signature = value.split(".", 2)
        if version != _COOKIE_VERSION:
            raise ValueError("unsupported session version")
        expected = _b64(hmac.new(_session_secret(), f"{version}.{encoded}".encode("ascii"), hashlib.sha256).digest())
        if not hmac.compare_digest(signature, expected):
            raise ValueError("invalid session signature")
        claims = json.loads(_unb64(encoded))
        if int(claims.get("exp", 0)) <= int(time.time()):
            raise ValueError("expired session")
        subject = str(claims.get("sub") or "").strip()
        if not subject:
            raise ValueError("missing session subject")
        return Principal(
            user_id=subject,
            issuer=str(claims.get("iss") or ""),
            subject=subject,
            email=str(claims.get("email")) if claims.get("email") else None,
            session_id=str(claims.get("sid")) if claims.get("sid") else None,
        )
    except (ValueError, TypeError, json.JSONDecodeError, UnicodeError) as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired session") from exc


def _cookie_value(request: Request) -> str | None:
    raw = request.headers.get("cookie", "")
    if not raw:
        return None
    jar = SimpleCookie()
    jar.load(raw)
    morsel = jar.get(SESSION_COOKIE_NAME)
    return morsel.value if morsel else None


class TokenVerifier:
    def __init__(self) -> None:
        self._jwks: dict[str, Any] | None = None
        self._expires_at = 0.0

    async def _get_jwks(self) -> dict[str, Any]:
        if self._jwks is not None and time.monotonic() < self._expires_at:
            return self._jwks
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                response = await client.get(settings.oidc_jwks_url)
                response.raise_for_status()
                jwks = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise HTTPException(status_code=503, detail="Authentication service is unavailable") from exc
        if not isinstance(jwks, dict) or not isinstance(jwks.get("keys"), list):
            raise HTTPException(status_code=503, detail="Authentication service returned invalid keys")
        self._jwks = jwks
        self._expires_at = time.monotonic() + settings.oidc_jwks_ttl_seconds
        return jwks

    async def verify(self, token: str, *, expected_nonce: str | None = None) -> Principal:
        try:
            header = jwt.get_unverified_header(token)
            if header.get("alg") != "ES256" or not header.get("kid"):
                raise jwt.InvalidTokenError("Unexpected token header")
            jwks = await self._get_jwks()
            jwk = next((key for key in jwks["keys"] if key.get("kid") == header["kid"]), None)
            if jwk is None:
                # Key rotation may have happened since the cached fetch.
                self._expires_at = 0
                jwks = await self._get_jwks()
                jwk = next((key for key in jwks["keys"] if key.get("kid") == header["kid"]), None)
            if jwk is None:
                raise jwt.InvalidTokenError("Unknown signing key")
            claims = jwt.decode(
                token,
                jwt.algorithms.ECAlgorithm.from_jwk(jwk),
                algorithms=["ES256"],
                audience=settings.oidc_audience,
                issuer=settings.oidc_issuer,
                options={"require": ["exp", "iat", "sub", "iss", "aud"]},
            )
            if expected_nonce is not None and claims.get("nonce") != expected_nonce:
                raise jwt.InvalidTokenError("Nonce mismatch")
            user_id = str(claims.get("sub") or "").strip()
            if not user_id:
                raise jwt.InvalidTokenError("Missing subject")
            return Principal(user_id=user_id, issuer=settings.oidc_issuer, subject=user_id)
        except HTTPException:
            raise
        except (jwt.PyJWTError, TypeError, ValueError) as exc:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid or expired access token",
                headers={"WWW-Authenticate": "Bearer"},
            ) from exc


_bearer = HTTPBearer(auto_error=False)


async def require_user(request: Request) -> Principal:
    credentials: HTTPAuthorizationCredentials | None = await _bearer(request)
    if credentials is not None and credentials.scheme.lower() == "bearer":
        return await request.app.state.token_verifier.verify(credentials.credentials)
    cookie = _cookie_value(request)
    if cookie:
        return principal_from_session_cookie(cookie)
    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Authentication required",
        headers={"WWW-Authenticate": "Bearer"},
    )


async def verify_websocket_token(websocket: WebSocket, token: str | None) -> Principal:
    if token:
        return await websocket.app.state.token_verifier.verify(token)
    raw = websocket.headers.get("cookie", "")
    jar = SimpleCookie()
    jar.load(raw)
    morsel = jar.get(SESSION_COOKIE_NAME)
    if morsel:
        return principal_from_session_cookie(morsel.value)
    raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication required")
