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
from backend.db_rls import set_rls_user


@dataclass(frozen=True)
class Principal:
    user_id: str
    issuer: str = ""
    subject: str = ""
    email: str | None = None
    session_id: str | None = None
    roles: tuple[str, ...] = ()

    @property
    def is_superuser(self) -> bool:
        return any(role.strip().lower() in {"superuser", "root"} for role in self.roles)


SESSION_COOKIE_NAME = os.getenv("SESSION_COOKIE_NAME", "infinity_session")
CSRF_COOKIE_NAME = os.getenv("CSRF_COOKIE_NAME", "infinity_csrf")
_COOKIE_VERSION = "v1"


def _session_secret() -> bytes:
    value = os.getenv("SESSION_COOKIE_SECRET", "")
    if not value:
        if os.getenv("APP_ENV", "development").lower() not in {"development", "dev", "test"}:
            raise RuntimeError("SESSION_COOKIE_SECRET is required outside development/test")
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
    if principal.roles:
        payload["roles"] = list(principal.roles)
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
        raw_roles = claims.get("roles", [])
        if isinstance(raw_roles, str):
            roles = (raw_roles,)
        elif isinstance(raw_roles, (list, tuple, set)):
            roles = tuple(str(role) for role in raw_roles if str(role).strip())
        else:
            roles = ()
        return Principal(
            user_id=subject,
            issuer=str(claims.get("iss") or ""),
            subject=subject,
            email=str(claims.get("email")) if claims.get("email") else None,
            session_id=str(claims.get("sid")) if claims.get("sid") else None,
            roles=roles,
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
            raw_roles = claims.get("roles", claims.get("role", []))
            if isinstance(raw_roles, str):
                roles = (raw_roles,)
            elif isinstance(raw_roles, (list, tuple, set)):
                roles = tuple(str(role) for role in raw_roles if str(role).strip())
            else:
                roles = ()
            if claims.get("is_superuser") is True and "superuser" not in {role.lower() for role in roles}:
                roles = (*roles, "superuser")
            return Principal(user_id=user_id, issuer=settings.oidc_issuer, subject=user_id, roles=roles)
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
        principal = await request.app.state.token_verifier.verify(credentials.credentials)
        set_rls_user(principal.user_id)
        recorder = getattr(request.app.state, "principal_recorder", None)
        if recorder is not None:
            await recorder(principal)
        return principal
    cookie = _cookie_value(request)
    if cookie:
        principal = principal_from_session_cookie(cookie)
        set_rls_user(principal.user_id)
        await _ensure_session_active(request.app, principal)
        return principal
    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Authentication required",
        headers={"WWW-Authenticate": "Bearer"},
    )


async def _ensure_session_active(app: Any, principal: Principal) -> None:
    """Check the durable session record for cookie-authenticated requests.

    The signed cookie proves integrity and expiry, but it is intentionally not
    the source of revocation truth.  Keep this check shared by HTTP and
    WebSocket authentication so logout/revocation takes effect on both paths.
    """
    pool = getattr(app.state, "db_pool", None)
    if pool is None or not principal.session_id:
        return
    try:
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                SELECT 1 FROM auth_sessions
                WHERE session_id = $1::uuid
                  AND user_id = $2
                  AND revoked_at IS NULL
                  AND expires_at > NOW()
                """,
                principal.session_id,
                principal.user_id,
            )
    except Exception as exc:
        raise HTTPException(status_code=503, detail="Authentication session store is unavailable") from exc
    if not row:
        raise HTTPException(status_code=401, detail="Session has been revoked or expired")


async def verify_websocket_token(websocket: WebSocket, token: str | None) -> Principal:
    if token:
        principal = await websocket.app.state.token_verifier.verify(token)
        set_rls_user(principal.user_id)
        recorder = getattr(websocket.app.state, "principal_recorder", None)
        if recorder is not None:
            await recorder(principal)
        return principal
    raw = websocket.headers.get("cookie", "")
    jar = SimpleCookie()
    jar.load(raw)
    morsel = jar.get(SESSION_COOKIE_NAME)
    if morsel:
        principal = principal_from_session_cookie(morsel.value)
        set_rls_user(principal.user_id)
        await _ensure_session_active(websocket.app, principal)
        return principal
    raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication required")
