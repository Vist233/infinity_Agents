"""Shared-user authentication for the Infinity Agent local runtime.

On the pure-local main branch every request is treated as the same shared
user.  OIDC, session-cookie validation and WebSocket token verification are
intentionally absent: the local deployment runs on a trusted school LAN
where identity is not meaningful.  The ``Principal`` dataclass and cookie
name constants are preserved so that downstream code keeps its type
signatures unchanged.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

from fastapi import Request, WebSocket


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

# Every request on the local LAN is treated as this shared identity.
SHARED_PRINCIPAL = Principal(
    user_id="local-admin",
    issuer="local-shared",
    subject="local-admin",
    roles=("superuser",),
)


def create_session_cookie(principal: Principal, *, ttl_seconds: int = 8 * 60 * 60) -> str:
    """Return a dummy cookie value.  Local runtime does not validate cookies."""
    return "local-shared-session"


def principal_from_session_cookie(value: str) -> Principal:
    """Return the shared principal regardless of cookie content."""
    return SHARED_PRINCIPAL


async def require_user(request: Request) -> Principal:
    """Return the shared local-admin principal for every request."""
    from backend.db_rls import set_rls_user
    set_rls_user(SHARED_PRINCIPAL.user_id)
    recorder = getattr(request.app.state, "principal_recorder", None)
    if recorder is not None:
        await recorder(SHARED_PRINCIPAL)
    return SHARED_PRINCIPAL


async def verify_websocket_token(websocket: WebSocket, token: str | None) -> Principal:
    """Return the shared local-admin principal for every WebSocket."""
    from backend.db_rls import set_rls_user
    set_rls_user(SHARED_PRINCIPAL.user_id)
    recorder = getattr(websocket.app.state, "principal_recorder", None)
    if recorder is not None:
        await recorder(SHARED_PRINCIPAL)
    return SHARED_PRINCIPAL
