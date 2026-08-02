"""OIDC access-token validation for the Infinity Agent API.

The browser authenticates with zhang-auth; this module verifies the signed
access token locally against the issuer's JWKS and exposes only its subject.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any

import httpx
import jwt
from fastapi import HTTPException, Request, WebSocket, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from backend.core.config import settings


@dataclass(frozen=True)
class Principal:
    user_id: str


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

    async def verify(self, token: str) -> Principal:
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
            user_id = str(claims.get("sub") or "").strip()
            if not user_id:
                raise jwt.InvalidTokenError("Missing subject")
            return Principal(user_id=user_id)
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
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return await request.app.state.token_verifier.verify(credentials.credentials)


async def verify_websocket_token(websocket: WebSocket, token: str | None) -> Principal:
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication required")
    return await websocket.app.state.token_verifier.verify(token)
