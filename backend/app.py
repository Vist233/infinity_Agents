from fastapi import FastAPI, Depends, HTTPException, Request, WebSocket, WebSocketDisconnect, UploadFile, File, Form, Query
from fastapi.responses import FileResponse, RedirectResponse, JSONResponse, StreamingResponse
from pathlib import Path as FilePath
from pydantic import BaseModel
from typing import List, Dict, Any, Optional, Tuple
from fastapi.middleware.cors import CORSMiddleware
from agent.paperAgent import create_paper_agent
from agent.tools.pdf_extractor import PDFExtractor, ExtractedContent
from agent.tools.image_path_utils import to_img_ref
from contextlib import asynccontextmanager
import asyncio
import threading
import os
import re
import base64
import hmac
import logging
import json
import hashlib
import secrets
import time
import shutil
from agent.util import estimate_tokens
import uuid
import asyncpg

logger = logging.getLogger(__name__)
from backend.db import (
    insert_session,
    init_db,
    close_db,
    get_session_messages,
    get_session,
    insert_message,
    get_all_sessions,
    update_session_title,
    delete_session,
    resolve_global_paper_id_by_path,
    session_can_access_paper,
    upsert_session_paper_link,
    insert_session_uploaded_paper,
    reserve_session_upload_slot,
    list_session_uploaded_papers,
    insert_session_tool_call,
    get_recent_session_tool_calls,
    get_recent_tool_calls_keep_from_id,
    get_tool_calls_for_compression,
    upsert_session_context_compression_state,
    update_session_context_compression_state,
    upsert_task_draft,
    get_task_draft,
    update_task_draft_inputs,
    cancel_task_draft,
)
from backend.auth import (
    CSRF_COOKIE_NAME,
    SESSION_COOKIE_NAME,
    Principal,
    TokenVerifier,
    create_session_cookie,
    principal_from_session_cookie,
    require_user,
    verify_websocket_token,
)
from backend.security import redact_secrets, safe_relative_path, ensure_within
from backend.security import validate_outbound_url, validate_runtime_database_url
from backend.secrets import decrypt_secret, encrypt_secret, secret_fingerprint
from backend.db_rls import clear_rls_context, rls_enabled_from_env, rls_user_context, set_rls_worker, wrap_runtime_pool

logging.basicConfig(level=logging.INFO)


def _env_flag(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() not in {"0", "false", "no", "off"}


def _env_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _env_float(name: str, default: float) -> float:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        return float(raw)
    except ValueError:
        return default


ENABLE_WS_STATUS_EVENTS = _env_flag("ENABLE_WS_STATUS_EVENTS", True)
ENABLE_FIRST_CHUNK_RETRY = _env_flag("ENABLE_FIRST_CHUNK_RETRY", True)
FIRST_CHUNK_TIMEOUT_SECONDS = max(1, _env_int("FIRST_CHUNK_TIMEOUT_SECONDS", 8))
MAX_STREAM_ATTEMPTS = 2 if ENABLE_FIRST_CHUNK_RETRY else 1
CONTEXT_WINDOW_TOKENS = max(1, _env_int("PAPER_AGENT_CONTEXT_WINDOW_TOKENS", 128000))
CONTEXT_COMPRESSION_RATIO = min(max(_env_float("PAPER_AGENT_CONTEXT_COMPRESSION_RATIO", 0.93), 0.01), 1.0)
TOOL_KEEP_RECENT = max(1, _env_int("PAPER_AGENT_TOOL_KEEP_RECENT", 3))

@asynccontextmanager
async def lifespan(app):
    await init_db(app)
    app.state.worker_gateway_pool = None
    app.state.trust_issuer_pool = None
    gateway_dsn = os.getenv("WORKER_GATEWAY_DATABASE_URL", "").strip()
    trust_issuer_dsn = os.getenv("TRUST_ISSUER_DATABASE_URL", "").strip()
    environment = os.getenv("APP_ENV", "development").lower()
    if environment in {"acceptance", "production", "prod"} and not gateway_dsn:
        raise RuntimeError("WORKER_GATEWAY_DATABASE_URL is required outside development/test")
    if environment in {"acceptance", "production", "prod"} and not trust_issuer_dsn:
        raise RuntimeError("TRUST_ISSUER_DATABASE_URL is required outside development/test")
    if gateway_dsn:
        validate_runtime_database_url(gateway_dsn)
    if trust_issuer_dsn:
        validate_runtime_database_url(trust_issuer_dsn)
    if gateway_dsn:
        try:
            gateway_raw_pool = await asyncpg.create_pool(
                dsn=gateway_dsn,
                min_size=1,
                max_size=5,
                timeout=30,
            )
            app.state.worker_gateway_pool = (
                wrap_runtime_pool(gateway_raw_pool)
                if rls_enabled_from_env()
                else gateway_raw_pool
            )
        except Exception as exc:
            raise RuntimeError("Worker gateway database pool could not be initialized") from exc
    if trust_issuer_dsn:
        try:
            # This pool is deliberately raw and is used only by the server
            # derived full-trust enrollment path. Its login inherits the
            # NOLOGIN infinity_trust_issuer role; the ordinary API login does
            # not have SET ROLE permission for that role.
            app.state.trust_issuer_pool = await asyncpg.create_pool(
                dsn=trust_issuer_dsn,
                min_size=1,
                max_size=2,
                timeout=30,
            )
        except Exception as exc:
            raise RuntimeError("Trust issuer database pool could not be initialized") from exc
    app.state.token_verifier = TokenVerifier()
    # Authenticated bearer requests use the same durable principal recorder as
    # the cookie/OIDC path.  This makes the first bearer request safe under the
    # users-table RLS policy and keeps project-member foreign keys valid.
    app.state.principal_recorder = _record_principal

    # In legacy development mode the bootstrap project is harmless. With RLS
    # enabled, every project must be created under the authenticated user's
    # context; a connection-wide service role must not become a project owner.
    if not rls_enabled_from_env():
        try:
            from backend.code_agent.task_service import ensure_default_project
            await ensure_default_project(app.state.db_pool)
        except Exception as exc:
            logger.warning("Could not ensure default project: %s", exc)
    app.state.session_agents = {}
    app.state.session_meta = {}
    app.state.oauth_states = {}

    # The API may host the publisher in a small local development setup, but
    # acceptance/production can run it as a separate service with a login that
    # cannot be assumed by the API process. Keep that topology explicit.
    app.state.outbox_publisher = None
    app.state.redis_client = None
    global _redis_client
    if _env_flag("ENABLE_OUTBOX_PUBLISHER", not rls_enabled_from_env()):
        try:
            from backend.code_agent.outbox import OutboxPublisher
            from backend.code_agent.redis_client import RedisClient
            redis_url = os.getenv("REDIS_URL", "redis://localhost:6379/0")
            redis_client = RedisClient(redis_url)
            await redis_client.connect()
            app.state.redis_client = redis_client
            _redis_client = redis_client
            if redis_client.is_connected:
                app.state.outbox_publisher = OutboxPublisher(
                    app.state.db_pool, redis_client, poll_interval=1.0
                )
                await app.state.outbox_publisher.start()
                logger.info("Outbox Publisher started")
        except Exception as exc:
            logger.warning("Outbox Publisher not started: %s", exc)
    else:
        try:
            from backend.code_agent.redis_client import RedisClient
            redis_client = RedisClient(os.getenv("REDIS_URL", "redis://localhost:6379/0"))
            await redis_client.connect()
            app.state.redis_client = redis_client
            _redis_client = redis_client
            logger.info("Outbox Publisher disabled; Redis client kept for API/SSE/health")
        except Exception as exc:
            logger.warning("API Redis client not connected: %s", exc)

    yield

    # Cleanup
    if hasattr(app.state, "outbox_publisher") and app.state.outbox_publisher:
        try:
            await app.state.outbox_publisher.stop()
        except Exception:
            pass
    if hasattr(app.state, "redis_client") and app.state.redis_client:
        try:
            await app.state.redis_client.disconnect()
        except Exception:
            pass
    gateway_pool = getattr(app.state, "worker_gateway_pool", None)
    if gateway_pool:
        await gateway_pool.close()
    trust_issuer_pool = getattr(app.state, "trust_issuer_pool", None)
    if trust_issuer_pool:
        await trust_issuer_pool.close()
    await close_db(app)

app = FastAPI(lifespan=lifespan)


def _safe_return_to(value: Optional[str]) -> str:
    candidate = str(value or "/").strip()
    if not candidate.startswith("/") or candidate.startswith("//"):
        return "/"
    return candidate


def _cookie_secure() -> bool:
    return _env_flag("COOKIE_SECURE", os.getenv("APP_ENV", "development").lower() in {"production", "prod"})


def _dev_auth_environment_allowed() -> bool:
    return os.getenv("APP_ENV", "development").lower() in {"development", "dev", "test", "acceptance"}


def _configured_dev_user_id() -> str:
    default = "acceptance_api" if os.getenv("APP_ENV", "development").lower() == "acceptance" else "alice"
    return os.getenv("AUTH_DEV_LOGIN_USER_ID", default).strip() or default


def _validate_dev_user_id(user_id: str) -> str:
    if not _dev_auth_environment_allowed() or not _env_flag("AUTH_DEV_LOGIN_ENABLED", False):
        raise HTTPException(status_code=404, detail="Not found")
    if not re.fullmatch(r"[A-Za-z0-9._@:-]{1,128}", user_id):
        raise HTTPException(status_code=400, detail="Invalid local user ID")
    # Acceptance may use the deterministic local OIDC stub, but it must not be
    # an arbitrary-user impersonation endpoint.  A single configured identity
    # is enough for local smoke tests and keeps the deployed-like surface
    # closed to user-controlled subject selection.
    if os.getenv("APP_ENV", "development").lower() == "acceptance" and user_id != _configured_dev_user_id():
        raise HTTPException(status_code=403, detail="This acceptance login identity is not allowed")
    return user_id


def _external_base_url(request: Request) -> str:
    """Best-effort public origin for proxied local auth flows.

    When the FastAPI app sits behind the local Next.js dev server, request.url
    reflects the internal API origin (for example :8008 / :18008). Prefer the
    forwarded public host/proto so OIDC callbacks return to the browser-facing
    origin.
    """
    explicit = os.getenv("OIDC_PUBLIC_BASE_URL", "").strip().rstrip("/")
    if explicit:
        return explicit
    forwarded_proto = (request.headers.get("x-forwarded-proto") or "").split(",")[0].strip()
    forwarded_host = (request.headers.get("x-forwarded-host") or "").split(",")[0].strip()
    scheme = forwarded_proto or request.url.scheme
    host = forwarded_host or request.headers.get("host") or request.url.netloc
    if not re.fullmatch(r"[A-Za-z0-9.:-]+", str(host or "").strip()):
        host = request.url.netloc
    return f"{scheme}://{str(host).strip()}"


def _public_callback_url(request: Request) -> str:
    explicit = os.getenv("OIDC_REDIRECT_URI", "").strip()
    if explicit:
        return explicit
    callback_path = str(request.app.url_path_for("auth_callback"))
    return f"{_external_base_url(request)}{callback_path}"


async def _record_principal(principal: Principal) -> None:
    """Persist the issuer/subject mapping without storing bearer credentials."""
    pool = getattr(app.state, "db_pool", None)
    if pool is None:
        return
    try:
        with rls_user_context(principal.user_id):
            async with pool.acquire() as conn:
                await conn.execute(
                    """
                    INSERT INTO users (user_id, issuer, subject, email, last_seen_at)
                    VALUES ($1, $2, $3, $4, NOW())
                    ON CONFLICT (user_id) DO UPDATE SET
                        issuer = EXCLUDED.issuer,
                        subject = EXCLUDED.subject,
                        email = COALESCE(EXCLUDED.email, users.email),
                        last_seen_at = NOW()
                    """,
                    principal.user_id,
                    principal.issuer or os.getenv("OIDC_ISSUER", "local"),
                    principal.subject or principal.user_id,
                    principal.email,
                )
    except Exception:
        # Authentication must not fail only because the audit mapping is
        # temporarily unavailable; the request still carries a verified token.
        logger.exception("Failed to persist authenticated principal")


async def _set_session_cookie(response, principal: Principal, *, pool=None) -> None:
    session_id = principal.session_id or str(uuid.uuid4())
    session_principal = Principal(
        user_id=principal.user_id,
        issuer=principal.issuer,
        subject=principal.subject,
        email=principal.email,
        session_id=session_id,
        roles=principal.roles,
    )
    response.set_cookie(
        SESSION_COOKIE_NAME,
        create_session_cookie(session_principal),
        max_age=8 * 60 * 60,
        httponly=True,
        secure=_cookie_secure(),
        samesite="lax",
        path="/",
    )
    # A readable, non-authenticating CSRF nonce is paired with the HttpOnly
    # session cookie.  State-changing browser requests must echo it in the
    # X-CSRF-Token header; the nonce is never accepted as an identity token.
    response.set_cookie(
        CSRF_COOKIE_NAME,
        secrets.token_urlsafe(24),
        max_age=8 * 60 * 60,
        httponly=False,
        secure=_cookie_secure(),
        samesite="lax",
        path="/",
    )
    if pool is not None:
        try:
            with rls_user_context(principal.user_id):
                async with pool.acquire() as conn:
                    await conn.execute(
                        """
                        INSERT INTO auth_sessions (session_id, user_id, expires_at)
                        VALUES ($1::uuid, $2, NOW() + INTERVAL '8 hours')
                        ON CONFLICT (session_id) DO UPDATE SET
                            user_id = EXCLUDED.user_id,
                            expires_at = EXCLUDED.expires_at,
                            revoked_at = NULL
                        """,
                        session_id,
                        principal.user_id,
                    )
        except Exception:
            logger.exception("Failed to persist authentication session")
            raise HTTPException(status_code=503, detail="Authentication session store is unavailable")


def _oauth_state_hash(state: str) -> str:
    return hashlib.sha256(state.encode("utf-8")).hexdigest()


async def _store_oauth_state(request: Request, state: str, data: Dict[str, Any]) -> None:
    pool = getattr(request.app.state, "db_pool", None)
    if pool is None:
        request.app.state.oauth_states[state] = data
        return
    with rls_user_context("auth-flow"):
        async with pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO oauth_states (state_hash, verifier, nonce, return_to, expires_at)
                VALUES ($1, $2, $3, $4, to_timestamp($5))
                """,
                _oauth_state_hash(state), data["verifier"], data["nonce"], data["return_to"], data["expires_at"],
            )


async def _load_oauth_state(request: Request, state: str) -> Optional[Dict[str, Any]]:
    pool = getattr(request.app.state, "db_pool", None)
    if pool is None:
        return request.app.state.oauth_states.get(state)
    with rls_user_context("auth-flow"):
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                SELECT verifier, nonce, return_to, code_challenge, EXTRACT(EPOCH FROM expires_at) AS expires_at
                FROM oauth_states
                WHERE state_hash = $1 AND expires_at > NOW()
                """,
                _oauth_state_hash(state),
            )
    if not row:
        return None
    return {
        "verifier": row["verifier"],
        "nonce": row["nonce"],
        "return_to": row["return_to"],
        "code_challenge": row["code_challenge"],
        "expires_at": float(row["expires_at"]),
    }


async def _set_oauth_code_challenge(request: Request, state: str, code_challenge: str) -> None:
    pool = getattr(request.app.state, "db_pool", None)
    if pool is None:
        state_data = request.app.state.oauth_states.get(state)
        if state_data is not None:
            state_data["code_challenge"] = code_challenge
        return
    with rls_user_context("auth-flow"):
        async with pool.acquire() as conn:
            await conn.execute(
                "UPDATE oauth_states SET code_challenge = $2 WHERE state_hash = $1 AND expires_at > NOW()",
                _oauth_state_hash(state),
                code_challenge,
            )


async def _consume_oauth_state(request: Request, state: str) -> Optional[Dict[str, Any]]:
    pool = getattr(request.app.state, "db_pool", None)
    if pool is None:
        return request.app.state.oauth_states.pop(state, None)
    with rls_user_context("auth-flow"):
        async with pool.acquire() as conn:
            async with conn.transaction():
                row = await conn.fetchrow(
                    """
                    SELECT verifier, nonce, return_to, code_challenge, EXTRACT(EPOCH FROM expires_at) AS expires_at
                    FROM oauth_states
                    WHERE state_hash = $1 AND expires_at > NOW()
                    FOR UPDATE
                    """,
                    _oauth_state_hash(state),
                )
                if not row:
                    return None
                await conn.execute("DELETE FROM oauth_states WHERE state_hash = $1", _oauth_state_hash(state))
    return {
        "verifier": row["verifier"],
        "nonce": row["nonce"],
        "return_to": row["return_to"],
        "code_challenge": row["code_challenge"],
        "expires_at": float(row["expires_at"]),
    }


@app.get("/auth/login")
async def auth_login(request: Request, return_to: str = "/"):
    """Start Authorization Code + PKCE; acceptance can use the local OIDC spy."""
    safe_return = _safe_return_to(return_to)
    dev_login = _env_flag("AUTH_DEV_LOGIN_ENABLED", False) and _dev_auth_environment_allowed()
    authorization_url = "/auth/dev/authorize" if dev_login else os.getenv("OIDC_AUTHORIZATION_URL", "").strip()
    client_id = "local-oidc-client" if dev_login else os.getenv("OIDC_CLIENT_ID", "").strip()
    if not authorization_url or not client_id:
        raise HTTPException(status_code=503, detail="OIDC login is not configured")
    state = secrets.token_urlsafe(32)
    nonce = secrets.token_urlsafe(32)
    verifier = secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    await _store_oauth_state(request, state, {
        "verifier": verifier,
        "nonce": nonce,
        "return_to": safe_return,
        "dev_user_id": _configured_dev_user_id() if dev_login else None,
        "expires_at": time.time() + 600,
    })
    from urllib.parse import urlencode
    redirect_uri = _public_callback_url(request)
    query_values = {
        "response_type": "code",
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "scope": os.getenv("OIDC_SCOPE", "openid profile email"),
        "state": state,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "nonce": nonce,
    }
    if dev_login:
        query_values["user_id"] = _configured_dev_user_id()
    query = urlencode(query_values)
    response = RedirectResponse(url=f"{authorization_url}?{query}", status_code=307)
    response.set_cookie("oidc_state", state, max_age=600, httponly=True, secure=_cookie_secure(), samesite="lax", path="/")
    return response


@app.get("/auth/dev/authorize")
async def auth_dev_authorize(
    request: Request,
    client_id: str,
    redirect_uri: str,
    state: str,
    nonce: str,
    code_challenge: str,
    code_challenge_method: str = "S256",
    user_id: str = "alice",
):
    """Deterministic local OIDC authorization endpoint.

    This is an OIDC-shaped test stub, not a production authentication path.
    It validates the PKCE request shape and returns a one-use development
    authorization code to the registered callback.
    """
    state_data = await _load_oauth_state(request, state)
    if not state_data:
        raise HTTPException(status_code=400, detail="Invalid OIDC state")
    user_id = _validate_dev_user_id(user_id)
    expected_user_id = str(state_data.get("dev_user_id") or _configured_dev_user_id())
    if user_id != expected_user_id:
        raise HTTPException(status_code=403, detail="This authorization state is bound to another local identity")
    if client_id != "local-oidc-client" or code_challenge_method != "S256" or not code_challenge:
        raise HTTPException(status_code=400, detail="Invalid PKCE request")
    expected_redirect = _public_callback_url(request)
    if redirect_uri != expected_redirect:
        raise HTTPException(status_code=400, detail="Invalid redirect URI")
    if not re.fullmatch(r"[A-Za-z0-9._@:-]{1,128}", user_id):
        raise HTTPException(status_code=400, detail="Invalid local user ID")
    if not state_data or state_data.get("nonce") != nonce or state_data.get("code_challenge") not in {None, code_challenge}:
        raise HTTPException(status_code=400, detail="Invalid OIDC state")
    await _set_oauth_code_challenge(request, state, code_challenge)
    from urllib.parse import urlencode
    return RedirectResponse(
        url=f"{redirect_uri}?{urlencode({'code': f'dev:{user_id}', 'state': state})}",
        status_code=303,
    )


@app.get("/auth/dev/login")
async def auth_dev_login(request: Request, return_to: str = "/", user_id: str = "alice"):
    """Local-only login endpoint used by deterministic acceptance tests."""
    user_id = _validate_dev_user_id(user_id)
    principal = Principal(user_id=user_id, issuer="local-oidc-spy", subject=user_id)
    await _record_principal(principal)
    response = RedirectResponse(url=_safe_return_to(return_to), status_code=303)
    await _set_session_cookie(response, principal, pool=getattr(request.app.state, "db_pool", None))
    return response


@app.get("/auth/callback", name="auth_callback")
async def auth_callback(request: Request, code: str, state: str, error: Optional[str] = None):
    if error:
        raise HTTPException(status_code=401, detail="OIDC authorization was denied")
    state_cookie = request.cookies.get("oidc_state")
    state_data = await _consume_oauth_state(request, state)
    if not state_data or state_cookie != state or float(state_data.get("expires_at", 0)) <= time.time():
        raise HTTPException(status_code=400, detail="Invalid or expired OIDC state")
    if _env_flag("AUTH_DEV_LOGIN_ENABLED", False) and _dev_auth_environment_allowed() and code.startswith("dev:"):
        if not state_data.get("code_challenge"):
            raise HTTPException(status_code=400, detail="PKCE verification failed")
        principal_id = code[4:] or "local-user"
        if not re.fullmatch(r"[A-Za-z0-9._@:-]{1,128}", principal_id):
            raise HTTPException(status_code=401, detail="Invalid local authorization code")
        expected_user_id = str(state_data.get("dev_user_id") or _configured_dev_user_id())
        if principal_id != expected_user_id:
            raise HTTPException(status_code=401, detail="Invalid local authorization identity")
        principal = Principal(user_id=principal_id, issuer="local-oidc-spy", subject=principal_id)
    else:
        token_url = os.getenv("OIDC_TOKEN_URL", "").strip()
        if not token_url:
            raise HTTPException(status_code=503, detail="OIDC token endpoint is not configured")
        import httpx
        redirect_uri = _public_callback_url(request)
        async with httpx.AsyncClient(timeout=10.0, follow_redirects=False) as client:
            token_response = await client.post(token_url, data={
                "grant_type": "authorization_code",
                "code": code,
                "client_id": os.getenv("OIDC_CLIENT_ID", ""),
                "redirect_uri": redirect_uri,
                "code_verifier": state_data["verifier"],
            })
        if token_response.status_code >= 400:
            raise HTTPException(status_code=401, detail="OIDC token exchange failed")
        try:
            token_payload = token_response.json()
        except ValueError as exc:
            raise HTTPException(status_code=401, detail="OIDC token response is invalid") from exc
        access_token = str(token_payload.get("access_token") or "")
        if not access_token:
            raise HTTPException(status_code=401, detail="OIDC token response is missing access token")
        id_token = str(token_payload.get("id_token") or "")
        principal = await request.app.state.token_verifier.verify(
            id_token or access_token,
            expected_nonce=state_data.get("nonce") if id_token else None,
        )
    await _record_principal(principal)
    response = RedirectResponse(url=_safe_return_to(state_data.get("return_to")), status_code=303)
    response.delete_cookie("oidc_state", path="/")
    await _set_session_cookie(response, principal, pool=getattr(request.app.state, "db_pool", None))
    return response


@app.get("/auth/me")
async def auth_me(user: Principal = Depends(require_user)):
    return {"user_id": user.user_id, "issuer": user.issuer, "subject": user.subject, "email": user.email}


@app.post("/auth/logout")
async def auth_logout(request: Request, return_to: str = "/"):
    raw_cookie = request.cookies.get(SESSION_COOKIE_NAME)
    if raw_cookie:
        try:
            principal = principal_from_session_cookie(raw_cookie)
            pool = getattr(request.app.state, "db_pool", None)
            if pool is not None and principal.session_id:
                with rls_user_context(principal.user_id):
                    async with pool.acquire() as conn:
                        await conn.execute(
                            "UPDATE auth_sessions SET revoked_at = NOW() WHERE session_id = $1::uuid",
                            principal.session_id,
                        )
        except HTTPException:
            pass
    response = RedirectResponse(url=_safe_return_to(return_to), status_code=303)
    response.delete_cookie(SESSION_COOKIE_NAME, path="/")
    response.delete_cookie("oidc_state", path="/")
    response.delete_cookie(CSRF_COOKIE_NAME, path="/")
    return response

_PROJECT_ROOT = FilePath(__file__).parent.parent
_SESSIONS_ROOT = _PROJECT_ROOT / "papers" / "sessions"
_SHARED_PAPERS_CACHE_ROOT = _PROJECT_ROOT / "papers" / "cache"
_SESSIONS_ROOT.mkdir(parents=True, exist_ok=True)
_SHARED_PAPERS_CACHE_ROOT.mkdir(parents=True, exist_ok=True)
_LEGACY_ALLOWED_FILE_DIRS = [
    _PROJECT_ROOT / "papers",
    _PROJECT_ROOT / "agent" / "tools" / "plot_outputs",
    _PROJECT_ROOT / "agent" / "tools" / "plotly_outputs",
]
_MAX_UPLOAD_PDF_BYTES = 50 * 1024 * 1024
_MAX_SESSION_UPLOAD_PAPERS = 20
_PDF_MIME_TYPES = {"application/pdf", "application/x-pdf"}


def _get_session_root(session_id: str) -> FilePath:
    return _SESSIONS_ROOT / session_id


def _session_resource_catalog_path(session_id: str) -> FilePath:
    return ensure_within(_SESSIONS_ROOT.resolve(), _get_session_root(session_id) / "resource-catalog.json")


def _record_session_resource(session_id: str, resource: Dict[str, Any]) -> None:
    """Persist a sanitized resource catalog for the synchronous Agent tools."""
    path = _session_resource_catalog_path(session_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    existing: Dict[str, Any] = {"session_id": str(session_id), "resources": []}
    if path.is_file() and not path.is_symlink():
        try:
            loaded = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                existing.update(loaded)
        except (OSError, ValueError):
            pass
    resources = [item for item in existing.get("resources", []) if isinstance(item, dict)]
    resources = [item for item in resources if str(item.get("resource_id")) != str(resource.get("resource_id"))]
    resources.append({
        "resource_id": str(resource.get("resource_id")),
        "project_id": str(resource.get("project_id")),
        "kind": resource.get("kind", "dataset"),
        "logical_name": FilePath(str(resource.get("logical_name") or "resource.bin")).name,
        "storage_key": safe_relative_path(str(resource.get("storage_key") or "")),
        "content_type": resource.get("content_type"),
        "file_size_bytes": int(resource.get("file_size_bytes") or 0),
        "checksum_sha256": resource.get("checksum_sha256"),
        "validation_result": resource.get("validation_result"),
        "status": resource.get("status", "ready"),
    })
    existing["resources"] = resources[-200:]
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        temporary.write_text(json.dumps(existing, ensure_ascii=False), encoding="utf-8")
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def _normalize_uploaded_image_path(image_path: Any) -> str:
    raw = str(image_path or "").strip()
    if not raw:
        return ""
    p = FilePath(raw)
    if p.is_absolute():
        resolved = p.resolve()
        match = re.search(r"/papers/sessions/[^/]+/(.+)$", resolved.as_posix())
        if match:
            return match.group(1)
        try:
            return resolved.relative_to(_SHARED_PAPERS_CACHE_ROOT.resolve()).as_posix()
        except ValueError:
            return resolved.as_posix()
    normalized = raw.replace("\\", "/")
    while normalized.startswith("./"):
        normalized = normalized[2:]
    return normalized.lstrip("/")


def _build_uploaded_canonical_md(paper_id: str, extracted: ExtractedContent) -> str:
    parts: List[str] = [
        f"# Paper {paper_id}",
        "",
        "## Source Text (By Page)",
        "",
    ]
    for page in extracted.pages:
        page_num = page.get("page_num", "?")
        text = str(page.get("text", "") or "")
        image_paths = [
            _normalize_uploaded_image_path(p)
            for p in (page.get("image_paths") or [])
            if str(p).strip()
        ]
        image_paths = [p for p in image_paths if p]

        parts.append(f"### Page {page_num}")
        parts.append("")
        parts.append(text if text.strip() else "[No text extracted on this page]")
        parts.append("")
        if image_paths:
            parts.append("#### Extracted Images")
            parts.append("")
            for image_path in image_paths:
                parts.append(f"- `{image_path}`")
                parts.append(f"- ![{FilePath(image_path).stem}]({to_img_ref(image_path)})")
            parts.append("")
    return "\n".join(parts)


def _to_project_relative(path: FilePath) -> str:
    try:
        return path.resolve().relative_to(_PROJECT_ROOT.resolve()).as_posix()
    except ValueError:
        return path.resolve().as_posix()


def _generate_uploaded_paper_id() -> str:
    return "upload_" + uuid.uuid4().hex[:12]


async def _get_or_create_session_agent(session_id: str):
    agents = app.state.session_agents
    meta_cache = app.state.session_meta
    agent = agents.get(session_id)
    if agent is None:
        meta = meta_cache.get(session_id)
        if meta is None:
            pool = app.state.db_pool
            meta = await get_session(pool, session_id)
            meta_cache[session_id] = meta

        storage_mode = "legacy"
        if meta and meta.get("storage_mode") in ("legacy", "sandboxed"):
            storage_mode = meta["storage_mode"]

        if storage_mode == "sandboxed":
            session_root = _get_session_root(session_id)
            session_root.mkdir(parents=True, exist_ok=True)
            agent = create_paper_agent(
                session_id=session_id,
                session_root=session_root,
                storage_mode="sandboxed",
            )
        else:
            agent = create_paper_agent(
                session_id=session_id,
                storage_mode="legacy",
            )
        agents[session_id] = agent
    return agent

def _truncate_text(value: Any, max_chars: int) -> str:
    text = str(value or "").strip()
    if len(text) <= max_chars:
        return text
    return text[: max_chars - 3] + "..."


def _safe_compact_json(value: Any, max_chars: int = 300) -> str:
    try:
        text = json.dumps(value if value is not None else {}, ensure_ascii=False, separators=(",", ":"))
    except Exception:
        text = str(value)
    return _truncate_text(text, max_chars=max_chars)


def _build_history_context(messages: List[Dict[str, Any]], user_index: int, max_messages: int = 20) -> str:
    context_messages = messages[:user_index] if user_index >= 0 else messages
    if max_messages and len(context_messages) > max_messages:
        context_messages = context_messages[-max_messages:]

    lines: List[str] = []
    for m in context_messages:
        role = m.get("role")
        content = str(m.get("content") or "").strip()
        if not content:
            continue
        if role == "user":
            prefix = "User"
        elif role == "assistant":
            prefix = "Assistant"
        elif role:
            prefix = str(role).capitalize()
        else:
            prefix = "Message"
        lines.append(f"{prefix}: {content}")
    return "\n".join(lines)


def _normalize_retrieval_record(raw: Dict[str, Any], source_tool: str) -> Optional[Dict[str, Any]]:
    url = str(raw.get("url") or raw.get("pdf_url") or raw.get("entry_id") or raw.get("source_url") or "").strip()
    title = str(raw.get("title") or "").strip()
    abstract = str(raw.get("abstract") or raw.get("summary") or "").strip()
    if not (url and title and abstract):
        return None

    record: Dict[str, Any] = {
        "url": _truncate_text(url, 1000),
        "title": _truncate_text(title, 500),
        "abstract": _truncate_text(abstract, 1800),
        "source_tool": source_tool,
    }
    paper_id = raw.get("paper_id") or raw.get("id") or raw.get("pmid")
    if paper_id is not None and str(paper_id).strip():
        record["paper_id"] = _truncate_text(str(paper_id), 128)
    return record


def _collect_retrieval_records(node: Any, source_tool: str, output: List[Dict[str, Any]]) -> None:
    if isinstance(node, dict):
        normalized = _normalize_retrieval_record(node, source_tool=source_tool)
        if normalized is not None:
            output.append(normalized)
        for value in node.values():
            _collect_retrieval_records(value, source_tool=source_tool, output=output)
        return
    if isinstance(node, list):
        for item in node:
            _collect_retrieval_records(item, source_tool=source_tool, output=output)


def _extract_retrieval_records_from_tool_result(tool_name: str, tool_result: Any) -> List[Dict[str, Any]]:
    if tool_result is None:
        return []

    parsed: Any = None
    if isinstance(tool_result, (dict, list)):
        parsed = tool_result
    elif isinstance(tool_result, str):
        text = tool_result.strip()
        if not text:
            return []
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            return []
    else:
        return []

    records: List[Dict[str, Any]] = []
    _collect_retrieval_records(parsed, source_tool=tool_name, output=records)
    return _merge_retrieval_records([], records)


def _merge_retrieval_records(existing: List[Dict[str, Any]], new_items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    merged: List[Dict[str, Any]] = []
    index_by_key: Dict[str, int] = {}

    def _key(record: Dict[str, Any]) -> str:
        paper_id = str(record.get("paper_id") or "").strip()
        if paper_id:
            return f"paper:{paper_id}"
        return f"url:{str(record.get('url') or '').strip()}"

    for record in existing + new_items:
        if not isinstance(record, dict):
            continue
        normalized = _normalize_retrieval_record(record, source_tool=str(record.get("source_tool") or "unknown"))
        if normalized is None:
            continue
        key = _key(normalized)
        if key in index_by_key:
            idx = index_by_key[key]
            if not merged[idx].get("paper_id") and normalized.get("paper_id"):
                merged[idx]["paper_id"] = normalized["paper_id"]
            continue
        index_by_key[key] = len(merged)
        merged.append(normalized)
    return merged


def _render_compressed_retrieval_block(compressed_block: Dict[str, Any]) -> str:
    records = compressed_block.get("retrieval_records")
    if not isinstance(records, list) or not records:
        return ""

    lines = ["[Compressed Retrieval Memory]"]
    for record in records:
        if not isinstance(record, dict):
            continue
        url = _truncate_text(record.get("url"), 1000)
        title = _truncate_text(record.get("title"), 500)
        abstract = _truncate_text(record.get("abstract"), 280)
        if not (url and title and abstract):
            continue
        lines.append(f"- {url} | {title} | {abstract}")
    return "\n".join(lines) if len(lines) > 1 else ""


def _render_recent_tool_calls_block(tool_calls: List[Dict[str, Any]]) -> str:
    if not tool_calls:
        return ""

    lines = ["[Recent Tool Calls]"]
    for call in tool_calls:
        tool_name = _truncate_text(call.get("tool_name"), 120) or "unknown_tool"
        tool_args = _safe_compact_json(call.get("tool_args") or {}, max_chars=240)
        summary = _truncate_text(call.get("tool_result_summary"), 280)
        lines.append(f"- {tool_name}(args={tool_args}) => {summary}")
    return "\n".join(lines)


def _render_uploaded_papers_block(uploaded_papers: List[Dict[str, Any]]) -> str:
    if not uploaded_papers:
        return ""
    lines = [
        "[Uploaded Papers]",
        "The user uploaded a PDF paper. Use read_paper('uploaded://{paper_id}') to read it.",
    ]
    for paper in uploaded_papers:
        paper_id = _truncate_text(paper.get("paper_id"), 128)
        if not paper_id:
            continue
        filename = _truncate_text(paper.get("original_filename"), 220) or "unknown.pdf"
        pages = int(paper.get("page_count") or 0)
        md_path = _truncate_text(paper.get("canonical_md_path"), 500)
        lines.append(f"- uploaded://{paper_id} | {filename} | pages={pages} | md={md_path}")
    return "\n".join(lines) if len(lines) > 2 else ""


def _build_effective_prompt(
    messages: List[Dict[str, Any]],
    user_index: int,
    user_query: str,
    compressed_block: Dict[str, Any],
    recent_tool_calls: List[Dict[str, Any]],
    uploaded_papers: Optional[List[Dict[str, Any]]] = None,
    max_messages: int = 20,
) -> str:
    sections: List[str] = []
    history_block = _build_history_context(messages, user_index=user_index, max_messages=max_messages)
    if history_block:
        sections.append(history_block)

    compressed_text = str(compressed_block.get("rendered_text") or "").strip()
    if not compressed_text:
        compressed_text = _render_compressed_retrieval_block(compressed_block)
    if compressed_text:
        sections.append(compressed_text)

    recent_tools_text = _render_recent_tool_calls_block(recent_tool_calls)
    if recent_tools_text:
        sections.append(recent_tools_text)

    uploaded_text = _render_uploaded_papers_block(uploaded_papers or [])
    if uploaded_text:
        sections.append(uploaded_text)

    if sections and user_query:
        return "\n\n".join(sections) + f"\n\nUser: {user_query}"
    if user_query:
        return user_query
    return "\n\n".join(sections)


def _compute_context_ratio(prompt_tokens: int, window_tokens: int) -> float:
    if window_tokens <= 0:
        return 0.0
    return float(prompt_tokens) / float(window_tokens)


def _should_trigger_context_compression(ratio: float, threshold_ratio: float) -> bool:
    return ratio >= threshold_ratio


async def _compress_context_memory(
    pool: Any,
    session_id: str,
    compression_state: Dict[str, Any],
    keep_recent: int,
    context_window_tokens: int,
    threshold_ratio: float,
) -> Tuple[Dict[str, Any], bool]:
    keep_from_id = await get_recent_tool_calls_keep_from_id(pool, session_id, keep_recent=keep_recent)
    if keep_from_id is None:
        return compression_state.get("compressed_block") or {}, False

    last_compressed_id = int(compression_state.get("last_compressed_tool_call_id") or 0)
    candidates = await get_tool_calls_for_compression(
        pool,
        session_id,
        after_id=last_compressed_id,
        before_id=keep_from_id,
    )
    if not candidates:
        return compression_state.get("compressed_block") or {}, False

    existing_block = compression_state.get("compressed_block")
    if not isinstance(existing_block, dict):
        existing_block = {}
    existing_records = existing_block.get("retrieval_records")
    if not isinstance(existing_records, list):
        existing_records = []

    new_records: List[Dict[str, Any]] = []
    for item in candidates:
        retrieval_records = item.get("retrieval_records")
        if isinstance(retrieval_records, list):
            for record in retrieval_records:
                if isinstance(record, dict):
                    new_records.append(record)

    merged_records = _merge_retrieval_records(existing_records, new_records)
    new_block = {
        "retrieval_records": merged_records,
    }
    new_block["rendered_text"] = _render_compressed_retrieval_block(new_block)
    last_new_id = max(int(item["id"]) for item in candidates)
    saved = await update_session_context_compression_state(
        pool,
        session_id=session_id,
        compressed_block=new_block,
        last_compressed_tool_call_id=last_new_id,
        context_window_tokens=context_window_tokens,
        threshold_ratio=threshold_ratio,
    )
    if not saved:
        return existing_block, False
    return new_block, True


async def _prepare_prompt_with_context_management(
    pool: Any,
    session_id: str,
    messages: List[Dict[str, Any]],
    user_index: int,
    user_query: str,
) -> Tuple[str, Dict[str, Any]]:
    compression_state = await upsert_session_context_compression_state(
        pool,
        session_id=session_id,
        context_window_tokens=CONTEXT_WINDOW_TOKENS,
        threshold_ratio=CONTEXT_COMPRESSION_RATIO,
    )
    compressed_block = compression_state.get("compressed_block")
    if not isinstance(compressed_block, dict):
        compressed_block = {}

    uploaded_papers = await list_session_uploaded_papers(pool, session_id)
    recent_tool_calls = await get_recent_session_tool_calls(pool, session_id, limit=TOOL_KEEP_RECENT)
    recent_tool_calls = list(reversed(recent_tool_calls))
    prompt = _build_effective_prompt(
        messages=messages,
        user_index=user_index,
        user_query=user_query,
        compressed_block=compressed_block,
        recent_tool_calls=recent_tool_calls,
        uploaded_papers=uploaded_papers,
    )
    prompt_tokens = estimate_tokens(prompt)
    ratio = _compute_context_ratio(prompt_tokens, CONTEXT_WINDOW_TOKENS)
    compressed_this_turn = False

    if _should_trigger_context_compression(ratio, CONTEXT_COMPRESSION_RATIO):
        compressed_block, compressed_this_turn = await _compress_context_memory(
            pool=pool,
            session_id=session_id,
            compression_state=compression_state,
            keep_recent=TOOL_KEEP_RECENT,
            context_window_tokens=CONTEXT_WINDOW_TOKENS,
            threshold_ratio=CONTEXT_COMPRESSION_RATIO,
        )
        if compressed_this_turn:
            recent_tool_calls = await get_recent_session_tool_calls(pool, session_id, limit=TOOL_KEEP_RECENT)
            recent_tool_calls = list(reversed(recent_tool_calls))
            prompt = _build_effective_prompt(
                messages=messages,
                user_index=user_index,
                user_query=user_query,
                compressed_block=compressed_block,
                recent_tool_calls=recent_tool_calls,
                uploaded_papers=uploaded_papers,
            )
            prompt_tokens = estimate_tokens(prompt)
            ratio = _compute_context_ratio(prompt_tokens, CONTEXT_WINDOW_TOKENS)

    context_info = {
        "estimated_prompt_tokens": prompt_tokens,
        "window_tokens": CONTEXT_WINDOW_TOKENS,
        "ratio": round(ratio, 6),
        "compressed_this_turn": compressed_this_turn,
        "recent_tool_calls_kept": len(recent_tool_calls),
        "uploaded_papers": len(uploaded_papers),
    }
    return prompt, context_info

_CORS_ORIGINS = [
    origin.strip()
    for origin in os.getenv(
        "CORS_ALLOWED_ORIGINS",
        "https://infinity.zhangyvjing.com,http://localhost:3000,http://127.0.0.1:3000,http://127.0.0.1:13000,http://localhost:13000,http://127.0.0.1:13001,http://localhost:13001",
    ).split(",")
    if origin.strip()
]


def _is_allowed_browser_origin(origin: Optional[str]) -> bool:
    """Accept same-origin/non-browser requests, reject foreign browser origins."""
    return not origin or origin in _CORS_ORIGINS

app.add_middleware(
    CORSMiddleware,
    allow_origins=_CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def cookie_csrf_boundary(request: Request, call_next):
    """Reject cross-origin state changes made with the browser session cookie."""
    if request.method in {"POST", "PUT", "PATCH", "DELETE"} and request.cookies.get(SESSION_COOKIE_NAME):
        origin = request.headers.get("origin")
        if not _is_allowed_browser_origin(origin):
            return JSONResponse({"detail": "Cross-origin state change rejected"}, status_code=403)
        csrf_cookie = request.cookies.get(CSRF_COOKIE_NAME)
        csrf_header = request.headers.get("x-csrf-token")
        if not csrf_cookie or not csrf_header or not hmac.compare_digest(csrf_cookie, csrf_header):
            return JSONResponse({"detail": "CSRF token required"}, status_code=403)
    try:
        return await call_next(request)
    finally:
        # Starlette's BaseHTTPMiddleware may execute call_next in a child
        # context, so a Token created by an auth dependency cannot be reset in
        # this parent context. Clearing here protects the parent task; the
        # request child task ends with the response.
        clear_rls_context()


@app.middleware("http")
async def multipart_upload_boundary(request: Request, call_next):
    """Reject oversized multipart requests before Starlette parses/spools them.

    The endpoint handlers still enforce per-file streaming limits.  This
    request-level guard closes the earlier gap where a client could send a
    body larger than the combined method/dataset budget and make the
    multipart parser spool it before the handlers ran.  Multipart requests
    must declare their size: accepting an unbounded chunked body would make
    the framework parser the first component responsible for enforcing the
    limit.
    """
    if request.method == "POST":
        route_limits = {
            "/api/dataset-snapshots/upload": MAX_DATASET_UPLOAD_BYTES,
            "/api/resources/upload": MAX_DATASET_UPLOAD_BYTES,
            "/api/method-sources/upload": MAX_METHOD_SOURCE_BYTES,
            "/api/tasks/submit-bundle": MAX_DATASET_UPLOAD_BYTES + MAX_METHOD_SOURCE_BYTES,
        }
        normalized_path = request.url.path.rstrip("/")
        limit = route_limits.get(normalized_path)
        if limit is None and re.fullmatch(r"/api/sessions/[^/]+/uploads/papers", normalized_path):
            limit = _MAX_UPLOAD_PDF_BYTES
        content_length = request.headers.get("content-length")
        content_type = request.headers.get("content-type", "").lower()
        if limit is not None and content_type.startswith("multipart/") and not content_length:
            return JSONResponse(
                {"detail": "Content-Length is required for multipart uploads"},
                status_code=411,
            )
        if limit is not None and content_length:
            try:
                declared_size = int(content_length)
            except ValueError:
                return JSONResponse({"detail": "Invalid Content-Length"}, status_code=400)
            # Multipart boundaries, headers, and filenames need a bounded
            # amount of overhead but should not turn into an unbounded parser
            # allocation. The actual file limits remain authoritative.
            overhead = _env_int("MULTIPART_OVERHEAD_BYTES", 32 * 1024 * 1024)
            if declared_size > limit + max(0, overhead):
                return JSONResponse({"detail": "Multipart upload exceeds the request size limit"}, status_code=413)
    return await call_next(request)

def _resolve_relative_in_dirs(file_path: str, allowed_dirs: List[FilePath]) -> Optional[FilePath]:
    raw_path = str(file_path or "")
    target = FilePath(raw_path)
    if target.is_absolute() and target.exists():
        return target

    normalized = raw_path.replace("\\", "/").lstrip("/")
    while normalized.startswith("./"):
        normalized = normalized[2:]
    normalized = normalized.lstrip("/")
    if not normalized:
        return None

    def _is_link_free(candidate: FilePath, root: FilePath) -> bool:
        try:
            relative = candidate.absolute().relative_to(root.absolute())
        except ValueError:
            return False
        current = root.absolute()
        for part in relative.parts:
            current = current / part
            try:
                if current.is_symlink():
                    return False
            except OSError:
                return False
        return True

    for allowed in allowed_dirs:
        candidate = allowed / normalized
        if candidate.exists() and candidate.is_file() and _is_link_free(candidate, allowed):
            return candidate

    # For plain filenames in img:// refs, search recursively.
    if "/" not in normalized and "\\" not in normalized:
        for allowed in allowed_dirs:
            for candidate in allowed.rglob(normalized):
                if candidate.is_file() and _is_link_free(candidate, allowed):
                    return candidate
    return None


def _infer_paper_id_from_shared_path(resolved: FilePath, shared_root: FilePath) -> Optional[str]:
    """Infer paper_id from canonical shared-cache layouts when possible."""
    try:
        rel = resolved.resolve().relative_to(shared_root.resolve())
    except ValueError:
        return None
    parts = rel.parts
    if not parts:
        return None
    # papers/cache/downloads/{paper_id}.pdf
    if parts[0] in {"downloads", "md"} and len(parts) >= 2:
        return FilePath(parts[1]).stem
    # papers/cache/extracted/{paper_id}/...
    if parts[0] == "extracted" and len(parts) >= 2:
        return parts[1]
    return None

@app.get("/api/files/{file_path:path}")
async def serve_file(file_path: str):
    # Files must always be served via a session-scoped route so ownership can
    # be checked.  Keeping this route would make cached papers public.
    raise HTTPException(status_code=404, detail="Use a session-scoped file URL")


@app.get("/api/sessions/{session_id}/files/{file_path:path}")
async def serve_session_file(session_id: str, file_path: str, user: Principal = Depends(require_user)):
    """Serve files scoped to a specific session sandbox."""
    try:
        uuid.UUID(session_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid session ID format")

    pool = app.state.db_pool
    meta = await get_session(pool, session_id, user.user_id)
    if not meta:
        raise HTTPException(status_code=404, detail="Session not found")

    if (meta.get("storage_mode") or "legacy") == "legacy":
        raise HTTPException(status_code=404, detail="Legacy session files are unavailable")

    session_root = _get_session_root(session_id).resolve()
    allowed_dirs = [
        session_root,
        session_root / "plot_outputs",
        session_root / "plotly_outputs",
        session_root / "reports",
        session_root / "md",
        session_root / "extracted",
        _SHARED_PAPERS_CACHE_ROOT,
        _SHARED_PAPERS_CACHE_ROOT / "reports",
        _SHARED_PAPERS_CACHE_ROOT / "md",
        _SHARED_PAPERS_CACHE_ROOT / "extracted",
        _SHARED_PAPERS_CACHE_ROOT / "downloads",
    ]
    target = _resolve_relative_in_dirs(file_path, allowed_dirs)
    if target is None:
        raise HTTPException(status_code=404, detail="File not found")

    resolved = target.resolve()
    try:
        in_session = resolved.is_relative_to(session_root)
        in_shared = resolved.is_relative_to(_SHARED_PAPERS_CACHE_ROOT.resolve())
    except AttributeError:
        in_session = str(resolved).startswith(str(session_root) + os.sep)
        in_shared = str(resolved).startswith(str(_SHARED_PAPERS_CACHE_ROOT.resolve()) + os.sep)
    if not (in_session or in_shared) or not resolved.is_file():
        raise HTTPException(status_code=404, detail="File not found")

    if in_shared:
        inferred_paper_id = _infer_paper_id_from_shared_path(resolved, _SHARED_PAPERS_CACHE_ROOT)
        paper_id = inferred_paper_id
        if not paper_id:
            paper_id = await resolve_global_paper_id_by_path(pool, str(resolved))
        if not paper_id:
            raise HTTPException(status_code=403, detail="File access not authorized for this session")
        allowed = await session_can_access_paper(pool, session_id, paper_id)
        if not allowed:
            raise HTTPException(status_code=403, detail="File access not authorized for this session")
    return FileResponse(str(resolved))


# ---------------------------------------------------------------------------
# Image img:// → base64 conversion for streaming responses
# ---------------------------------------------------------------------------
_IMG_REF_PATTERN = re.compile(r'!\[([^\]]*)\]\(img://([^)]+)\)')
_IMAGE_MIME = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
}

def _resolve_image_ref(ref_path: str) -> Optional[FilePath]:
    """Resolve an img:// path reference to an actual file path."""
    normalized = ref_path.replace("\\", "/").lstrip("/")
    while normalized.startswith("./"):
        normalized = normalized[2:]
    normalized = normalized.lstrip("/")
    if not normalized:
        return None
    for d in [*_LEGACY_ALLOWED_FILE_DIRS, _SHARED_PAPERS_CACHE_ROOT]:
        candidate = d / normalized
        if candidate.exists() and candidate.is_file():
            return candidate
    # Backward compatibility for basename refs.
    if "/" not in normalized:
        for d in [*_LEGACY_ALLOWED_FILE_DIRS, _SHARED_PAPERS_CACHE_ROOT]:
            for candidate in d.rglob(normalized):
                if candidate.is_file():
                    return candidate
    return None

def _replace_image_refs_with_base64(text: str) -> str:
    """Scan Markdown for ![alt](img://filename) and convert to base64 data URLs."""
    def _convert(match):
        alt, ref_path = match.group(1), match.group(2)
        resolved = _resolve_image_ref(ref_path)
        if not resolved:
            logging.warning(f"Image not found: img://{ref_path}")
            return match.group(0)
        ext = resolved.suffix.lower()
        mime = _IMAGE_MIME.get(ext)
        if not mime:
            return match.group(0)
        try:
            b64 = base64.b64encode(resolved.read_bytes()).decode('ascii')
            logging.info(f"Converted img://{ref_path} to base64 ({resolved.stat().st_size} bytes)")
            return f'![{alt}](data:{mime};base64,{b64})'
        except Exception as e:
            logging.warning(f"Failed to encode image {resolved}: {e}")
            return match.group(0)

    return _IMG_REF_PATTERN.sub(_convert, text)


class ChatRequest(BaseModel):
    session_id: str
    messages: List[Dict[str, Any]]
    # WebSocket API cannot attach an Authorization header in browsers. This is
    # sent only in the initial frame and never included in server responses.
    access_token: Optional[str] = None
    retry_attempt: int = 0
    client_request_id: Optional[str] = None


class SessionTitleUpdate(BaseModel):
    title: str


def _extract_chunk_content(chunk: Any) -> Optional[str]:
    """Extract text content from different chunk formats returned by Agno/OpenAI-like SDKs."""
    event_name = getattr(chunk, "event", None)
    if event_name and event_name != "RunContent":
        return None

    content = None
    if hasattr(chunk, "choices") and len(chunk.choices) > 0:
        delta = getattr(chunk.choices[0], "delta", None)
        if delta:
            content = getattr(delta, "content", None)
    elif hasattr(chunk, "content"):
        raw = chunk.content
        if isinstance(raw, str):
            content = raw
        elif isinstance(raw, list):
            parts = [item if isinstance(item, str) else getattr(item, "text", str(item)) for item in raw]
            content = "".join(parts) if parts else None
    elif isinstance(chunk, str):
        content = chunk
    return content


def _extract_tool_names(chunk: Any) -> List[str]:
    """Extract tool/function names from streaming chunks."""
    names: List[str] = []
    event_name = getattr(chunk, "event", None)
    if event_name in ("ToolCallStarted", "ToolCallCompleted"):
        tool_exec = getattr(chunk, "tool", None)
        if tool_exec is not None:
            tool_name = getattr(tool_exec, "tool_name", None)
            if tool_name:
                names.append(str(tool_name))

    # Agno-style chunk.tools
    tools = getattr(chunk, "tools", None)
    if tools:
        for tool in tools:
            name = None
            if isinstance(tool, dict):
                fn = tool.get("function")
                if isinstance(fn, dict):
                    name = fn.get("name")
                name = name or tool.get("name")
            else:
                name = getattr(tool, "name", None)
                if not name:
                    fn = getattr(tool, "function", None)
                    if isinstance(fn, dict):
                        name = fn.get("name")
                    elif fn is not None:
                        name = getattr(fn, "name", None)
            if name:
                names.append(str(name))

    # OpenAI-style delta.tool_calls
    choices = getattr(chunk, "choices", None)
    if choices and len(choices) > 0:
        delta = getattr(choices[0], "delta", None)
        tool_calls = getattr(delta, "tool_calls", None) if delta is not None else None
        if tool_calls:
            for tc in tool_calls:
                name = None
                if isinstance(tc, dict):
                    fn = tc.get("function")
                    if isinstance(fn, dict):
                        name = fn.get("name")
                else:
                    fn = getattr(tc, "function", None)
                    if isinstance(fn, dict):
                        name = fn.get("name")
                    elif fn is not None:
                        name = getattr(fn, "name", None)
                if name:
                    names.append(str(name))
    return names


def _coerce_tool_execution(tool: Any) -> Optional[Dict[str, Any]]:
    if tool is None:
        return None

    if isinstance(tool, dict):
        tool_name = tool.get("tool_name") or tool.get("name")
        tool_call_id = tool.get("tool_call_id") or tool.get("id")
        tool_args = tool.get("tool_args") or tool.get("arguments") or {}
        result = tool.get("result")
    else:
        tool_name = getattr(tool, "tool_name", None) or getattr(tool, "name", None)
        tool_call_id = getattr(tool, "tool_call_id", None) or getattr(tool, "id", None)
        tool_args = getattr(tool, "tool_args", None) or getattr(tool, "arguments", None) or {}
        result = getattr(tool, "result", None)

    if not tool_name:
        return None
    if isinstance(tool_args, str):
        try:
            tool_args = json.loads(tool_args)
        except json.JSONDecodeError:
            tool_args = {"raw": tool_args}
    if not isinstance(tool_args, dict):
        tool_args = {"raw": str(tool_args)}
    return {
        "tool_call_id": str(tool_call_id) if tool_call_id is not None else None,
        "tool_name": str(tool_name),
        "tool_args": tool_args,
        "result": "" if result is None else str(result),
    }


def _extract_completed_tool_executions(chunk: Any) -> List[Dict[str, Any]]:
    executions: List[Dict[str, Any]] = []
    event_name = getattr(chunk, "event", None)

    if event_name == "ToolCallCompleted":
        item = _coerce_tool_execution(getattr(chunk, "tool", None))
        if item is not None:
            executions.append(item)

    tools = getattr(chunk, "tools", None)
    if tools:
        for tool in tools:
            item = _coerce_tool_execution(tool)
            if item is not None and item.get("result"):
                executions.append(item)
    return executions


def _tool_execution_identity_key(tool_execution: Dict[str, Any]) -> str:
    call_id = str(tool_execution.get("tool_call_id") or "").strip()
    if call_id:
        return f"id:{call_id}"
    digest_source = json.dumps(
        {
            "tool_name": tool_execution.get("tool_name"),
            "tool_args": tool_execution.get("tool_args"),
            "result": _truncate_text(tool_execution.get("result"), 1200),
        },
        ensure_ascii=False,
        sort_keys=True,
        default=str,
    )
    return "hash:" + hashlib.sha1(digest_source.encode("utf-8")).hexdigest()


def _summarize_tool_result(result: Any, max_chars: int = 400) -> str:
    if result is None:
        return ""
    text = str(result).strip()
    if not text:
        return ""
    return _truncate_text(text, max_chars=max_chars)


async def _persist_task_draft_tool_result(
    *,
    pool,
    session_id: str,
    user_id: str,
    tool_result: str,
) -> Optional[Dict[str, Any]]:
    """Persist a real prepare/revise draft result into the user-scoped DB."""
    try:
        payload = json.loads(tool_result)
    except (TypeError, ValueError):
        return None
    if not isinstance(payload, dict) or payload.get("type") not in {"task_draft", "task_draft_updated"}:
        return None
    if str(payload.get("session_id") or "") != str(session_id):
        logger.warning("Ignoring task draft for a different session")
        return None
    try:
        draft_id = str(uuid.UUID(str(payload.get("draft_id"))))
        uuid.UUID(session_id)
    except (ValueError, TypeError, AttributeError):
        logger.warning("Ignoring task draft with invalid identity")
        return None

    session_root = _get_session_root(session_id).resolve()
    method = payload.get("method") if isinstance(payload.get("method"), dict) else None
    if method:
        relative_path = safe_relative_path(str(method.get("relative_path") or ""))
        method_path = ensure_within(session_root, session_root / relative_path)
        if not method_path.is_file() or method_path.is_symlink():
            logger.warning("Ignoring task draft whose execution document is missing")
            return None
        method_size = method_path.stat().st_size
        if method_size > TASK_INPUT_MAX_BYTES:
            logger.warning("Ignoring task draft whose execution document exceeds 25 MB")
            return None
        method_bytes = method_path.read_bytes()
        method_hash = hashlib.sha256(method_bytes).hexdigest()
        method["relative_path"] = relative_path
        method["size_bytes"] = method_size
        method["sha256"] = method_hash
        method["preview"] = method_bytes.decode("utf-8", errors="replace")[:12000]

    dataset = payload.get("dataset") if isinstance(payload.get("dataset"), dict) else {}
    dataset_id = str(dataset.get("resource_id") or "").strip()
    if dataset_id:
        try:
            resource = await _get_project_resource(pool, dataset_id, user_id)
        except Exception:
            resource = None
        if resource and resource.get("kind") == "dataset" and int(resource.get("file_size_bytes") or 0) <= TASK_INPUT_MAX_BYTES:
            try:
                resource_path = _safe_storage_path(
                    FilePath(os.getenv("RESOURCE_STORAGE_ROOT", "/workspace/resources")),
                    str(resource["storage_key"]),
                )
                if resource_path.is_file() and not resource_path.is_symlink():
                    resource_size = resource_path.stat().st_size
                    if resource_size <= TASK_INPUT_MAX_BYTES:
                        resource_hasher = hashlib.sha256()
                        with resource_path.open("rb") as resource_handle:
                            for chunk in iter(lambda: resource_handle.read(1024 * 1024), b""):
                                resource_hasher.update(chunk)
                        dataset.update({
                            "resource_id": resource["resource_id"],
                            "filename": resource["logical_name"],
                            "size_bytes": resource_size,
                            "sha256": resource_hasher.hexdigest(),
                        })
                    else:
                        dataset = {"resource_id": None, "filename": None}
                else:
                    dataset = {"resource_id": None, "filename": None}
            except (OSError, HTTPException):
                dataset = {"resource_id": None, "filename": None}
        else:
            dataset = {"resource_id": None, "filename": None}
    else:
        dataset = {"resource_id": None, "filename": None}

    project = await ensure_default_project(pool, user_id=user_id)
    payload["draft_id"] = draft_id
    payload["method"] = method
    payload["dataset"] = dataset
    payload["missing_inputs"] = [
        item for item in (payload.get("missing_inputs") if isinstance(payload.get("missing_inputs"), list) else [])
        if item != "dataset" or not dataset.get("resource_id")
    ]
    payload["missing_inputs"] = [
        item for item in payload["missing_inputs"]
        if item != "method" or method is None
    ]
    if method is None and "method" not in payload["missing_inputs"]:
        payload["missing_inputs"].append("method")
    if not dataset.get("resource_id") and "dataset" not in payload["missing_inputs"]:
        payload["missing_inputs"].append("dataset")
    draft = await upsert_task_draft(pool, payload, owner_user_id=user_id, project_id=project["project_id"])
    return {
        "draft_id": draft["draft_id"],
        "session_id": draft["session_id"],
        "project_id": draft["project_id"],
        "revision": draft["revision"],
        "status": draft["status"],
        "title": draft["title"],
        "goal_summary": draft["goal_summary"],
        "session_id": draft["session_id"],
        "method": ({
            "filename": draft["method_filename"],
            "size_bytes": draft["method_size_bytes"],
            "sha256": draft["method_hash_sha256"],
            "preview": draft["method_preview"],
        } if draft["method_path"] else None),
        "dataset": {
            "resource_id": draft["dataset_resource_id"],
            "filename": draft["dataset_filename"],
            "size_bytes": draft["dataset_size_bytes"],
            "sha256": draft["dataset_hash_sha256"],
        },
        "task_spec": draft["task_spec"],
        "missing_inputs": draft["missing_inputs"],
    }


async def _persist_task_draft_tool_event(
    *,
    pool,
    session_id: str,
    user_id: str,
    tool_result: str,
) -> Optional[Dict[str, Any]]:
    """Persist draft create/update/cancel events and return the browser event."""
    try:
        payload = json.loads(tool_result)
    except (TypeError, ValueError):
        return None
    if not isinstance(payload, dict) or payload.get("type") != "task_draft_cancelled":
        return await _persist_task_draft_tool_result(
            pool=pool, session_id=session_id, user_id=user_id, tool_result=tool_result
        )
    if str(payload.get("session_id") or "") != str(session_id):
        return None
    try:
        draft_id = str(uuid.UUID(str(payload.get("draft_id"))))
        uuid.UUID(session_id)
    except (ValueError, TypeError, AttributeError):
        return None
    if not await cancel_task_draft(pool, draft_id, user_id):
        return None
    draft_root = ensure_within(_get_session_root(session_id).resolve(), _get_session_root(session_id) / "task-drafts" / draft_id)
    if draft_root.exists() and draft_root.is_dir() and not draft_root.is_symlink():
        shutil.rmtree(draft_root, ignore_errors=True)
    return {"draft_id": draft_id, "revision": int(payload.get("revision") or 1), "status": "cancelled"}


def _start_stream_worker(sync_iter: Any) -> Tuple[asyncio.Queue, threading.Event]:
    """Run a blocking stream iterator in a background thread and forward items to an asyncio queue."""
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue = asyncio.Queue()
    stop_event = threading.Event()

    def _worker():
        try:
            for item in sync_iter:
                if stop_event.is_set():
                    break
                loop.call_soon_threadsafe(queue.put_nowait, ("item", item))
        except Exception as e:
            loop.call_soon_threadsafe(queue.put_nowait, ("error", e))
        finally:
            loop.call_soon_threadsafe(queue.put_nowait, ("done", None))

    threading.Thread(target=_worker, daemon=True).start()
    return queue, stop_event


def _stop_stream_worker(stop_event: Optional[threading.Event], response_stream: Any) -> None:
    if stop_event is not None:
        stop_event.set()
    close_method = getattr(response_stream, "close", None) if response_stream is not None else None
    if callable(close_method):
        try:
            close_method()
        except Exception:
            pass


async def _send_status_event(
    websocket: WebSocket,
    phase: str,
    elapsed_ms: int,
    attempt: int,
    max_attempts: int,
    tool_name: Optional[str] = None,
    reason: Optional[str] = None,
) -> None:
    """Send structured progress events to frontend."""
    if not ENABLE_WS_STATUS_EVENTS:
        return
    payload: Dict[str, Any] = {
        "type": "status",
        "phase": phase,
        "elapsed_ms": elapsed_ms,
        "attempt": attempt,
        "max_attempts": max_attempts,
    }
    if tool_name:
        payload["tool_name"] = tool_name
    if reason:
        payload["reason"] = reason
    await websocket.send_json(payload)

@app.post("/api/sessions")
async def create_session(user: Principal = Depends(require_user)):
    # Session creation shares the paperAgent throttle to stop session spamming.
    allowed, _remaining = await _check_user_rate_limit(user.user_id, action="create_session")
    if not allowed:
        limit, window = _rate_limit_settings()
        raise HTTPException(
            status_code=429,
            detail=f"Rate limit exceeded: at most {limit} requests per {window}s",
            headers={"Retry-After": str(window)},
        )
    session_id = str(uuid.uuid4())
    try:
        pool = app.state.db_pool
        await insert_session(pool, session_id, user.user_id, storage_mode="sandboxed")
        await _get_or_create_session_agent(session_id)
    except Exception:
        logging.exception("Failed to create session")
        raise HTTPException(status_code=500, detail="Failed to create session")

    return {"session_id": session_id, "storage_mode": "sandboxed"}

@app.get("/api/sessions")
async def list_sessions(user: Principal = Depends(require_user)):
    """
    获取会话列表（按最近更新时间倒序）
    """
    pool = app.state.db_pool
    if not pool:
        raise HTTPException(status_code=500, detail="Database not initialized")
    try:
        sessions = await get_all_sessions(pool, user.user_id)
        return sessions
    except Exception:
        logging.exception("Failed to fetch sessions")
        raise HTTPException(status_code=500, detail="Failed to fetch sessions")

@app.patch("/api/sessions/{session_id}/title")
async def update_session_title_endpoint(session_id: str, payload: SessionTitleUpdate, user: Principal = Depends(require_user)):
    try:
        uuid.UUID(session_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid session ID format")

    title = (payload.title or "").strip()
    if not title:
        raise HTTPException(status_code=400, detail="Title cannot be empty")
    if len(title) > 255:
        raise HTTPException(status_code=400, detail="Title too long")

    pool = app.state.db_pool
    if not pool:
        raise HTTPException(status_code=500, detail="Database not initialized")

    try:
        updated = await update_session_title(pool, session_id, title, user.user_id)
        if not updated:
            raise HTTPException(status_code=404, detail="Session not found")
        return {"session_id": session_id, "title": title}
    except HTTPException:
        raise
    except Exception:
        logging.exception("Failed to update session title")
        raise HTTPException(status_code=500, detail="Failed to update session title")

@app.delete("/api/sessions/{session_id}")
async def delete_session_endpoint(session_id: str, user: Principal = Depends(require_user)):
    try:
        uuid.UUID(session_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid session ID format")

    pool = app.state.db_pool
    if not pool:
        raise HTTPException(status_code=500, detail="Database not initialized")

    try:
        deleted = await delete_session(pool, session_id, user.user_id)
        if not deleted:
            raise HTTPException(status_code=404, detail="Session not found")
        return {"session_id": session_id}
    except HTTPException:
        raise
    except Exception:
        logging.exception("Failed to delete session")
        raise HTTPException(status_code=500, detail="Failed to delete session")


@app.post("/api/sessions/{session_id}/uploads/papers")
async def upload_session_paper(session_id: str, file: UploadFile = File(...), user: Principal = Depends(require_user)):
    try:
        uuid.UUID(session_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid session ID format")

    pool = app.state.db_pool
    if not pool:
        raise HTTPException(status_code=500, detail="Database not initialized")

    meta = await get_session(pool, session_id, user.user_id)
    if not meta:
        raise HTTPException(status_code=404, detail="Session not found")
    if (meta.get("storage_mode") or "legacy") == "legacy":
        raise HTTPException(status_code=400, detail="PDF upload is only supported for sandboxed sessions")

    original_filename = str(file.filename or "").strip() or "uploaded.pdf"
    lower_name = original_filename.lower()
    content_type = str(file.content_type or "").lower()
    if not lower_name.endswith(".pdf") and content_type not in _PDF_MIME_TYPES:
        raise HTTPException(status_code=400, detail="Only PDF uploads are supported")

    session_root = _get_session_root(session_id)
    uploads_dir = session_root / "uploads"
    md_dir = session_root / "md"
    extracted_root = session_root / "extracted"
    uploads_dir.mkdir(parents=True, exist_ok=True)
    md_dir.mkdir(parents=True, exist_ok=True)
    extracted_root.mkdir(parents=True, exist_ok=True)

    paper_id = _generate_uploaded_paper_id()
    stored_pdf_abs = uploads_dir / f"{paper_id}.pdf"
    stored_pdf_path = _to_project_relative(stored_pdf_abs)
    canonical_md_path = _to_project_relative(md_dir / f"{paper_id}.md")
    images_dir = _to_project_relative(extracted_root / paper_id)

    try:
        if not hasattr(pool, "acquire"):
            # Preserve the lightweight in-memory test harness contract. Real
            # asyncpg/RLS pools always use the atomic reservation below.
            existing = await list_session_uploaded_papers(pool, session_id)
            reserved = len(existing) < _MAX_SESSION_UPLOAD_PAPERS
        else:
            reserved = await reserve_session_upload_slot(
                pool,
                session_id,
                paper_id,
                original_filename,
                stored_pdf_path,
                canonical_md_path,
                images_dir,
                _MAX_SESSION_UPLOAD_PAPERS,
            )
    except Exception as exc:
        raise HTTPException(status_code=500, detail="Failed to reserve upload slot") from exc
    if not reserved:
        raise HTTPException(status_code=400, detail=f"Upload limit exceeded: max {_MAX_SESSION_UPLOAD_PAPERS} papers per session")

    async def _release_upload_reservation() -> None:
        try:
            async with pool.acquire() as conn:
                await conn.execute(
                    "DELETE FROM session_uploaded_papers WHERE session_id = $1::uuid AND paper_id = $2",
                    session_id,
                    paper_id,
                )
        except Exception:
            logging.exception("Failed to release upload reservation %s", paper_id)

    total_bytes = 0
    try:
        with stored_pdf_abs.open("wb") as out:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                total_bytes += len(chunk)
                if total_bytes > _MAX_UPLOAD_PDF_BYTES:
                    raise HTTPException(status_code=413, detail="File too large (max 50MB)")
                out.write(chunk)
    except HTTPException:
        stored_pdf_abs.unlink(missing_ok=True)
        await _release_upload_reservation()
        raise
    except Exception as exc:
        stored_pdf_abs.unlink(missing_ok=True)
        await _release_upload_reservation()
        raise HTTPException(status_code=500, detail="Failed to store uploaded PDF") from exc
    finally:
        await file.close()

    if total_bytes <= 0:
        if stored_pdf_abs.exists():
            stored_pdf_abs.unlink()
        await _release_upload_reservation()
        raise HTTPException(status_code=400, detail="Uploaded file is empty")

    try:
        with stored_pdf_abs.open("rb") as f:
            signature = f.read(5)
        if signature != b"%PDF-":
            raise HTTPException(status_code=400, detail="Uploaded file is not a valid PDF")
    except HTTPException:
        if stored_pdf_abs.exists():
            stored_pdf_abs.unlink()
        await _release_upload_reservation()
        raise
    except Exception:
        if stored_pdf_abs.exists():
            stored_pdf_abs.unlink()
        await _release_upload_reservation()
        raise HTTPException(status_code=400, detail="Failed to validate uploaded PDF")

    extractor = PDFExtractor(output_base_dir=extracted_root)
    try:
        extracted = extractor.extract(str(stored_pdf_abs), paper_id=paper_id)
    except Exception:
        logging.exception("Failed to extract uploaded PDF")
        stored_pdf_abs.unlink(missing_ok=True)
        shutil.rmtree(extracted_root / paper_id, ignore_errors=True)
        await _release_upload_reservation()
        raise HTTPException(status_code=500, detail="PDF extraction failed")

    canonical_md_abs = md_dir / f"{paper_id}.md"
    try:
        canonical_md_abs.write_text(_build_uploaded_canonical_md(paper_id, extracted), encoding="utf-8")
    except Exception as exc:
        stored_pdf_abs.unlink(missing_ok=True)
        canonical_md_abs.unlink(missing_ok=True)
        shutil.rmtree(extracted_root / paper_id, ignore_errors=True)
        await _release_upload_reservation()
        raise HTTPException(status_code=500, detail="Failed to persist extracted paper") from exc

    stored_pdf_path = _to_project_relative(stored_pdf_abs)
    canonical_md_path = _to_project_relative(canonical_md_abs)
    images_dir = _to_project_relative(extracted.images_dir)
    try:
        metadata = await insert_session_uploaded_paper(
            pool=pool,
            session_id=session_id,
            paper_id=paper_id,
            original_filename=original_filename,
            stored_pdf_path=stored_pdf_path,
            canonical_md_path=canonical_md_path,
            images_dir=images_dir,
            page_count=extracted.page_count,
            image_count=extracted.image_count,
            status="completed",
        )
    except Exception as exc:
        stored_pdf_abs.unlink(missing_ok=True)
        canonical_md_abs.unlink(missing_ok=True)
        shutil.rmtree(extracted_root / paper_id, ignore_errors=True)
        await _release_upload_reservation()
        raise HTTPException(status_code=500, detail="Failed to persist uploaded paper metadata") from exc
    if metadata is None:
        stored_pdf_abs.unlink(missing_ok=True)
        canonical_md_abs.unlink(missing_ok=True)
        shutil.rmtree(extracted_root / paper_id, ignore_errors=True)
        await _release_upload_reservation()
        raise HTTPException(status_code=500, detail="Failed to persist uploaded paper metadata")

    try:
        linked = await upsert_session_paper_link(
            pool, session_id, paper_id, source_ref=f"uploaded://{paper_id}"
        )
        if not linked:
            raise RuntimeError("session paper link was not persisted")
    except Exception as exc:
        async with pool.acquire() as conn:
            await conn.execute(
                "DELETE FROM session_paper_links WHERE session_id = $1::uuid AND paper_id = $2",
                session_id,
                paper_id,
            )
            await conn.execute(
                "DELETE FROM session_uploaded_papers WHERE session_id = $1::uuid AND paper_id = $2",
                session_id,
                paper_id,
            )
        stored_pdf_abs.unlink(missing_ok=True)
        canonical_md_abs.unlink(missing_ok=True)
        shutil.rmtree(extracted_root / paper_id, ignore_errors=True)
        raise HTTPException(status_code=500, detail="Failed to persist uploaded paper link") from exc

    return {
        "paper_id": paper_id,
        "original_filename": original_filename,
        "stored_pdf_path": stored_pdf_path,
        "canonical_md_path": canonical_md_path,
        "images_dir": images_dir,
        "page_count": int(extracted.page_count),
        "image_count": int(extracted.image_count),
        "status": "completed",
    }


@app.get("/api/sessions/{session_id}/uploads/papers")
async def list_uploaded_papers(session_id: str, user: Principal = Depends(require_user)):
    try:
        uuid.UUID(session_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid session ID format")

    pool = app.state.db_pool
    if not pool:
        raise HTTPException(status_code=500, detail="Database not initialized")

    meta = await get_session(pool, session_id, user.user_id)
    if not meta:
        raise HTTPException(status_code=404, detail="Session not found")

    papers = await list_session_uploaded_papers(pool, session_id)
    return papers


@app.websocket("/ws/chat")
async def chat_ws_endpoint(websocket: WebSocket):
    """
    PaperAgent WebSocket 接口。
    客户端先发送一条 JSON 请求: {session_id, messages}
    服务端持续返回:
      - {"type":"status","phase":"thinking|tool_running|responding|retrying", ...}
      - {"type":"chunk","content":"..."}
      - {"type":"done","token_info":{"prompt":x,"response":y,"total":z}}
      - {"type":"error","message":"..."}
    """
    # WebSocket handshakes are not covered by the HTTP CSRF middleware. A
    # foreign web page can otherwise reuse the HttpOnly session cookie and
    # read the streamed chat response from its own socket. Native clients may
    # omit Origin; browser-originated handshakes must be allowlisted.
    if not _is_allowed_browser_origin(websocket.headers.get("origin")):
        await websocket.close(code=1008)
        return
    await websocket.accept()

    try:
        raw_request = await websocket.receive_json()
        request = ChatRequest(**raw_request)
        principal = await verify_websocket_token(websocket, request.access_token)
    except Exception:
        await websocket.send_json({
            "type": "error",
            "message": "Invalid payload or authentication token.",
        })
        await websocket.close(code=1003)
        return

    # Per-user rate limit for basic-tier users (default: 3 requests per 60s,
    # configurable via PAPER_CHAT_RATE_LIMIT / PAPER_CHAT_RATE_WINDOW).
    # Automatic retries of a failed generation are not re-counted.
    if request.retry_attempt <= 0:
        allowed, _remaining = await _check_user_rate_limit(principal.user_id, action="chat")
        if not allowed:
            limit, window = _rate_limit_settings()
            await websocket.send_json({
                "type": "error",
                "code": "rate_limited",
                "message": f"Rate limit exceeded: at most {limit} requests per {window}s. Please retry later.",
                "retry_after": window,
            })
            await websocket.close(code=1008)
            return

    session_id = request.session_id
    user_query = ""
    user_index = -1
    for i in range(len(request.messages) - 1, -1, -1):
        m = request.messages[i]
        if m.get("role") == "user":
            user_query = m.get("content", "")
            user_index = i
            break

    if not str(user_query).strip():
        await websocket.send_json({"type": "error", "message": "A user message is required"})
        await websocket.close(code=1003)
        return

    active_stop_event: Optional[threading.Event] = None
    active_response_stream: Any = None
    streamed_response_text = ""
    assistant_persisted = False

    try:
        pool = app.state.db_pool
        try:
            uuid.UUID(session_id)
        except ValueError:
            await websocket.send_json({"type": "error", "message": "Invalid session ID format"})
            return
        meta = await get_session(pool, session_id, principal.user_id)
        if not meta:
            await websocket.send_json({"type": "error", "message": "Session not found"})
            return
        app.state.session_meta[session_id] = meta
        should_insert_user_message = request.retry_attempt <= 0
        if should_insert_user_message:
            await insert_message(pool, session_id, "user", user_query)
        session_agent = await _get_or_create_session_agent(session_id)
        prompt, context_info = await _prepare_prompt_with_context_management(
            pool=pool,
            session_id=session_id,
            messages=request.messages,
            user_index=user_index,
            user_query=user_query,
        )
        prompt_tokens = int(context_info.get("estimated_prompt_tokens") or 0)
        emitted_tools: set[str] = set()
        persisted_tool_exec_keys: set[str] = set()

        response_text = ""
        did_auto_retry = False
        start_attempt = max(1, request.retry_attempt + 1)
        attempt = start_attempt
        while attempt <= MAX_STREAM_ATTEMPTS:
            response_stream = session_agent.run(prompt, stream=True, stream_events=True)
            queue, stop_event = _start_stream_worker(response_stream)
            active_response_stream = response_stream
            active_stop_event = stop_event
            attempt_start = asyncio.get_running_loop().time()
            last_status_push = -1.0
            has_chunk = False
            has_tool_call = False
            last_tool_name: Optional[str] = None
            attempt_response = ""
            should_retry_attempt = False

            while True:
                now = asyncio.get_running_loop().time()
                elapsed_ms = int((now - attempt_start) * 1000)
                if now - last_status_push >= 1.0:
                    phase = "responding" if has_chunk else ("tool_running" if has_tool_call else "thinking")
                    await _send_status_event(
                        websocket=websocket,
                        phase=phase,
                        elapsed_ms=elapsed_ms,
                        attempt=attempt,
                        max_attempts=MAX_STREAM_ATTEMPTS,
                        tool_name=last_tool_name if phase == "tool_running" else None,
                    )
                    last_status_push = now

                if (
                    ENABLE_FIRST_CHUNK_RETRY
                    and attempt < MAX_STREAM_ATTEMPTS
                    and not has_chunk
                    and not has_tool_call
                    and (now - attempt_start) >= FIRST_CHUNK_TIMEOUT_SECONDS
                ):
                    did_auto_retry = True
                    should_retry_attempt = True
                    await _send_status_event(
                        websocket=websocket,
                        phase="retrying",
                        elapsed_ms=elapsed_ms,
                        attempt=attempt + 1,
                        max_attempts=MAX_STREAM_ATTEMPTS,
                        reason="first_chunk_timeout",
                    )
                    _stop_stream_worker(active_stop_event, active_response_stream)
                    active_stop_event = None
                    active_response_stream = None
                    break

                try:
                    kind, payload = await asyncio.wait_for(queue.get(), timeout=1.0)
                except asyncio.TimeoutError:
                    continue

                if kind == "error":
                    raise payload
                if kind == "done":
                    active_stop_event = None
                    active_response_stream = None
                    break
                if kind != "item":
                    continue

                chunk = payload
                for tool_name in _extract_tool_names(chunk):
                    has_tool_call = True
                    last_tool_name = tool_name
                    if tool_name not in emitted_tools:
                        emitted_tools.add(tool_name)
                        await websocket.send_json({"type": "tool_call", "tool_name": tool_name})
                for tool_exec in _extract_completed_tool_executions(chunk):
                    exec_key = _tool_execution_identity_key(tool_exec)
                    if exec_key in persisted_tool_exec_keys:
                        continue
                    persisted_tool_exec_keys.add(exec_key)
                    result_text = str(tool_exec.get("result") or "")
                    retrieval_records = _extract_retrieval_records_from_tool_result(
                        tool_name=str(tool_exec.get("tool_name") or "unknown_tool"),
                        tool_result=result_text,
                    )
                    await insert_session_tool_call(
                        pool=pool,
                        session_id=session_id,
                        tool_call_id=tool_exec.get("tool_call_id"),
                        tool_name=str(tool_exec.get("tool_name") or "unknown_tool"),
                        tool_args=tool_exec.get("tool_args") if isinstance(tool_exec.get("tool_args"), dict) else {},
                        tool_result=_truncate_text(result_text, 50000),
                        tool_result_summary=_summarize_tool_result(result_text, max_chars=500),
                        retrieval_records=retrieval_records,
                    )
                    task_draft = await _persist_task_draft_tool_event(
                        pool=pool,
                        session_id=session_id,
                        user_id=principal.user_id,
                        tool_result=result_text,
                    )
                    if task_draft:
                        event_type = "task_draft_cancelled" if task_draft.get("status") == "cancelled" else (
                            "task_draft_updated" if int(task_draft.get("revision") or 1) > 1 else "task_draft_created"
                        )
                        if event_type == "task_draft_cancelled":
                            await websocket.send_json({"type": event_type, **task_draft})
                        else:
                            await websocket.send_json({"type": event_type, "draft": task_draft})
                content = _extract_chunk_content(chunk)
                if content:
                    has_chunk = True
                    attempt_response += content
                    streamed_response_text += content
                    await websocket.send_json({"type": "chunk", "content": content})

            if should_retry_attempt:
                attempt += 1
                continue

            response_text = attempt_response
            active_stop_event = None
            active_response_stream = None
            break

        if not response_text:
            message = "The model returned no response content."
            if did_auto_retry:
                message = "The model returned no response within 8 seconds. One retry also produced no usable output."
            await websocket.send_json({"type": "error", "message": message})
            return

        await insert_message(pool, session_id, "assistant", response_text)
        assistant_persisted = True

        response_tokens = estimate_tokens(response_text)
        total_tokens = prompt_tokens + response_tokens
        logging.info("Chat finished. prompt=%s response=%s total=%s", prompt_tokens, response_tokens, total_tokens)
        await websocket.send_json({
            "type": "done",
            "token_info": {
                "prompt": prompt_tokens,
                "response": response_tokens,
                "total": total_tokens,
            },
            "context_info": context_info,
        })

    except WebSocketDisconnect:
        logging.info("WebSocket client disconnected: %s", session_id)
        _stop_stream_worker(active_stop_event, active_response_stream)
        active_stop_event = None
        active_response_stream = None
        if streamed_response_text and not assistant_persisted:
            try:
                await insert_message(app.state.db_pool, session_id, "assistant", streamed_response_text)
                assistant_persisted = True
            except Exception:
                logging.exception("Failed to persist partial assistant response")
    except Exception as e:
        _stop_stream_worker(active_stop_event, active_response_stream)
        active_stop_event = None
        active_response_stream = None
        if streamed_response_text and not assistant_persisted:
            try:
                await insert_message(app.state.db_pool, session_id, "assistant", streamed_response_text)
                assistant_persisted = True
            except Exception:
                logging.exception("Failed to persist partial assistant response")
        logging.exception("Error in websocket chat endpoint")
        try:
            await websocket.send_json({
                "type": "error",
                "message": f"The literature search encountered an error: {str(e)}",
            })
        except Exception:
            pass
    finally:
        _stop_stream_worker(active_stop_event, active_response_stream)
        try:
            await websocket.close()
        except Exception:
            pass

@app.get("/api/sessions/{session_id}/messages")
async def get_session_history(session_id: str, user: Principal = Depends(require_user)):
    """
    获取指定会话的历史消息记录
    前端加载会话或切换会话时调用此接口
    """
    try:
        uuid.UUID(session_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid session ID format")

    pool = app.state.db_pool
    if not pool:
        raise HTTPException(status_code=500, detail="Database not initialized")

    try:
        if not await get_session(pool, session_id, user.user_id):
            raise HTTPException(status_code=404, detail="Session not found")
        messages = await get_session_messages(pool, session_id)
        if not messages:
            return []
            
        return messages

    except HTTPException:
        raise
    except Exception as e:
        logging.error(f"Error fetching history for {session_id}: {e}")
        raise HTTPException(status_code=500, detail="Failed to retrieve chat history")

if __name__ == "__main__":
    import uvicorn
    if not (os.getenv("ANALYSIS_PROVIDER_API_KEY") or os.getenv("STEPFUN_API_KEY")):
        print("Warning: no Analysis Provider key configured; local fallback mode is active.")
    uvicorn.run(app, host="0.0.0.0", port=8008)


# ============================================================================
# Task Execution System (Infinity Agent)
# ============================================================================

from pydantic import BaseModel, ConfigDict, Field
from sse_starlette.sse import EventSourceResponse


class HttpChatRequest(BaseModel):
    session_id: str
    messages: List[Dict[str, Any]]
    retry_attempt: int = 0
    client_request_id: Optional[str] = None


@app.post("/api/chat")
async def chat_http_endpoint(payload: HttpChatRequest, request: Request, user: Principal = Depends(require_user)):
    """Cookie-authenticated chat stream used by the browser client.

    The stream intentionally exposes the same event contract as the legacy
    WebSocket route.  The session lookup remains user-scoped, and only the
    single Analysis/Paper Agent model boundary is used underneath.
    """
    if payload.retry_attempt <= 0:
        allowed, _remaining = await _check_user_rate_limit(user.user_id, action="chat")
        if not allowed:
            limit, window = _rate_limit_settings()
            raise HTTPException(status_code=429, detail=f"Rate limit exceeded: at most {limit} requests per {window}s")
    try:
        uuid.UUID(payload.session_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Invalid session ID format") from exc
    user_index = max(
        (index for index, message in enumerate(payload.messages) if message.get("role") == "user"),
        default=-1,
    )
    user_query = str(payload.messages[user_index].get("content", "")) if user_index >= 0 else ""
    if not user_query.strip():
        raise HTTPException(status_code=400, detail="A user message is required")

    async def event_generator():
        pool = app.state.db_pool
        session_id = payload.session_id
        assistant_text = ""
        persisted_tool_exec_keys: set[str] = set()
        try:
            meta = await get_session(pool, session_id, user.user_id)
            if not meta:
                yield {"data": json.dumps({"type": "error", "message": "Session not found"})}
                return
            app.state.session_meta[session_id] = meta
            if payload.retry_attempt <= 0:
                await insert_message(pool, session_id, "user", user_query)
            session_agent = await _get_or_create_session_agent(session_id)
            prompt, context_info = await _prepare_prompt_with_context_management(
                pool=pool,
                session_id=session_id,
                messages=payload.messages,
                user_index=user_index,
                user_query=user_query,
            )
            yield {"data": json.dumps({"type": "status", "phase": "thinking", "elapsed_ms": 0, "attempt": 1, "max_attempts": MAX_STREAM_ATTEMPTS})}
            response_stream = session_agent.run(prompt, stream=True, stream_events=True)
            queue, stop_event = _start_stream_worker(response_stream)
            started = asyncio.get_running_loop().time()
            last_status = started
            while True:
                now = asyncio.get_running_loop().time()
                if now - last_status >= 1.0:
                    phase = "responding" if assistant_text else "thinking"
                    yield {"data": json.dumps({"type": "status", "phase": phase, "elapsed_ms": int((now - started) * 1000), "attempt": 1, "max_attempts": MAX_STREAM_ATTEMPTS})}
                    last_status = now
                try:
                    kind, item = await asyncio.wait_for(queue.get(), timeout=1.0)
                except asyncio.TimeoutError:
                    if await request.is_disconnected():
                        _stop_stream_worker(stop_event, response_stream)
                        return
                    continue
                if kind == "error":
                    raise item
                if kind == "done":
                    break
                if kind != "item":
                    continue
                for tool_name in _extract_tool_names(item):
                    yield {"data": json.dumps({"type": "tool_call", "tool_name": tool_name})}
                for tool_exec in _extract_completed_tool_executions(item):
                    exec_key = _tool_execution_identity_key(tool_exec)
                    if exec_key in persisted_tool_exec_keys:
                        continue
                    persisted_tool_exec_keys.add(exec_key)
                    task_draft = await _persist_task_draft_tool_event(
                        pool=pool,
                        session_id=session_id,
                        user_id=user.user_id,
                        tool_result=str(tool_exec.get("result") or ""),
                    )
                    if task_draft:
                        event_type = "task_draft_cancelled" if task_draft.get("status") == "cancelled" else (
                            "task_draft_updated" if int(task_draft.get("revision") or 1) > 1 else "task_draft_created"
                        )
                        event = {"type": event_type, **task_draft} if event_type == "task_draft_cancelled" else {"type": event_type, "draft": task_draft}
                        yield {"data": json.dumps(event, ensure_ascii=False)}
                content = _extract_chunk_content(item)
                if content:
                    assistant_text += content
                    yield {"data": json.dumps({"type": "chunk", "content": content})}
            if not assistant_text:
                yield {"data": json.dumps({"type": "error", "message": "The model returned no response content."})}
                return
            await insert_message(pool, session_id, "assistant", assistant_text)
            response_tokens = estimate_tokens(assistant_text)
            yield {"data": json.dumps({"type": "done", "token_info": {"prompt": int(context_info.get("estimated_prompt_tokens") or 0), "response": response_tokens, "total": int(context_info.get("estimated_prompt_tokens") or 0) + response_tokens}, "context_info": context_info})}
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("HTTP chat stream failed")
            if assistant_text:
                try:
                    await insert_message(pool, session_id, "assistant", assistant_text)
                except Exception:
                    logger.exception("Failed to persist partial HTTP chat response")
            yield {"data": json.dumps({"type": "error", "message": "The literature search encountered an error."})}

    return EventSourceResponse(event_generator())

from backend.code_agent.task_service import (
    check_idempotency,
    create_task_spec,
    create_dataset_snapshot,
    freeze_task_spec,
    get_task_spec,
    create_task,
    submit_task_atomically,
    get_task,
    get_tasks_by_project,
    update_task_status,
    get_task_events,
    create_outbox_event,
    get_artifacts_for_task,
    get_artifact,
    request_cancel_task,
    ensure_default_project,
    user_can_access_project,
    create_method_source,
    TaskStatus,
    TaskSpec,
    DatasetSnapshot,
    MethodSource,
    Task,
)
from backend.code_agent.redis_client import RedisClient


# ---- Pydantic models ----

class CreateTaskSpecRequest(BaseModel):
    project_id: str
    title: str
    # The execution document is free-form (HTML/PDF), so structured spec
    # fields are optional and default to a generic analysis task.
    analysis_type: str = "generic"
    research_question: str = ""
    spec_json: Dict[str, Any] = Field(default_factory=dict)


class CreateDatasetRequest(BaseModel):
    project_id: str
    task_spec_id: str
    original_filename: str
    resource_id: Optional[str] = None
    # Kept only for the unauthenticated development compatibility path. An
    # authenticated request must submit an opaque Resource ID instead.
    stored_path: Optional[str] = None
    file_hash_sha256: Optional[str] = None
    # Client input is advisory only; the API recomputes deterministic checks.
    validation_passed: bool = False


class CreateTaskRequest(BaseModel):
    project_id: str
    task_spec_id: str
    dataset_snapshot_id: str
    title: str
    method_source_id: Optional[str] = None
    idempotency_key: Optional[str] = None
    max_attempts: int = Field(default=3, ge=1, le=10)
    confirmation_id: Optional[str] = None


class SubmitTaskBundleResponse(BaseModel):
    task_id: str
    status: str
    attempt_count: int
    duplicate: bool = False
    event_type: str = "task_confirmed"


class TaskDraftConfirmRequest(BaseModel):
    idempotency_key: str = Field(min_length=1, max_length=255)
    dataset_resource_id: Optional[str] = None
    method_content: Optional[str] = None
    title: Optional[str] = None


class DatasetUploadResponse(BaseModel):
    resource_id: str
    project_id: str
    logical_name: str
    file_hash_sha256: str
    file_size_bytes: int


class TaskResponse(BaseModel):
    task_id: str
    task_spec_id: str
    dataset_snapshot_id: str
    project_id: str
    title: str
    status: str
    attempt_count: int
    max_attempts: int
    created_at: Optional[str] = None


class TaskEventResponse(BaseModel):
    task_event_id: int
    event_type: str
    event_data: Dict[str, Any]
    created_at: Optional[str] = None


class ArtifactResponse(BaseModel):
    artifact_id: str
    name: str
    kind: str
    file_size_bytes: Optional[int] = None
    checksum_sha256: Optional[str] = None
    created_at: Optional[str] = None


class ProviderProfileRequest(BaseModel):
    project_id: str
    purpose: str
    protocol: str
    base_url: str
    model_id: str
    credential: Optional[str] = None


class ProviderProfileResponse(BaseModel):
    provider_profile_id: str
    project_id: str
    purpose: str
    protocol: str
    base_url: str
    model_id: str
    status: str
    credential_configured: bool
    probe_revision: Optional[str] = None
    created_at: Optional[str] = None


class WorkerEnrollmentRequest(BaseModel):
    """Create one Worker in the server-owned public pool.

    Namespace and Worker ID are intentionally absent.  Pydantic rejects
    attempts to smuggle them (or pool/provider/trust fields) into the request;
    the control plane generates both values from its deployment configuration.
    """

    model_config = ConfigDict(extra="forbid")


# ---- Redis client singleton ----

_redis_client: Optional[RedisClient] = None


def get_redis_client() -> Optional[RedisClient]:
    global _redis_client
    state_client = getattr(app.state, "redis_client", None)
    if state_client is not None:
        return state_client
    if _redis_client is None:
        redis_url = os.getenv("REDIS_URL", "redis://localhost:6379/0")
        _redis_client = RedisClient(redis_url)
    return _redis_client


def _worker_database_pool():
    """Return the dedicated Worker gateway pool when the deployment provides it."""
    gateway_pool = getattr(app.state, "worker_gateway_pool", None)
    if gateway_pool is not None:
        return gateway_pool
    if os.getenv("APP_ENV", "development").lower() in {"acceptance", "production", "prod"}:
        raise RuntimeError("Dedicated Worker gateway database pool is not configured")
    return app.state.db_pool


def _worker_enrollment_admin_allowed(user: Principal) -> bool:
    """Allow worker enrollment only to local operators or explicit admins."""
    if user.is_superuser:
        return True
    environment = os.getenv("APP_ENV", "development").lower()
    # Acceptance is a deployed-like environment. It must use the explicit
    # operator allowlist just like production; otherwise any signed-in user
    # could mint a Worker credential.
    if environment in {"development", "test"}:
        return True
    configured = {
        value.strip()
        for value in os.getenv("WORKER_ENROLLMENT_ADMIN_USER_IDS", "").split(",")
        if value.strip()
    }
    return user.user_id in configured


def _worker_enrollment_issue_allowed(user: Principal) -> bool:
    """Every signed-in user may issue a general Worker for their own account.

    Trust is still derived below: only a server-recognized superuser can
    receive full trust.  Keeping issuance separate from the operator-only
    revoke/health/outbox guard lets students run their own local Worker
    without giving them administrative control over another account.
    """
    return bool(user.user_id.strip())


def _public_worker_namespace() -> str:
    """Return the only Namespace served by this control plane."""
    namespace = (
        os.getenv("WORKER_PUBLIC_NAMESPACE", "").strip()
        or os.getenv("REDIS_NAMESPACE", "").strip().strip(":")
    )
    if not namespace:
        raise HTTPException(status_code=503, detail="Public Worker Namespace is not configured")
    return namespace


@app.post("/api/worker-enrollments")
async def issue_worker_enrollment_endpoint(
    request: WorkerEnrollmentRequest,
    user: Principal = Depends(require_user),
):
    """Issue a persistent credential in the server-owned public Worker pool."""
    if not _worker_enrollment_issue_allowed(user):
        raise HTTPException(status_code=403, detail="A signed-in account is required to issue a Worker")
    from backend.worker_enrollment import issue_worker_credential

    try:
        namespace = _public_worker_namespace()
        worker_id = f"public-worker-{uuid.uuid4()}"
        credential = await issue_worker_credential(
            app.state.db_pool,
            worker_id,
            namespace,
            # Issuance is public-cluster scoped.  The authenticated user is
            # the audit actor, not a Namespace or task-visibility boundary.
            owner_user_id=None,
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Worker enrollment request is invalid") from exc
    return {
        "worker_id": credential.worker_id,
        "namespace": credential.namespace,
        "credential": credential.credential,
        "persistent": True,
        "one_time": False,
    }


@app.post("/api/worker-enrollments/{worker_id}/revoke")
async def revoke_worker_enrollment_endpoint(
    worker_id: str,
    namespace: str,
    user: Principal = Depends(require_user),
):
    if not _worker_enrollment_admin_allowed(user):
        raise HTTPException(status_code=403, detail="Worker enrollment requires operator permission")
    from backend.worker_enrollment import revoke_worker

    revoked = await revoke_worker(
        app.state.db_pool,
        worker_id,
        namespace,
        operator_pool=getattr(app.state, "trust_issuer_pool", None),
    )
    if not revoked:
        raise HTTPException(status_code=404, detail="Active Worker enrollment not found")
    return {"worker_id": worker_id, "namespace": namespace, "status": "revoked"}


async def _authenticate_worker_request(request: Request) -> Dict[str, str]:
    """Authenticate a machine request without accepting browser sessions."""
    worker_id = request.headers.get("X-Worker-ID", "").strip()
    namespace = request.headers.get("X-Worker-Namespace", "").strip()
    credential = request.headers.get("X-Worker-Credential", "")
    if not worker_id or not namespace or not credential:
        raise HTTPException(status_code=401, detail="Worker credentials are required")
    # The database RLS context binds the claimed Worker ID to the same
    # persistent credential that authenticated this request.  An ID alone is
    # forgeable by a process that has a shared database connection string.
    set_rls_worker(worker_id, credential, namespace)
    try:
        from backend.worker_enrollment import authenticate_worker_identity
        identity = await authenticate_worker_identity(_worker_database_pool(), worker_id, namespace, credential)
    except Exception as exc:
        raise HTTPException(status_code=401, detail="Worker credentials are invalid") from exc
    if identity is None:
        raise HTTPException(status_code=401, detail="Worker credentials are invalid or revoked")
    configured_namespace = os.getenv("REDIS_NAMESPACE", "").strip().strip(":")
    if not configured_namespace:
        raise HTTPException(status_code=503, detail="Worker Namespace is not configured")
    if identity.namespace != configured_namespace:
        raise HTTPException(status_code=401, detail="Worker Namespace is not served by this control plane")
    lease_token = request.headers.get("X-Worker-Lease-Token", "").strip()
    if not lease_token:
        raise HTTPException(status_code=401, detail="Worker lease token is required")
    return {
        "worker_id": identity.worker_id,
        "namespace": identity.namespace,
        "lease_token": lease_token,
        "owner_user_id": identity.owner_user_id or "",
    }


def _task_coding_provider_profile_id(spec_json: Any) -> Optional[str]:
    """Read the server-owned Coding profile reference from a frozen spec."""
    if not isinstance(spec_json, dict):
        return None
    candidates = [
        spec_json.get("coding_provider_profile_id"),
        spec_json.get("provider_profile_id"),
    ]
    execution = spec_json.get("execution")
    if isinstance(execution, dict):
        candidates.append(execution.get("coding_provider_profile_id"))
    for candidate in candidates:
        value = str(candidate or "").strip()
        if re.fullmatch(r"[0-9a-fA-F-]{36}", value):
            return value
    configured = os.getenv("DEFAULT_CODING_PROVIDER_PROFILE_ID", "").strip()
    return configured if re.fullmatch(r"[0-9a-fA-F-]{36}", configured) else None


def _env_coding_provider() -> Optional[Dict[str, str]]:
    """Return an explicitly configured server-side fallback provider."""
    base_url = (
        os.getenv("CODING_PROVIDER_BASE_URL", "").strip()
        or os.getenv("ANTHROPIC_BASE_URL", "").strip()
    )
    model_id = (
        os.getenv("CODING_MODEL_ID", "").strip()
        or os.getenv("ANTHROPIC_MODEL", "").strip()
    )
    credential = (
        os.getenv("CODING_PROVIDER_API_KEY", "").strip()
        or os.getenv("ANTHROPIC_API_KEY", "").strip()
        or os.getenv("ANTHROPIC_AUTH_TOKEN", "").strip()
    )
    if not (base_url and model_id and credential):
        return None
    return {"base_url": base_url, "model_id": model_id, "credential": credential}


async def _load_coding_provider_for_task(task: Dict[str, Any]) -> Dict[str, str]:
    """Load a Coding provider only in the trusted API process."""
    profile_id = _task_coding_provider_profile_id(task.get("spec_json"))
    if profile_id:
        owner_user_id = str(task.get("created_by") or "").strip()
        if not owner_user_id:
            raise HTTPException(status_code=503, detail="Task owner is unavailable")
        # Provider secrets are read under the task owner's authenticated RLS
        # context. The Worker receives only the signed Attempt capability.
        with rls_user_context(owner_user_id):
            async with app.state.db_pool.acquire() as conn:
                row = await conn.fetchrow(
                    """
                    SELECT p.base_url, p.model_id, s.ciphertext
                    FROM provider_profiles p
                    JOIN provider_secrets s ON s.credential_ref = p.credential_ref
                    WHERE p.provider_profile_id = $1::uuid
                      AND p.project_id = $2::uuid
                      AND p.owner_user_id = $3
                      AND p.purpose = 'coding'
                      AND p.status = 'ready'
                      AND p.revoked_at IS NULL
                      AND s.owner_user_id = p.owner_user_id
                      AND s.project_id = p.project_id
                      AND s.revoked_at IS NULL
                    """,
                    profile_id,
                    task["project_id"],
                    owner_user_id,
                )
        if not row:
            raise HTTPException(status_code=503, detail="Coding provider profile is not ready")
        try:
            credential = decrypt_secret(
                row["ciphertext"],
                aad=f"provider:{profile_id}:{task['project_id']}",
            )
        except Exception as exc:
            raise HTTPException(status_code=503, detail="Coding provider credential is unavailable") from exc
        return {
            "base_url": str(row["base_url"]),
            "model_id": str(row["model_id"]),
            "credential": credential,
            "profile_id": profile_id,
        }
    fallback = _env_coding_provider()
    if not fallback:
        raise HTTPException(status_code=503, detail="No ready Coding provider is configured")
    fallback["profile_id"] = ""
    return fallback


@app.post("/api/worker/tasks/{task_id}/attempts/{attempt_id}/gateway")
async def issue_attempt_gateway_endpoint(
    task_id: str,
    attempt_id: int,
    request: Request,
):
    """Issue a short-lived model capability for one active Worker Attempt."""
    worker = await _authenticate_worker_request(request)
    if attempt_id <= 0:
        raise HTTPException(status_code=400, detail="Invalid attempt ID")
    query = """
        SELECT t.task_id, t.project_id, t.created_by, t.active_attempt_id,
               t.status, t.lease_token, t.lease_expires_at, ts.spec_json
        FROM tasks t
        JOIN task_specs ts ON ts.task_spec_id = t.task_spec_id
        JOIN task_attempts a ON a.task_attempt_id = $4
        WHERE t.task_id = $1::uuid
          AND t.lease_owner = $2
          AND t.lease_token = $3
          AND t.active_attempt_id = $4
          AND t.status IN ('claimed', 'running')
          AND t.lease_expires_at > NOW()
          AND a.task_id = t.task_id
          AND a.worker_id = $2
          AND a.status = 'running'
    """
    async with _worker_database_pool().acquire() as conn:
        row = await conn.fetchrow(
            query,
            task_id,
            worker["worker_id"],
            worker["lease_token"],
            attempt_id,
        )
    if not row:
        raise HTTPException(status_code=404, detail="Active Worker Attempt not found")
    task = dict(row)
    provider = await _load_coding_provider_for_task(task)
    from backend.code_agent.model_gateway import mint_gateway_capability
    grant_id = uuid.uuid4().hex
    gateway_token, expires_at = mint_gateway_capability(
        grant_id=grant_id,
        task_id=str(task["task_id"]),
        attempt_id=attempt_id,
        owner_user_id=str(task["created_by"] or ""),
        provider_profile_id=provider.get("profile_id") or None,
        ttl_seconds=_env_int("MODEL_GATEWAY_ATTEMPT_TTL_SECONDS", 900),
    )
    return {
        "gateway_url": f"{_external_base_url(request)}/api/worker/attempt-gateway/{grant_id}",
        "gateway_token": gateway_token,
        "model_id": provider["model_id"],
        "expires_at": expires_at,
    }


def _provider_gateway_path(base_url: str, provider_path: str) -> str:
    """Join Claude's fixed Messages paths to the configured provider base URL."""
    normalized = provider_path.strip("/")
    if normalized.startswith("v1/"):
        normalized = normalized[3:]
    if normalized not in {"messages", "messages/count_tokens"}:
        raise HTTPException(status_code=404, detail="Gateway path is not allowed")
    base = base_url.rstrip("/")
    prefix = "" if base.endswith("/v1") else "/v1"
    return f"{base}{prefix}/{normalized}"


@app.api_route("/api/worker/attempt-gateway/{grant_id}/{provider_path:path}", methods=["POST"])
async def attempt_gateway_proxy_endpoint(
    grant_id: str,
    provider_path: str,
    request: Request,
):
    """Proxy only Anthropic Messages calls while the signed Attempt is live."""
    authorization = request.headers.get("authorization", "").strip()
    token = authorization[7:].strip() if authorization.lower().startswith("bearer ") else ""
    token = token or request.headers.get("x-api-key", "").strip()
    if not token:
        raise HTTPException(status_code=401, detail="Attempt gateway token is required")
    from backend.code_agent.model_gateway import verify_gateway_capability
    try:
        capability = verify_gateway_capability(token, grant_id=grant_id)
    except ValueError as exc:
        raise HTTPException(status_code=401, detail="Attempt gateway token is invalid or expired") from exc

    task_id = str(capability["task_id"])
    attempt_id = int(capability["attempt_id"])
    owner_user_id = str(capability["owner_user_id"])
    profile_id = str(capability.get("provider_profile_id") or "")
    body = await request.body()
    if len(body) > _env_int("MODEL_GATEWAY_MAX_REQUEST_BYTES", 25 * 1024 * 1024):
        raise HTTPException(status_code=413, detail="Model request is too large")

    provider: Optional[Dict[str, str]] = None
    task_row = None
    with rls_user_context(owner_user_id):
        async with app.state.db_pool.acquire() as conn:
            task_row = await conn.fetchrow(
                """
                SELECT t.task_id, t.project_id, t.created_by, t.active_attempt_id,
                       t.status, t.lease_expires_at
                FROM tasks t
                WHERE t.task_id = $1::uuid
                  AND t.created_by = $2
                  AND t.active_attempt_id = $3
                  AND t.status IN ('claimed', 'running')
                  AND t.lease_expires_at > NOW()
                  AND EXISTS (
                      SELECT 1
                      FROM task_attempts a
                      WHERE a.task_attempt_id = t.active_attempt_id
                        AND a.task_id = t.task_id
                        AND a.status = 'running'
                  )
                """,
                task_id,
                owner_user_id,
                attempt_id,
            )
            if task_row:
                if profile_id:
                    provider_row = await conn.fetchrow(
                        """
                        SELECT p.base_url, p.model_id, s.ciphertext
                        FROM provider_profiles p
                        JOIN provider_secrets s ON s.credential_ref = p.credential_ref
                        WHERE p.provider_profile_id = $1::uuid
                          AND p.project_id = $2::uuid
                          AND p.owner_user_id = $3
                          AND p.purpose = 'coding'
                          AND p.status = 'ready'
                          AND p.revoked_at IS NULL
                          AND s.owner_user_id = p.owner_user_id
                          AND s.project_id = p.project_id
                          AND s.revoked_at IS NULL
                        """,
                        profile_id,
                        task_row["project_id"],
                        owner_user_id,
                    )
                    if provider_row:
                        try:
                            provider = {
                                "base_url": str(provider_row["base_url"]),
                                "model_id": str(provider_row["model_id"]),
                                "credential": decrypt_secret(
                                    provider_row["ciphertext"],
                                    aad=f"provider:{profile_id}:{task_row['project_id']}",
                                ),
                            }
                        except Exception:
                            provider = None
                else:
                    provider = _env_coding_provider()
    if not task_row or not provider:
        raise HTTPException(status_code=401, detail="Attempt gateway capability is no longer active")
    try:
        allowed_local_hosts = {"localhost", "127.0.0.1", "::1", "host.docker.internal"}
        base_url = validate_outbound_url(
            provider["base_url"].rstrip("/"),
            allow_http_local=os.getenv("APP_ENV", "development").lower() in {"development", "dev", "test", "acceptance"},
            allow_hosts=allowed_local_hosts if os.getenv("APP_ENV", "development").lower() in {"development", "dev", "test", "acceptance"} else None,
        )
        target_url = _provider_gateway_path(base_url, provider_path)
    except Exception as exc:
        raise HTTPException(status_code=502, detail="Coding provider endpoint is not allowed") from exc

    import httpx
    upstream_headers = {
        "content-type": request.headers.get("content-type", "application/json"),
        "anthropic-version": request.headers.get("anthropic-version", "2023-06-01"),
    }
    if request.headers.get("anthropic-beta"):
        upstream_headers["anthropic-beta"] = request.headers["anthropic-beta"]
    upstream_headers["x-api-key"] = provider["credential"]
    client = httpx.AsyncClient(
        timeout=max(30.0, min(_env_float("MODEL_GATEWAY_TIMEOUT_SECONDS", 600.0), 3600.0)),
        follow_redirects=False,
    )
    try:
        upstream_request = client.build_request("POST", target_url, headers=upstream_headers, content=body)
        upstream = await client.send(upstream_request, stream=True)
    except Exception as exc:
        await client.aclose()
        raise HTTPException(status_code=502, detail="Coding provider request failed") from exc

    response_headers = {}
    for name in ("content-type", "cache-control", "retry-after"):
        if upstream.headers.get(name):
            response_headers[name] = upstream.headers[name]

    async def stream_provider_response():
        try:
            async for chunk in upstream.aiter_bytes():
                yield chunk
        finally:
            await upstream.aclose()
            await client.aclose()

    return StreamingResponse(
        stream_provider_response(),
        status_code=upstream.status_code,
        headers=response_headers,
    )


async def _worker_task_input(task_id: str, worker: Dict[str, str], kind: str) -> Dict[str, Any]:
    """Return one input row only while the authenticated Worker owns the lease."""
    if kind not in {"dataset", "method"}:
        raise HTTPException(status_code=404, detail="Worker input not found")
    query = """
        SELECT t.lease_owner, t.lease_token, t.status, t.required_trust_level,
               ds.stored_path AS dataset_path, ds.original_filename AS dataset_name,
               ms.stored_path AS method_path, ms.original_filename AS method_name
        FROM tasks t
        JOIN dataset_snapshots ds ON ds.dataset_snapshot_id = t.dataset_snapshot_id
        LEFT JOIN method_sources ms ON ms.method_source_id = t.method_source_id
        WHERE t.task_id = $1::uuid
          AND t.lease_owner = $2
          AND t.lease_token = $3
          AND t.status IN ('claimed', 'running')
          AND t.lease_expires_at > NOW()
          AND EXISTS (
              SELECT 1
              FROM worker_enrollments w
              WHERE w.worker_id = $2
                AND w.namespace = $4
                AND w.status = 'active'
                AND w.revoked_at IS NULL
                AND (t.required_trust_level = 'general' OR w.trust_level = 'full')
          )
    """
    async with _worker_database_pool().acquire() as conn:
        row = await conn.fetchrow(
            query,
            task_id,
            worker["worker_id"],
            worker["lease_token"],
            worker["namespace"],
        )
    if not row:
        raise HTTPException(status_code=404, detail="Worker input not found")
    raw_path = row["dataset_path"] if kind == "dataset" else row["method_path"]
    logical_name = row["dataset_name"] if kind == "dataset" else row["method_name"]
    if not raw_path or not logical_name:
        raise HTTPException(status_code=404, detail="Worker input not found")
    path = FilePath(str(raw_path)).resolve()
    allowed_roots = [
        FilePath(os.getenv("RESOURCE_STORAGE_ROOT", "/workspace/resources")).resolve(),
        FilePath(os.getenv("METHOD_SOURCE_UPLOAD_ROOT", "/tmp/uploaded-method-sources")).resolve(),
    ]
    if not any(path.is_relative_to(root) for root in allowed_roots) or path.is_symlink() or not path.is_file():
        raise HTTPException(status_code=404, detail="Worker input not found")
    return {"path": path, "logical_name": FilePath(str(logical_name)).name}


async def _worker_artifact_upload_allowed(
    task_id: str,
    worker: Dict[str, str],
    attempt_id: int,
) -> bool:
    """Perform the lease/trust check before accepting any upload bytes.

    The final artifact INSERT repeats this check for race safety.  This
    preflight prevents a valid Worker credential from filling staging storage
    with arbitrary task IDs or expired lease tokens before that final check.
    """
    query = """
        SELECT 1
        FROM tasks t
        JOIN worker_enrollments w
          ON w.worker_id = $2
         AND w.namespace = $3
         AND w.status = 'active'
         AND w.revoked_at IS NULL
        WHERE t.task_id = $1::uuid
          AND t.lease_owner = $2
          AND t.lease_token = $4
          AND t.active_attempt_id = $5
          AND t.status IN ('claimed', 'running')
          AND t.lease_expires_at > NOW()
          AND (t.required_trust_level = 'general' OR w.trust_level = 'full')
    """
    async with _worker_database_pool().acquire() as conn:
        return await conn.fetchrow(
            query,
            task_id,
            worker["worker_id"],
            worker["namespace"],
            worker["lease_token"],
            attempt_id,
        ) is not None


@app.get("/api/worker/tasks/{task_id}/inputs/{kind}")
async def download_worker_input_endpoint(task_id: str, kind: str, request: Request):
    """Transfer a task input to a remote Worker over its persistent credential."""
    worker = await _authenticate_worker_request(request)
    input_row = await _worker_task_input(task_id, worker, kind)
    return FileResponse(str(input_row["path"]), filename=input_row["logical_name"], media_type="application/octet-stream")


@app.post("/api/worker/tasks/{task_id}/artifacts")
async def upload_worker_artifact_endpoint(
    task_id: str,
    request: Request,
):
    """Receive a raw result archive after validating the remote Worker's lease.

    Metadata is carried in headers instead of multipart fields.  That is
    intentional: Starlette otherwise parses/spools the multipart body before
    this handler can authenticate the Worker and reject an expired lease.
    """
    worker = await _authenticate_worker_request(request)
    attempt_raw = request.headers.get("X-Worker-Attempt-ID", "").strip()
    artifact_id = request.headers.get("X-Worker-Artifact-ID", "").strip()
    try:
        attempt_id = int(attempt_raw)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Invalid attempt ID") from exc
    if attempt_id <= 0:
        raise HTTPException(status_code=400, detail="Invalid attempt ID")
    if not re.fullmatch(r"artifact-[0-9a-f-]{20,}", artifact_id):
        raise HTTPException(status_code=400, detail="Invalid artifact ID")
    if not await _worker_artifact_upload_allowed(task_id, worker, attempt_id):
        raise HTTPException(status_code=409, detail="Worker lease is no longer active")
    upload_root = FilePath(os.getenv("ARTIFACT_DOWNLOAD_ROOT", "/workspace/task-outputs")).resolve()
    staging_root = upload_root / ".worker-staging"
    max_bytes = int(os.getenv("ARTIFACT_UPLOAD_MAX_BYTES", str(3 * 1024**3)))
    upload = await _stream_request_body_to_disk(request, staging_root, max_bytes, filename="result.zip")
    source = FilePath(upload["stored_path"])
    destination = upload_root / "remote" / task_id / f"{artifact_id}.zip"
    moved = False
    try:
        destination.parent.mkdir(parents=True, exist_ok=True)
        if destination.exists():
            raise HTTPException(status_code=409, detail="Artifact already exists")
        source.replace(destination)
        moved = True
        from backend.code_agent.models import Artifact
        from backend.code_agent.task_service import create_artifact_if_current_lease
        artifact = await create_artifact_if_current_lease(
            _worker_database_pool(),
            Artifact(
                artifact_id=artifact_id,
                task_id=task_id,
                task_attempt_id=attempt_id,
                name="result",
                kind="result_archive",
                storage_backend="local",
                storage_path=str(destination),
                file_size_bytes=upload["file_size_bytes"],
                checksum_sha256=upload["file_hash_sha256"],
                content_type="application/zip",
                metadata={"remote_worker_id": worker["worker_id"]},
            ),
            worker["lease_token"],
            worker_id=worker["worker_id"],
        )
        if artifact is None:
            raise HTTPException(status_code=409, detail="Worker lease is no longer active")
    except HTTPException:
        source.unlink(missing_ok=True)
        if moved:
            destination.unlink(missing_ok=True)
        raise
    except Exception as exc:
        source.unlink(missing_ok=True)
        if moved:
            destination.unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail="Artifact upload failed") from exc
    return {"artifact_id": artifact_id, "file_size_bytes": upload["file_size_bytes"], "checksum_sha256": upload["file_hash_sha256"]}


@app.delete("/api/worker/tasks/{task_id}/artifacts/{artifact_id}")
async def delete_worker_artifact_endpoint(task_id: str, artifact_id: str, request: Request):
    """Compensate a remote artifact upload when attempt completion fails."""
    worker = await _authenticate_worker_request(request)
    try:
        attempt_id = int(request.headers.get("X-Worker-Attempt-ID", ""))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Invalid attempt ID") from exc
    if attempt_id <= 0 or not re.fullmatch(r"artifact-[0-9a-f-]{20,}", artifact_id):
        raise HTTPException(status_code=400, detail="Invalid artifact identity")
    if not await _worker_artifact_upload_allowed(task_id, worker, attempt_id):
        raise HTTPException(status_code=409, detail="Worker lease is no longer active")
    from backend.code_agent.task_service import delete_artifact_if_current_lease
    deleted = await delete_artifact_if_current_lease(
        _worker_database_pool(), artifact_id, task_id, attempt_id,
        worker["lease_token"], worker_id=worker["worker_id"],
    )
    if not deleted:
        raise HTTPException(status_code=404, detail="Artifact not found")
    storage_path = FilePath(str(deleted.get("storage_path") or ""))
    root = FilePath(os.getenv("ARTIFACT_DOWNLOAD_ROOT", "/workspace/task-outputs")).resolve()
    try:
        resolved = storage_path.resolve(strict=False)
        if resolved.is_relative_to(root) and not storage_path.is_symlink():
            resolved.unlink(missing_ok=True)
    except (OSError, ValueError):
        logger.warning("Could not remove compensated artifact file %s", storage_path)
    return {"artifact_id": artifact_id, "deleted": True}


# ---- Task API endpoints ----

# Upload limits (design doc §40): streamed to disk, never held in memory.
TASK_INPUT_MAX_BYTES = 25 * 1024 * 1024
MAX_DATASET_UPLOAD_BYTES = min(
    int(os.getenv("DATASET_UPLOAD_MAX_BYTES", str(TASK_INPUT_MAX_BYTES))),
    TASK_INPUT_MAX_BYTES,
)
MAX_METHOD_SOURCE_BYTES = min(
    int(os.getenv("METHOD_SOURCE_MAX_BYTES", str(TASK_INPUT_MAX_BYTES))),
    TASK_INPUT_MAX_BYTES,
)
MAX_DATASET_VALIDATION_SAMPLE_BYTES = int(os.getenv("DATASET_VALIDATION_SAMPLE_BYTES", str(2 * 1024**2)))
MAX_DATASET_ZIP_ENTRIES = int(os.getenv("DATASET_ZIP_MAX_ENTRIES", "10000"))
MAX_DATASET_ZIP_FILE_BYTES = int(os.getenv("DATASET_ZIP_MAX_FILE_BYTES", str(5 * 1024**3)))
MAX_DATASET_ZIP_UNCOMPRESSED_BYTES = int(os.getenv("DATASET_ZIP_MAX_UNCOMPRESSED_BYTES", str(10 * 1024**3)))
MAX_DATASET_ZIP_COMPRESSION_RATIO = float(os.getenv("DATASET_ZIP_MAX_COMPRESSION_RATIO", "200"))

_METHOD_SOURCE_EXTENSIONS = {".html", ".htm", ".pdf", ".md", ".txt", ".doc", ".docx"}


async def _require_task_api_key(request: Request) -> Optional[Principal]:
    """Resolve the authenticated Task principal.

    Acceptance/production always use the same HttpOnly session or verified
    bearer token as the rest of the application.  The legacy shared token is
    available only behind an explicit development flag so a missing token can
    never silently open a deployed Task API.
    """
    # The Task/Worker surface is fail-closed by default. Opening it is only a
    # deliberate local-development choice and is never inferred from APP_ENV.
    local_open = (
        os.getenv("APP_ENV", "development").lower() in {"development", "test"}
        and _env_flag("LOCAL_DEV_OPEN_TASK_API", False)
    )
    auth_required = _env_flag("AUTH_REQUIRED_TASK_API", not local_open)
    if not auth_required and not local_open:
        raise HTTPException(status_code=503, detail="Task API authentication is required in this environment")
    if auth_required:
        principal = await require_user(request)
        request.state.task_principal = principal
        return principal
    if _env_flag("ALLOW_LEGACY_TASK_API_TOKEN", False):
        import hmac
        expected = os.getenv("TASK_API_TOKEN", "").strip()
        if not expected:
            raise HTTPException(status_code=503, detail="Legacy Task API token is not configured")
        provided = request.headers.get("X-API-Key", "")
        if not hmac.compare_digest(provided, expected):
            raise HTTPException(status_code=401, detail="Invalid or missing X-API-Key")
    return None


def _rate_limit_settings() -> tuple[int, int]:
    """(limit, window_seconds) for per-user paperAgent request throttling."""
    limit = int(os.getenv("PAPER_CHAT_RATE_LIMIT", "3"))
    window = int(os.getenv("PAPER_CHAT_RATE_WINDOW", "60"))
    return limit, window


async def _check_user_rate_limit(user_id: str, action: str) -> tuple[bool, int]:
    """Fixed-window per-user rate limit with a fail-closed deployed default."""
    redis = get_redis_client()
    if not redis or not redis.is_connected:
        if os.getenv("APP_ENV", "development").lower() in {"acceptance", "production", "prod"}:
            raise HTTPException(status_code=503, detail="Rate limit service is unavailable")
        return True, -1
    limit, window = _rate_limit_settings()
    allowed, remaining = await redis.check_rate_limit(user_id, limit, window, action=action)
    if remaining < 0:
        raise HTTPException(status_code=503, detail="Rate limit service is unavailable")
    return allowed, remaining


async def _stream_upload_to_disk(file: UploadFile, dest_dir: FilePath, max_bytes: int) -> Dict[str, Any]:
    """Stream an upload to disk in chunks with a hard size cap (design doc §40)."""
    dest_dir.mkdir(parents=True, exist_ok=True)
    safe_name = FilePath(file.filename or "upload.bin").name or "upload.bin"
    stored_path = dest_dir / f"{uuid.uuid4().hex[:12]}-{safe_name}"

    hasher = hashlib.sha256()
    size = 0
    try:
        with open(stored_path, "wb") as f:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > max_bytes:
                    raise HTTPException(
                        status_code=413,
                        detail=f"Upload exceeds limit of {max_bytes} bytes",
                    )
                hasher.update(chunk)
                f.write(chunk)
    except Exception:
        # Clean up the partial file on ANY failure (size cap, client
        # disconnect, IO error) so aborted uploads never leak.
        stored_path.unlink(missing_ok=True)
        raise
    return {
        "stored_path": str(stored_path),
        "file_hash_sha256": hasher.hexdigest(),
        "file_size_bytes": size,
        "original_filename": file.filename or safe_name,
    }


async def _stream_request_body_to_disk(
    request: Request,
    dest_dir: FilePath,
    max_bytes: int,
    *,
    filename: str = "upload.bin",
) -> Dict[str, Any]:
    """Stream an already-authorized raw request body without multipart parsing.

    Worker artifact uploads put their metadata in headers. That lets the
    endpoint authenticate and validate the lease before Starlette reads any
    request body or spools it to a temporary file.
    """
    content_length = request.headers.get("content-length")
    if content_length:
        try:
            if int(content_length) > max_bytes:
                raise HTTPException(
                    status_code=413,
                    detail=f"Upload exceeds limit of {max_bytes} bytes",
                )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="Invalid Content-Length") from exc
    dest_dir.mkdir(parents=True, exist_ok=True)
    safe_name = FilePath(filename).name or "upload.bin"
    stored_path = dest_dir / f"{uuid.uuid4().hex[:12]}-{safe_name}"
    hasher = hashlib.sha256()
    size = 0
    try:
        with open(stored_path, "wb") as target:
            async for chunk in request.stream():
                size += len(chunk)
                if size > max_bytes:
                    raise HTTPException(
                        status_code=413,
                        detail=f"Upload exceeds limit of {max_bytes} bytes",
                    )
                hasher.update(chunk)
                target.write(chunk)
    except Exception:
        stored_path.unlink(missing_ok=True)
        raise
    return {
        "stored_path": str(stored_path),
        "file_hash_sha256": hasher.hexdigest(),
        "file_size_bytes": size,
        "original_filename": safe_name,
    }


def _cleanup_task_bundle_files(
    *,
    staging_root: FilePath,
    staged_paths: tuple[Optional[FilePath], Optional[FilePath]],
    moved_paths: list[FilePath],
) -> None:
    """Best-effort cleanup for failed atomic bundle submission."""

    for path in moved_paths:
        path.unlink(missing_ok=True)
    for path in staged_paths:
        if path is not None:
            path.unlink(missing_ok=True)
    shutil.rmtree(staging_root, ignore_errors=True)


def _validate_dataset_file(path: FilePath, logical_name: Optional[str] = None) -> Dict[str, Any]:
    """Perform bounded, deterministic dataset validation before freezing it."""
    import codecs
    import csv
    import zipfile

    try:
        path_info = path.stat()
        if path_info.st_size <= 0:
            return {"passed": False, "code": "empty", "message": "Dataset is empty"}
        suffix = FilePath(logical_name or path.name).suffix.lower()
        if suffix == ".zip":
            with zipfile.ZipFile(path) as archive:
                names = archive.namelist()
                if not names or len(names) > MAX_DATASET_ZIP_ENTRIES:
                    return {
                        "passed": False,
                        "code": "zip_entries",
                        "message": f"ZIP must contain 1-{MAX_DATASET_ZIP_ENTRIES} entries",
                    }
                uncompressed_total = 0
                for name in names:
                    safe = name.replace("\\", "/")
                    if safe.startswith("/") or any(part == ".." for part in safe.split("/")):
                        return {"passed": False, "code": "zip_traversal", "message": "ZIP contains path traversal"}
                    info = archive.getinfo(name)
                    mode = (info.external_attr >> 16) & 0o170000
                    if mode and mode != 0o100000 and not name.endswith("/"):
                        return {"passed": False, "code": "zip_special_file", "message": "ZIP contains a special file"}
                    if info.is_dir():
                        continue
                    if info.file_size > MAX_DATASET_ZIP_FILE_BYTES:
                        return {"passed": False, "code": "zip_file_size", "message": "ZIP contains an oversized file"}
                    uncompressed_total += info.file_size
                    if uncompressed_total > MAX_DATASET_ZIP_UNCOMPRESSED_BYTES:
                        return {"passed": False, "code": "zip_total_size", "message": "ZIP expands beyond the allowed total size"}
                    compressed_size = max(info.compress_size, 1)
                    if info.file_size and info.file_size / compressed_size > MAX_DATASET_ZIP_COMPRESSION_RATIO:
                        return {"passed": False, "code": "zip_compression_ratio", "message": "ZIP compression ratio is unsafe"}
            return {
                "passed": True,
                "format": "zip",
                "size_bytes": path_info.st_size,
                "entry_count": len(names),
                "uncompressed_bytes": uncompressed_total,
            }
        if suffix in {".csv", ".tsv"}:
            # Read a bounded byte sample.  ``read_text()[:N]`` is not bounded:
            # it allocates the entire upload before slicing it.
            with path.open("rb") as handle:
                raw_sample = handle.read(MAX_DATASET_VALIDATION_SAMPLE_BYTES)
            decoder = codecs.getincrementaldecoder("utf-8")("strict")
            sample = decoder.decode(raw_sample, final=False)
            delimiter = "\t" if suffix == ".tsv" else ","
            rows = list(csv.reader(sample.splitlines(), delimiter=delimiter))
            if not rows or len(rows[0]) < 1:
                return {"passed": False, "code": "no_columns", "message": "Dataset has no columns"}
            return {"passed": True, "format": suffix.lstrip("."), "size_bytes": path_info.st_size, "column_count": len(rows[0]), "sample_rows": max(0, len(rows) - 1)}
        # Binary/scientific formats get a bounded existence/size check here;
        # format-specific verifiers run in the isolated Job.
        return {"passed": True, "format": suffix.lstrip(".") or "binary", "size_bytes": path_info.st_size}
    except (OSError, UnicodeError, ValueError, csv.Error, zipfile.BadZipFile) as exc:
        return {"passed": False, "code": "invalid", "message": redact_secrets(exc)}


async def _get_project_resource(pool, resource_id: str, user_id: str) -> Optional[Dict[str, Any]]:
    query = """
        SELECT resource_id, project_id, owner_user_id, kind, logical_name,
               storage_key, content_type, file_size_bytes, checksum_sha256,
               egress_policy, status, created_at
        FROM project_resources pr
        WHERE pr.resource_id = $1::uuid
          AND pr.owner_user_id = $2
          AND pr.status = 'ready'
          AND EXISTS (
              SELECT 1 FROM project_members pm
              WHERE pm.project_id = pr.project_id AND pm.user_id = $2
          )
    """
    async with pool.acquire() as conn:
        row = await conn.fetchrow(query, resource_id, user_id)
    if not row:
        return None
    return {
        "resource_id": str(row["resource_id"]),
        "project_id": str(row["project_id"]),
        "owner_user_id": row["owner_user_id"],
        "kind": row["kind"],
        "logical_name": row["logical_name"],
        "storage_key": row["storage_key"],
        "content_type": row["content_type"],
        "file_size_bytes": row["file_size_bytes"],
        "checksum_sha256": row["checksum_sha256"],
        "egress_policy": row["egress_policy"],
        "status": row["status"],
        "created_at": row["created_at"].isoformat() if row["created_at"] else None,
    }


def _safe_storage_path(root: FilePath, storage_key: str) -> FilePath:
    """Resolve a DB storage key without following a symlinked component."""
    safe_key = safe_relative_path(storage_key)
    root = root.resolve()
    candidate = root / safe_key
    current = root
    for part in FilePath(safe_key).parts:
        current = current / part
        if current.is_symlink():
            raise HTTPException(status_code=404, detail="Resource not found")
    try:
        resolved = candidate.resolve()
        resolved.relative_to(root)
    except (ValueError, OSError) as exc:
        raise HTTPException(status_code=404, detail="Resource not found") from exc
    return resolved


@app.post("/api/resources/upload")
async def upload_resource_endpoint(
    project_id: str = Form(...),
    session_id: Optional[str] = Form(None),
    file: UploadFile = File(...),
    user: Principal = Depends(require_user),
):
    """Store an uploaded file behind an opaque, project-authorized Resource ID."""
    pool = app.state.db_pool
    if not await user_can_access_project(pool, project_id, user.user_id):
        raise HTTPException(status_code=404, detail="Project not found")
    if session_id:
        try:
            uuid.UUID(session_id)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="Invalid session ID") from exc
        if not await get_session(pool, session_id, user.user_id):
            raise HTTPException(status_code=404, detail="Session not found")
    resource_id = str(uuid.uuid4())
    root = FilePath(os.getenv("RESOURCE_STORAGE_ROOT", "/workspace/resources")).resolve()
    root.mkdir(parents=True, exist_ok=True)
    temporary = await _stream_upload_to_disk(file, root / ".staging", MAX_DATASET_UPLOAD_BYTES)
    source = FilePath(temporary["stored_path"])
    storage_key = resource_id
    destination = root / storage_key
    try:
        source.replace(destination)
    except OSError as exc:
        source.unlink(missing_ok=True)
        destination.unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail="Resource storage failed") from exc
    try:
        async with pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO project_resources (
                    resource_id, project_id, owner_user_id, kind, logical_name,
                    storage_key, content_type, file_size_bytes, checksum_sha256,
                    egress_policy, status
                ) VALUES ($1::uuid, $2::uuid, $3, 'uploaded_file', $4, $1::text,
                          $5, $6, $7, 'local_only', 'ready')
                """,
                resource_id,
                project_id,
                user.user_id,
                FilePath(file.filename or "resource.bin").name,
                file.content_type or "application/octet-stream",
                temporary["file_size_bytes"],
                temporary["file_hash_sha256"],
            )
            if session_id:
                await conn.execute(
                    """
                    INSERT INTO session_resource_links (session_id, resource_id)
                    VALUES ($1::uuid, $2::uuid)
                    ON CONFLICT DO NOTHING
                    """,
                    session_id,
                    resource_id,
                )
    except Exception as exc:
        destination.unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail="Resource metadata storage failed") from exc
    if session_id:
        _record_session_resource(session_id, {
            "resource_id": resource_id,
            "project_id": project_id,
            "kind": "uploaded_file",
            "logical_name": file.filename or "resource.bin",
            "storage_key": storage_key,
            "content_type": file.content_type or "application/octet-stream",
            "file_size_bytes": temporary["file_size_bytes"],
            "checksum_sha256": temporary["file_hash_sha256"],
        })
    return {
        "resource_id": resource_id,
        "project_id": project_id,
        "logical_name": FilePath(file.filename or "resource.bin").name,
        "file_size_bytes": temporary["file_size_bytes"],
        "checksum_sha256": temporary["file_hash_sha256"],
        "egress_policy": "local_only",
    }


@app.get("/api/resources/{resource_id}")
async def get_resource_endpoint(resource_id: str, user: Principal = Depends(require_user)):
    try:
        uuid.UUID(resource_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail="Resource not found") from exc
    resource = await _get_project_resource(app.state.db_pool, resource_id, user.user_id)
    if not resource:
        raise HTTPException(status_code=404, detail="Resource not found")
    return {key: value for key, value in resource.items() if key != "storage_key"}


@app.get("/api/resources/{resource_id}/content")
async def download_resource_endpoint(resource_id: str, user: Principal = Depends(require_user)):
    try:
        uuid.UUID(resource_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail="Resource not found") from exc
    resource = await _get_project_resource(app.state.db_pool, resource_id, user.user_id)
    if not resource:
        raise HTTPException(status_code=404, detail="Resource not found")
    root = FilePath(os.getenv("RESOURCE_STORAGE_ROOT", "/workspace/resources"))
    try:
        path = _safe_storage_path(root, resource["storage_key"])
    except HTTPException:
        raise
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Resource not found")
    return FileResponse(str(path), media_type=resource["content_type"], filename=resource["logical_name"])


@app.get("/api/projects/default", response_model=Dict[str, Any])
async def get_default_project_endpoint(user: Optional[Principal] = Depends(_require_task_api_key)):
    """Return the default project, creating it on first use (design doc §13.1)."""
    pool = app.state.db_pool
    return await ensure_default_project(pool, user_id=user.user_id if user else None)


def _provider_profile_public(row: Any) -> Dict[str, Any]:
    return {
        "provider_profile_id": str(row["provider_profile_id"]),
        "project_id": str(row["project_id"]),
        "purpose": row["purpose"],
        "protocol": row["protocol"],
        "base_url": row["base_url"],
        "model_id": row["model_id"],
        "status": row["status"],
        "credential_configured": bool(row.get("credential_ref") if hasattr(row, "get") else row["credential_ref"]),
        "probe_revision": row["probe_revision"],
        "created_at": row["created_at"].isoformat() if row["created_at"] else None,
    }


def _validate_profile_request(request: ProviderProfileRequest) -> str:
    purpose = request.purpose.strip().lower()
    protocol = request.protocol.strip().lower()
    if purpose == "analysis" and protocol != "openai_compatible":
        raise HTTPException(status_code=400, detail="Analysis profiles require openai_compatible protocol")
    if purpose == "coding" and protocol != "anthropic_messages":
        raise HTTPException(status_code=400, detail="Coding profiles require anthropic_messages protocol")
    if purpose not in {"analysis", "coding"}:
        raise HTTPException(status_code=400, detail="Unsupported provider purpose")
    try:
        allowed_local_hosts = {"localhost", "127.0.0.1", "::1"}
        # The acceptance API runs in Docker while the local protocol spy may
        # run on the host.  This explicit host-gateway name is permitted only
        # for local development/acceptance and is not a production egress
        # exception.
        if os.getenv("APP_ENV", "development").lower() in {"development", "test", "acceptance"}:
            allowed_local_hosts.add("host.docker.internal")
        return validate_outbound_url(
            request.base_url.rstrip("/"),
            allow_http_local=os.getenv("APP_ENV", "development").lower() in {"development", "test", "acceptance"},
            allow_hosts=allowed_local_hosts,
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Provider base URL is not allowed") from exc


@app.post("/api/provider-profiles", response_model=ProviderProfileResponse)
async def create_provider_profile_endpoint(
    request: ProviderProfileRequest,
    user: Optional[Principal] = Depends(_require_task_api_key),
):
    if user is None:
        raise HTTPException(status_code=401, detail="Authentication required")
    if not await user_can_access_project(app.state.db_pool, request.project_id, user.user_id):
        raise HTTPException(status_code=404, detail="Project not found")
    base_url = _validate_profile_request(request)
    model_id = request.model_id.strip()
    if not model_id or len(model_id) > 200:
        raise HTTPException(status_code=400, detail="Invalid model ID")
    profile_id = str(uuid.uuid4())
    credential_ref = None
    fingerprint = None
    if request.credential:
        credential_ref = f"provider:{uuid.uuid4()}"
        fingerprint = secret_fingerprint(request.credential)
        ciphertext = encrypt_secret(request.credential, aad=f"provider:{profile_id}:{request.project_id}")
        async with app.state.db_pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO provider_secrets (credential_ref, project_id, owner_user_id, ciphertext)
                VALUES ($1, $2::uuid, $3, $4)
                """,
                credential_ref, request.project_id, user.user_id, ciphertext,
            )
    async with app.state.db_pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO provider_profiles (
                provider_profile_id, project_id, owner_user_id, purpose, protocol,
                base_url, model_id, credential_ref, credential_fingerprint, status
            ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, 'draft')
            RETURNING provider_profile_id, project_id, purpose, protocol, base_url,
                      model_id, credential_ref, status, probe_revision, created_at
            """,
            profile_id, request.project_id, user.user_id, request.purpose.strip().lower(),
            request.protocol.strip().lower(), base_url, model_id, credential_ref, fingerprint,
        )
    return _provider_profile_public(row)


@app.get("/api/provider-profiles", response_model=List[ProviderProfileResponse])
async def list_provider_profiles_endpoint(
    project_id: str,
    user: Optional[Principal] = Depends(_require_task_api_key),
):
    if user is None or not await user_can_access_project(app.state.db_pool, project_id, user.user_id):
        raise HTTPException(status_code=404, detail="Project not found")
    async with app.state.db_pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT provider_profile_id, project_id, purpose, protocol, base_url,
                   model_id, credential_ref, status, probe_revision, created_at
            FROM provider_profiles
            WHERE project_id = $1::uuid AND owner_user_id = $2 AND revoked_at IS NULL
            ORDER BY created_at DESC
            """,
            project_id, user.user_id,
        )
    return [_provider_profile_public(row) for row in rows]


@app.post("/api/provider-profiles/{provider_profile_id}/probe")
async def probe_provider_profile_endpoint(
    provider_profile_id: str,
    user: Optional[Principal] = Depends(_require_task_api_key),
):
    if user is None:
        raise HTTPException(status_code=401, detail="Authentication required")
    async with app.state.db_pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT provider_profile_id, project_id, owner_user_id, purpose, protocol,
                   base_url, model_id, credential_ref, status, probe_revision, created_at
            FROM provider_profiles
            WHERE provider_profile_id = $1::uuid AND owner_user_id = $2 AND revoked_at IS NULL
            """,
            provider_profile_id, user.user_id,
        )
    if not row:
        raise HTTPException(status_code=404, detail="Provider profile not found")
    credential = None
    if row["credential_ref"]:
        async with app.state.db_pool.acquire() as conn:
            secret_row = await conn.fetchrow(
                """
                SELECT ciphertext FROM provider_secrets
                WHERE credential_ref = $1 AND project_id = $2::uuid
                  AND owner_user_id = $3 AND revoked_at IS NULL
                """,
                row["credential_ref"], row["project_id"], user.user_id,
            )
        if not secret_row:
            raise HTTPException(status_code=409, detail="Provider credential is unavailable")
        try:
            credential = decrypt_secret(
                secret_row["ciphertext"],
                aad=f"provider:{row['provider_profile_id']}:{row['project_id']}",
            )
        except Exception as exc:
            raise HTTPException(status_code=500, detail="Provider credential could not be opened") from exc
    from backend.coding_provider import CodingProviderProfile, probe_coding_capabilities
    from backend.provider import ProviderProfile, probe_analysis_capabilities
    try:
        if row["purpose"] == "analysis":
            profile = ProviderProfile("analysis", "openai-compatible-chat-completions", row["base_url"], row["model_id"], credential)
            probe = await probe_analysis_capabilities(profile)
        else:
            profile = CodingProviderProfile("anthropic-messages", row["base_url"], row["model_id"], credential)
            probe = await probe_coding_capabilities(profile)
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Provider capability probe could not start") from exc
    status_value = "ready" if probe.get("ready") else "failed"
    revision = f"local-{int(time.time())}"
    async with app.state.db_pool.acquire() as conn:
        await conn.execute(
            """
            UPDATE provider_profiles
            SET status = $2, capability_json = $3::jsonb, probe_revision = $4
            WHERE provider_profile_id = $1::uuid AND owner_user_id = $5
            """,
            provider_profile_id, status_value, json.dumps(probe), revision, user.user_id,
        )
    return {"provider_profile_id": provider_profile_id, "status": status_value, "probe_revision": revision, "probe": probe}


@app.post("/api/provider-profiles/{provider_profile_id}/revoke")
async def revoke_provider_profile_endpoint(
    provider_profile_id: str,
    user: Optional[Principal] = Depends(_require_task_api_key),
):
    if user is None:
        raise HTTPException(status_code=401, detail="Authentication required")
    async with app.state.db_pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            UPDATE provider_profiles
            SET status = 'revoked', revoked_at = NOW()
            WHERE provider_profile_id = $1::uuid AND owner_user_id = $2 AND revoked_at IS NULL
            RETURNING project_id, credential_ref
            """,
            provider_profile_id, user.user_id,
        )
        if row and row["credential_ref"]:
            await conn.execute(
                "UPDATE provider_secrets SET revoked_at = NOW() WHERE credential_ref = $1 AND owner_user_id = $2",
                row["credential_ref"], user.user_id,
            )
    if not row:
        raise HTTPException(status_code=404, detail="Provider profile not found")
    return {"provider_profile_id": provider_profile_id, "status": "revoked"}


@app.post("/api/method-sources/upload", response_model=Dict[str, Any])
async def upload_method_source_endpoint(
    file: UploadFile = File(...),
    user: Optional[Principal] = Depends(_require_task_api_key),
):
    """Upload a method source document (HTML/PDF/...) describing the workflow.

    The execution document format is intentionally free-form (design doc §4):
    a saved web page or PDF that the Job Container reads as instructions.
    """
    safe_name = FilePath(file.filename or "").name
    if not safe_name or FilePath(safe_name).suffix.lower() not in _METHOD_SOURCE_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported method source type; allowed: {', '.join(sorted(_METHOD_SOURCE_EXTENSIONS))}",
        )

    upload_root = FilePath(os.getenv("METHOD_SOURCE_UPLOAD_ROOT", "/tmp/uploaded-method-sources"))
    upload = await _stream_upload_to_disk(file, upload_root, MAX_METHOD_SOURCE_BYTES)

    pool = app.state.db_pool
    source_path = FilePath(upload["stored_path"])
    try:
        project = await ensure_default_project(pool, user_id=user.user_id if user else None)
        source = MethodSource(
            method_source_id=str(uuid.uuid4()),
            project_id=project["project_id"],
            original_filename=upload["original_filename"],
            stored_path=upload["stored_path"],
            content_type=file.content_type,
            file_size_bytes=upload["file_size_bytes"],
            file_hash_sha256=upload["file_hash_sha256"],
        )
        result = await create_method_source(pool, source)
    except Exception as exc:
        source_path.unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail="Failed to persist execution document") from exc

    return {
        "method_source_id": result.method_source_id,
        "project_id": result.project_id,
        "original_filename": result.original_filename,
        "file_hash_sha256": result.file_hash_sha256,
        "file_size_bytes": result.file_size_bytes,
        "created_at": result.created_at,
    }


@app.post("/api/task-specs", response_model=Dict[str, Any])
async def create_task_spec_endpoint(
    request: CreateTaskSpecRequest,
    user: Optional[Principal] = Depends(_require_task_api_key),
):
    """Create a new TaskSpec."""
    pool = app.state.db_pool
    if user and not await user_can_access_project(pool, request.project_id, user.user_id):
        raise HTTPException(status_code=404, detail="Project not found")
    spec = TaskSpec(
        task_spec_id=str(uuid.uuid4()),
        project_id=request.project_id,
        title=request.title,
        analysis_type=request.analysis_type,
        research_question=request.research_question,
        spec_json=request.spec_json,
        created_by=user.user_id if user else None,
    )
    result = await create_task_spec(pool, spec)
    return {
        "task_spec_id": result.task_spec_id,
        "revision": result.revision,
        "status": result.status,
        "created_at": result.created_at,
    }


@app.post("/api/task-specs/{task_spec_id}/freeze", response_model=Dict[str, Any])
async def freeze_task_spec_endpoint(
    task_spec_id: str,
    user: Optional[Principal] = Depends(_require_task_api_key),
):
    pool = app.state.db_pool
    spec = await get_task_spec(pool, task_spec_id)
    if user and (
        not spec
        or str(spec.get("created_by")) != str(user.user_id)
        or not await user_can_access_project(pool, str(spec["project_id"]), user.user_id)
    ):
        raise HTTPException(status_code=404, detail="TaskSpec not found")
    frozen = await freeze_task_spec(pool, task_spec_id)
    if not frozen:
        raise HTTPException(status_code=409, detail="TaskSpec is already frozen or does not exist")
    return {"task_spec_id": frozen.task_spec_id, "status": frozen.status, "frozen": True}


@app.post("/api/dataset-snapshots/upload", response_model=Dict[str, Any])
async def upload_dataset_endpoint(
    project_id: str = Form(...),
    session_id: Optional[str] = Form(None),
    file: UploadFile = File(...),
    user: Optional[Principal] = Depends(_require_task_api_key),
):
    """Upload a dataset into a project-owned opaque Resource."""
    safe_name = FilePath(file.filename or "dataset.bin").name
    if not safe_name:
        raise HTTPException(status_code=400, detail="Empty filename")

    pool = app.state.db_pool
    if user and not await user_can_access_project(pool, project_id, user.user_id):
        raise HTTPException(status_code=404, detail="Project not found")
    if session_id:
        if user is None:
            raise HTTPException(status_code=401, detail="Authentication required")
        try:
            uuid.UUID(session_id)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="Invalid session ID") from exc
        if not await get_session(pool, session_id, user.user_id):
            raise HTTPException(status_code=404, detail="Session not found")
    upload_root = FilePath(os.getenv("RESOURCE_STORAGE_ROOT", "/workspace/resources")).resolve()
    resource_id = str(uuid.uuid4())
    staging_root = upload_root / ".staging"
    resource_root = upload_root / "datasets"
    upload = await _stream_upload_to_disk(file, staging_root, MAX_DATASET_UPLOAD_BYTES)
    source = FilePath(upload["stored_path"])
    destination = resource_root / resource_id
    try:
        resource_root.mkdir(parents=True, exist_ok=True)
        source.replace(destination)
        async with pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO project_resources (
                    resource_id, project_id, owner_user_id, kind, logical_name,
                    storage_key, content_type, file_size_bytes, checksum_sha256,
                    egress_policy, status
                ) VALUES ($1::uuid, $2::uuid, $3, 'dataset', $4, $5, $6, $7, $8,
                          'local_only', 'ready')
                """,
                resource_id,
                project_id,
                user.user_id if user else "local",
                safe_name,
                f"datasets/{resource_id}",
                file.content_type or "application/octet-stream",
                upload["file_size_bytes"],
                upload["file_hash_sha256"],
            )
            if session_id:
                await conn.execute(
                    """
                    INSERT INTO session_resource_links (session_id, resource_id)
                    VALUES ($1::uuid, $2::uuid)
                    ON CONFLICT DO NOTHING
                    """,
                    session_id,
                    resource_id,
                )
    except Exception as exc:
        source.unlink(missing_ok=True)
        destination.unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail="Dataset resource storage failed") from exc
    if session_id:
        _record_session_resource(session_id, {
            "resource_id": resource_id,
            "project_id": project_id,
            "kind": "dataset",
            "logical_name": safe_name,
            "storage_key": f"datasets/{resource_id}",
            "content_type": file.content_type or "application/octet-stream",
            "file_size_bytes": upload["file_size_bytes"],
            "checksum_sha256": upload["file_hash_sha256"],
            "validation_result": None,
        })
    return {
        "resource_id": resource_id,
        "project_id": project_id,
        "logical_name": safe_name,
        "file_hash_sha256": upload["file_hash_sha256"],
        "file_size_bytes": upload["file_size_bytes"],
    }


@app.post("/api/dataset-snapshots", response_model=Dict[str, Any])
async def create_dataset_endpoint(
    request: CreateDatasetRequest,
    user: Optional[Principal] = Depends(_require_task_api_key),
):
    """Create a dataset snapshot."""
    pool = app.state.db_pool
    if user and not await user_can_access_project(pool, request.project_id, user.user_id):
        raise HTTPException(status_code=404, detail="Project not found")
    async with pool.acquire() as conn:
        spec = await conn.fetchrow(
            "SELECT project_id, created_by FROM task_specs WHERE task_spec_id = $1::uuid",
            request.task_spec_id,
        )
    if (
        spec is None
        or str(spec["project_id"]) != str(request.project_id)
        or (user and str(spec["created_by"]) != str(user.user_id))
    ):
        raise HTTPException(status_code=404, detail="TaskSpec not found")
    logical_dataset_name = FilePath(request.original_filename or "dataset.bin").name
    if user:
        if not request.resource_id:
            raise HTTPException(status_code=400, detail="resource_id is required")
        resource = await _get_project_resource(pool, request.resource_id, user.user_id)
        if not resource or resource["project_id"] != request.project_id or resource["kind"] != "dataset":
            raise HTTPException(status_code=404, detail="Dataset resource not found")
        resource_root = FilePath(os.getenv("RESOURCE_STORAGE_ROOT", "/workspace/resources"))
        resolved = _safe_storage_path(resource_root, resource["storage_key"])
        stored_path = str(resolved)
        logical_dataset_name = FilePath(resource["logical_name"]).name
    else:
        # Legacy tests/local scripts may still pass a path when the Task API is
        # explicitly unauthenticated. This branch is never accepted in the
        # cookie-authenticated acceptance/production configuration.
        if not request.stored_path:
            raise HTTPException(status_code=400, detail="stored_path is required in legacy mode")
        allowed_roots = [
            FilePath(os.getenv("DATASET_UPLOAD_ROOT", "/tmp/uploaded-datasets")).resolve(),
            FilePath(os.getenv("METHOD_SOURCE_UPLOAD_ROOT", "/tmp/uploaded-method-sources")).resolve(),
        ]
        resolved = FilePath(request.stored_path).resolve()
        if not any(resolved.is_relative_to(root) for root in allowed_roots):
            raise HTTPException(status_code=400, detail="stored_path is outside the upload root")
        stored_path = request.stored_path
    if not resolved.is_file() or resolved.is_symlink():
        raise HTTPException(status_code=400, detail="Dataset must be a regular uploaded file")
    validation_result = _validate_dataset_file(resolved, logical_dataset_name)
    file_hasher = hashlib.sha256()
    with resolved.open("rb") as dataset_handle:
        for chunk in iter(lambda: dataset_handle.read(1024 * 1024), b""):
            file_hasher.update(chunk)
    snapshot = DatasetSnapshot(
        dataset_snapshot_id=str(uuid.uuid4()),
        task_spec_id=request.task_spec_id,
        project_id=request.project_id,
        original_filename=logical_dataset_name,
        stored_path=stored_path,
        file_size_bytes=resolved.stat().st_size,
        file_hash_sha256=file_hasher.hexdigest(),
        validation_result=validation_result,
        validation_passed=bool(validation_result.get("passed")),
    )
    result = await create_dataset_snapshot(pool, snapshot)
    return {
        "dataset_snapshot_id": result.dataset_snapshot_id,
        "version": result.version,
        "created_at": result.created_at,
    }


@app.post("/api/tasks/submit-bundle", response_model=SubmitTaskBundleResponse)
async def submit_task_bundle_endpoint(
    method_file: UploadFile = File(...),
    dataset_file: UploadFile = File(...),
    title: str = Form(""),
    idempotency_key: str = Form(...),
    project_id: Optional[str] = Form(None),
    user: Optional[Principal] = Depends(_require_task_api_key),
):
    """Create the complete Task input bundle as one user operation.

    The browser used to issue six independent requests. A failure between
    those requests could leave a frozen spec, an uploaded resource, or a
    dataset snapshot with no Task. This endpoint stages both files first and
    commits all metadata, the Task, idempotency record, and Outbox event in a
    single database transaction; any failure removes the staged/moved files.
    """
    if user is None:
        raise HTTPException(status_code=401, detail="Authentication required")
    if not idempotency_key.strip() or len(idempotency_key.strip()) > 255:
        raise HTTPException(status_code=400, detail="A bounded idempotency key is required")

    pool = app.state.db_pool

    safe_method_name = FilePath(method_file.filename or "").name
    if not safe_method_name or FilePath(safe_method_name).suffix.lower() not in _METHOD_SOURCE_EXTENSIONS:
        raise HTTPException(status_code=400, detail="Unsupported execution document type")
    safe_dataset_name = FilePath(dataset_file.filename or "dataset.bin").name or "dataset.bin"

    if project_id:
        if not await user_can_access_project(pool, project_id, user.user_id):
            raise HTTPException(status_code=404, detail="Project not found")
        selected_project_id = project_id
    else:
        project = await ensure_default_project(pool, user_id=user.user_id)
        selected_project_id = str(project["project_id"])

    bundle_id = uuid.uuid4().hex
    method_root = FilePath(os.getenv("METHOD_SOURCE_UPLOAD_ROOT", "/tmp/uploaded-method-sources")).resolve()
    resource_root = FilePath(os.getenv("RESOURCE_STORAGE_ROOT", "/workspace/resources")).resolve()
    staging_root = method_root / ".task-bundles" / bundle_id
    method_staging = staging_root / "method"
    dataset_staging = staging_root / "dataset"
    method_path: Optional[FilePath] = None
    dataset_path: Optional[FilePath] = None
    moved_paths: list[FilePath] = []
    request_hash: Optional[str] = None
    try:
        method_upload = await _stream_upload_to_disk(method_file, method_staging, MAX_METHOD_SOURCE_BYTES)
        dataset_upload = await _stream_upload_to_disk(dataset_file, dataset_staging, MAX_DATASET_UPLOAD_BYTES)
        method_path = FilePath(method_upload["stored_path"])
        dataset_path = FilePath(dataset_upload["stored_path"])
        validation_result = _validate_dataset_file(dataset_path, safe_dataset_name)
        if not validation_result.get("passed"):
            raise HTTPException(status_code=400, detail=f"Dataset validation failed: {validation_result.get('message', 'invalid dataset')}")

        task_title = title.strip() or FilePath(safe_dataset_name).stem or "Analysis task"
        task_spec_id = str(uuid.uuid4())
        method_source_id = str(uuid.uuid4())
        dataset_snapshot_id = str(uuid.uuid4())
        resource_id = str(uuid.uuid4())
        task_id = str(uuid.uuid4())
        resource_dir = resource_root / "datasets"
        resource_dir.mkdir(parents=True, exist_ok=True)
        final_dataset_path = resource_dir / resource_id
        method_final_dir = method_root / "documents"
        method_final_dir.mkdir(parents=True, exist_ok=True)
        final_method_path = method_final_dir / f"{method_source_id}-{safe_method_name}"
        method_path.replace(final_method_path)
        moved_paths.append(final_method_path)
        dataset_path.replace(final_dataset_path)
        moved_paths.append(final_dataset_path)

        request_hash = hashlib.sha256(
            json.dumps({
                "project_id": selected_project_id,
                "title": task_title,
                "method_filename": safe_method_name,
                "method_hash": method_upload["file_hash_sha256"],
                "dataset_filename": safe_dataset_name,
                "dataset_hash": dataset_upload["file_hash_sha256"],
            }, sort_keys=True, separators=(",", ":")).encode("utf-8")
        ).hexdigest()

        # A bundle fingerprint includes both streamed file hashes.  Checking
        # only the key before reading the uploads would silently replay an old
        # Task when a caller accidentally reuses the key for different files.
        # We therefore perform the idempotency check after staging, while the
        # staged files are still cleaned by the common error path below.
        existing = await check_idempotency(pool, idempotency_key.strip(), user.user_id)
        if existing:
            if existing["resource_type"] != "task":
                raise HTTPException(status_code=409, detail="Idempotency key is already used")
            stored_hash = existing.get("request_hash")
            if stored_hash and stored_hash != request_hash:
                raise HTTPException(status_code=409, detail="Idempotency key was reused with a different request")
            existing_task = await get_task(pool, existing["resource_id"])
            if existing_task and existing_task.get("created_by") == user.user_id:
                # The idempotency check happens after both uploads have been
                # staged and moved into their final opaque paths so their
                # content hashes are available.  A replay must not leave
                # those newly moved files orphaned; the existing task owns
                # its original paths and is the only record returned.
                _cleanup_task_bundle_files(
                    staging_root=staging_root,
                    staged_paths=(method_path, dataset_path),
                    moved_paths=moved_paths,
                )
                return SubmitTaskBundleResponse(
                    task_id=str(existing_task["task_id"]),
                    status=existing_task["status"],
                    attempt_count=int(existing_task.get("attempt_count") or 0),
                    duplicate=True,
                )
            raise HTTPException(status_code=409, detail="Idempotency record points to a missing task")

        async with pool.acquire() as conn:
            async with conn.transaction():
                membership = await conn.fetchval(
                    "SELECT 1 FROM project_members WHERE project_id = $1::uuid AND user_id = $2 LIMIT 1",
                    selected_project_id, user.user_id,
                )
                if not membership:
                    raise HTTPException(status_code=404, detail="Project not found")
                await conn.execute(
                    """
                    INSERT INTO task_specs (
                        task_spec_id, project_id, revision, title, domain, analysis_type,
                        research_question, spec_json, schema_version, status, created_by, frozen_at
                    ) VALUES ($1::uuid, $2::uuid, 1, $3, 'bioinformatics', 'generic', $3, '{}'::jsonb, '1.0', 'active', $4, NOW())
                    """,
                    task_spec_id, selected_project_id, task_title, user.user_id,
                )
                await conn.execute(
                    """
                    INSERT INTO method_sources (
                        method_source_id, project_id, task_spec_id, original_filename,
                        stored_path, content_type, file_size_bytes, file_hash_sha256
                    ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8)
                    """,
                    method_source_id, selected_project_id, task_spec_id, safe_method_name,
                    str(final_method_path), method_file.content_type, method_upload["file_size_bytes"], method_upload["file_hash_sha256"],
                )
                await conn.execute(
                    """
                    INSERT INTO project_resources (
                        resource_id, project_id, owner_user_id, kind, logical_name,
                        storage_key, content_type, file_size_bytes, checksum_sha256,
                        egress_policy, status
                    ) VALUES ($1::uuid, $2::uuid, $3, 'dataset', $4, $5, $6, $7, $8, 'local_only', 'ready')
                    """,
                    resource_id, selected_project_id, user.user_id, safe_dataset_name,
                    f"datasets/{resource_id}", dataset_file.content_type or "application/zip",
                    dataset_upload["file_size_bytes"], dataset_upload["file_hash_sha256"],
                )
                await conn.execute(
                    """
                    INSERT INTO dataset_snapshots (
                        dataset_snapshot_id, task_spec_id, project_id, original_filename,
                        stored_path, file_size_bytes, file_hash_sha256, validation_result,
                        validation_passed, version
                    ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8::jsonb, TRUE, 1)
                    """,
                    dataset_snapshot_id, task_spec_id, selected_project_id, safe_dataset_name,
                    str(final_dataset_path), dataset_upload["file_size_bytes"], dataset_upload["file_hash_sha256"],
                    json.dumps(validation_result),
                )
                row = await conn.fetchrow(
                    """
                    INSERT INTO tasks (
                        task_id, task_spec_id, dataset_snapshot_id, project_id, method_source_id,
                        title, status, max_attempts, required_trust_level, created_by
                    ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, 'queued', 3, $7, $8)
                    RETURNING task_id, status, attempt_count
                    """,
                    task_id, task_spec_id, dataset_snapshot_id, selected_project_id,
                    method_source_id, task_title, "general", user.user_id,
                )
                await conn.execute(
                    """
                    INSERT INTO idempotency_keys (idempotency_key, user_id, resource_type, resource_id, request_hash, expires_at)
                    VALUES ($1, $2, 'task', $3::uuid, $4, NOW() + INTERVAL '24 hours')
                    """,
                    idempotency_key.strip(), user.user_id, task_id, request_hash,
                )
                task_event = await conn.fetchrow(
                    """
                    INSERT INTO task_events (task_id, task_attempt_id, event_type, event_data, created_at)
                    VALUES ($1::uuid, NULL, 'task_queued', $2::jsonb, NOW())
                    RETURNING task_event_id
                    """,
                    task_id,
                    json.dumps({"task_id": task_id, "status": "queued"}),
                )
                if not task_event:
                    raise RuntimeError("task lifecycle event was not created")
                await conn.execute(
                    """
                    INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload, status)
                    VALUES ('task', $1::uuid, 'task_queued', $2::jsonb, 'pending')
                    """,
                    task_id, json.dumps({
                        "task_id": task_id,
                        "task_event_id": task_event["task_event_id"],
                        "status": "queued",
                    }),
                )
        return SubmitTaskBundleResponse(task_id=str(row["task_id"]), status=row["status"], attempt_count=int(row["attempt_count"] or 0))
    except HTTPException:
        _cleanup_task_bundle_files(
            staging_root=staging_root,
            staged_paths=(method_path, dataset_path),
            moved_paths=moved_paths,
        )
        raise
    except Exception as exc:
        _cleanup_task_bundle_files(
            staging_root=staging_root,
            staged_paths=(method_path, dataset_path),
            moved_paths=moved_paths,
        )
        # Two concurrent requests may race after the fingerprint check. If the
        # other request committed first, replay only when its fingerprint is
        # identical; a different request must receive a conflict.
        try:
            existing_after = await check_idempotency(pool, idempotency_key.strip(), user.user_id)
            if existing_after and existing_after["resource_type"] == "task":
                stored_hash = existing_after.get("request_hash")
                if stored_hash and stored_hash != request_hash:
                    raise HTTPException(status_code=409, detail="Idempotency key was reused with a different request")
                existing_task = await get_task(pool, existing_after["resource_id"])
                if existing_task and existing_task.get("created_by") == user.user_id:
                    return SubmitTaskBundleResponse(
                        task_id=str(existing_task["task_id"]),
                        status=existing_task["status"],
                        attempt_count=int(existing_task.get("attempt_count") or 0),
                        duplicate=True,
                    )
            global_after = await check_idempotency(pool, idempotency_key.strip())
            if global_after:
                raise HTTPException(status_code=409, detail="Idempotency key is already in use")
        except HTTPException:
            raise
        except Exception:
            pass
        logger.exception("Atomic task bundle submission failed")
        raise HTTPException(status_code=500, detail="Task bundle submission failed") from exc


@app.get("/api/task-drafts/{draft_id}")
async def get_task_draft_endpoint(draft_id: str, user: Principal = Depends(require_user)):
    try:
        uuid.UUID(draft_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail="Task draft not found") from exc
    draft = await get_task_draft(app.state.db_pool, draft_id, user.user_id)
    if not draft:
        raise HTTPException(status_code=404, detail="Task draft not found")
    return {
        "draft_id": draft["draft_id"],
        "project_id": draft["project_id"],
        "revision": draft["revision"],
        "status": draft["status"],
        "title": draft["title"],
        "goal_summary": draft["goal_summary"],
        "method": ({
            "filename": draft["method_filename"],
            "size_bytes": draft["method_size_bytes"],
            "sha256": draft["method_hash_sha256"],
            "preview": draft["method_preview"],
        } if draft["method_path"] else None),
        "dataset": {
            "resource_id": draft["dataset_resource_id"],
            "filename": draft["dataset_filename"],
            "size_bytes": draft["dataset_size_bytes"],
            "sha256": draft["dataset_hash_sha256"],
        },
        "missing_inputs": draft["missing_inputs"],
        "task_spec": draft["task_spec"],
    }


@app.post("/api/task-drafts/{draft_id}/cancel")
async def cancel_task_draft_endpoint(draft_id: str, user: Principal = Depends(require_user)):
    draft = await get_task_draft(app.state.db_pool, draft_id, user.user_id)
    if not await cancel_task_draft(app.state.db_pool, draft_id, user.user_id):
        raise HTTPException(status_code=404, detail="Active task draft not found")
    if draft:
        root = _get_session_root(str(draft["session_id"])).resolve()
        draft_root = ensure_within(root, root / "task-drafts" / draft_id)
        if draft_root.exists() and draft_root.is_dir() and not draft_root.is_symlink():
            shutil.rmtree(draft_root, ignore_errors=True)
    return {"draft_id": draft_id, "status": "cancelled"}


@app.post("/api/task-drafts/{draft_id}/confirm", response_model=SubmitTaskBundleResponse)
async def confirm_task_draft_endpoint(
    draft_id: str,
    request: TaskDraftConfirmRequest,
    user: Principal = Depends(require_user),
):
    """Freeze a reviewed Agent draft and create exactly one Worker Task."""
    pool = app.state.db_pool
    draft = await get_task_draft(pool, draft_id, user.user_id)
    if not draft:
        raise HTTPException(status_code=409, detail="Task draft is no longer available")
    if draft["status"] == "confirmed":
        async with pool.acquire() as conn:
            existing = await conn.fetchrow(
                """
                SELECT resource_id
                FROM idempotency_keys
                WHERE idempotency_key = $1 AND user_id = $2 AND resource_type = 'task'
                  AND expires_at > NOW()
                """,
                request.idempotency_key.strip(), user.user_id,
            )
            if existing:
                existing_task = await conn.fetchrow(
                    "SELECT task_id, status, attempt_count FROM tasks WHERE task_id = $1::uuid AND created_by = $2",
                    str(existing["resource_id"]), user.user_id,
                )
                if existing_task:
                    return SubmitTaskBundleResponse(
                        task_id=str(existing_task["task_id"]),
                        status=existing_task["status"],
                        attempt_count=int(existing_task["attempt_count"] or 0),
                        duplicate=True,
                    )
        raise HTTPException(status_code=409, detail="Task draft is no longer available")
    if draft["status"] not in {"draft", "awaiting_user_confirmation", "revising"}:
        raise HTTPException(status_code=409, detail="Task draft is no longer available")

    session_root = _get_session_root(str(draft["session_id"])).resolve()
    method_filename = str(draft.get("method_filename") or "execution-document.md")
    method_filename = FilePath(method_filename).name
    method_path: Optional[FilePath] = None
    if draft.get("method_path"):
        method_relative = safe_relative_path(str(draft["method_path"]))
        method_path = ensure_within(session_root, session_root / method_relative)
        if not method_path.is_file() or method_path.is_symlink():
            raise HTTPException(status_code=409, detail="Execution document is no longer available")

    if request.method_content is not None:
        method_content = request.method_content.replace("\x00", "")
        method_bytes = method_content.encode("utf-8")
        if not method_bytes.strip():
            raise HTTPException(status_code=400, detail="Execution document cannot be empty")
        if len(method_bytes) > TASK_INPUT_MAX_BYTES:
            raise HTTPException(status_code=413, detail="Execution document exceeds the 25 MB limit")
        if method_path is None:
            method_path = ensure_within(
                session_root,
                session_root / "task-drafts" / draft_id / "revisions" / "confirmed" / method_filename,
            )
            method_path.parent.mkdir(parents=True, exist_ok=True)
        method_path.write_bytes(method_bytes)
    if method_path is None:
        raise HTTPException(status_code=400, detail="Execution document is required before confirming")
    method_bytes = method_path.read_bytes()
    if len(method_bytes) > TASK_INPUT_MAX_BYTES:
        raise HTTPException(status_code=413, detail="Execution document exceeds the 25 MB limit")
    method_hash = hashlib.sha256(method_bytes).hexdigest()
    method_preview = method_bytes.decode("utf-8", errors="replace")[:12000]
    if FilePath(method_filename).suffix.lower() not in {".md", ".txt"}:
        raise HTTPException(status_code=400, detail="Execution document must be Markdown or text")
    dataset_resource_id = str(request.dataset_resource_id or draft.get("dataset_resource_id") or "").strip()
    if not dataset_resource_id:
        raise HTTPException(status_code=400, detail="Please provide a dataset before confirming")
    try:
        resource = await _get_project_resource(pool, dataset_resource_id, user.user_id)
    except Exception as exc:
        raise HTTPException(status_code=404, detail="Dataset resource not found") from exc
    if not resource or resource["project_id"] != draft["project_id"] or resource["kind"] != "dataset":
        raise HTTPException(status_code=404, detail="Dataset resource not found")
    if int(resource.get("file_size_bytes") or 0) > TASK_INPUT_MAX_BYTES:
        raise HTTPException(status_code=413, detail="Dataset exceeds the 25 MB limit")
    resource_path = _safe_storage_path(
        FilePath(os.getenv("RESOURCE_STORAGE_ROOT", "/workspace/resources")),
        str(resource["storage_key"]),
    )
    if not resource_path.is_file() or resource_path.is_symlink():
        raise HTTPException(status_code=404, detail="Dataset resource not found")
    dataset_size_bytes = resource_path.stat().st_size
    if dataset_size_bytes > TASK_INPUT_MAX_BYTES:
        raise HTTPException(status_code=413, detail="Dataset exceeds the 25 MB limit")
    dataset_hasher = hashlib.sha256()
    with resource_path.open("rb") as dataset_handle:
        for chunk in iter(lambda: dataset_handle.read(1024 * 1024), b""):
            dataset_hasher.update(chunk)
    dataset_hash = dataset_hasher.hexdigest()
    validation_result = _validate_dataset_file(resource_path, resource["logical_name"])
    if not validation_result.get("passed"):
        raise HTTPException(status_code=400, detail="Dataset validation failed")

    title = (request.title or draft["title"] or FilePath(method_filename).stem).strip()[:255]
    request_hash = hashlib.sha256(json.dumps({
        "draft_id": draft_id,
        "revision": draft["revision"],
        "title": title,
        "method_hash": method_hash,
        "dataset_resource_id": dataset_resource_id,
        "dataset_hash": dataset_hash,
    }, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()
    task_spec_id = str(uuid.uuid4())
    method_source_id = str(uuid.uuid4())
    dataset_snapshot_id = str(uuid.uuid4())
    task_id = str(uuid.uuid4())
    # Legacy schema compatibility only. New tasks have one public Worker
    # execution policy; this value is not derived from the requesting user.
    required_trust = "general"
    method_upload_root = FilePath(os.getenv("METHOD_SOURCE_UPLOAD_ROOT", "/tmp/uploaded-method-sources")).resolve()
    method_final_path = method_upload_root / "documents" / f"{draft_id}-{FilePath(method_filename).name}"
    method_final_created = False

    try:
        async with pool.acquire() as conn:
            async with conn.transaction():
                existing = await conn.fetchrow(
                    """
                    SELECT resource_id, request_hash
                    FROM idempotency_keys
                    WHERE idempotency_key = $1 AND user_id = $2 AND resource_type = 'task'
                      AND expires_at > NOW()
                    FOR UPDATE
                    """,
                    request.idempotency_key.strip(), user.user_id,
                )
                if existing:
                    if existing["request_hash"] and existing["request_hash"] != request_hash:
                        raise HTTPException(status_code=409, detail="Idempotency key was reused with a different draft")
                    existing_task = await conn.fetchrow(
                        "SELECT task_id, status, attempt_count FROM tasks WHERE task_id = $1::uuid AND created_by = $2",
                        str(existing["resource_id"]), user.user_id,
                    )
                    if existing_task:
                        return SubmitTaskBundleResponse(
                            task_id=str(existing_task["task_id"]),
                            status=existing_task["status"],
                            attempt_count=int(existing_task["attempt_count"] or 0),
                            duplicate=True,
                        )
                    raise HTTPException(status_code=409, detail="Idempotency record points to a missing task")

                method_final_path.parent.mkdir(parents=True, exist_ok=True)
                method_final_path.write_bytes(method_bytes)
                method_final_created = True

                task_spec_json = draft["task_spec"] if isinstance(draft["task_spec"], dict) else {}
                task_spec_json = {**task_spec_json, "goal_summary": draft["goal_summary"], "draft_id": draft_id}
                await conn.execute(
                    """
                    INSERT INTO task_specs (
                        task_spec_id, project_id, revision, title, domain, analysis_type,
                        research_question, spec_json, schema_version, status, created_by, frozen_at
                    ) VALUES ($1::uuid, $2::uuid, 1, $3, 'bioinformatics', 'goal_driven', $4,
                              $5::jsonb, '1.0', 'active', $6, NOW())
                    """,
                    task_spec_id, str(draft["project_id"]), title, draft["goal_summary"],
                    json.dumps(task_spec_json, ensure_ascii=False), user.user_id,
                )
                await conn.execute(
                    """
                    INSERT INTO method_sources (
                        method_source_id, project_id, task_spec_id, original_filename,
                        stored_path, content_type, file_size_bytes, file_hash_sha256
                    ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, 'text/markdown', $6, $7)
                    """,
                    method_source_id, str(draft["project_id"]), task_spec_id, method_filename,
                    str(method_final_path), len(method_bytes), method_hash,
                )
                await conn.execute(
                    """
                    INSERT INTO dataset_snapshots (
                        dataset_snapshot_id, task_spec_id, project_id, original_filename,
                        stored_path, file_size_bytes, file_hash_sha256, validation_result,
                        validation_passed, version
                    ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8::jsonb, TRUE, 1)
                    """,
                    dataset_snapshot_id, task_spec_id, str(draft["project_id"]), resource["logical_name"],
                    str(resource_path), dataset_size_bytes, dataset_hash,
                    json.dumps(validation_result, ensure_ascii=False),
                )
                task_row = await conn.fetchrow(
                    """
                    INSERT INTO tasks (
                        task_id, task_spec_id, dataset_snapshot_id, project_id, method_source_id,
                        title, status, max_attempts, required_trust_level, created_by
                    ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, 'queued', 3, $7, $8)
                    RETURNING task_id, status, attempt_count
                    """,
                    task_id, task_spec_id, dataset_snapshot_id, str(draft["project_id"]),
                    method_source_id, title, required_trust, user.user_id,
                )
                await conn.execute(
                    """
                    INSERT INTO idempotency_keys (idempotency_key, user_id, resource_type, resource_id, request_hash, expires_at)
                    VALUES ($1, $2, 'task', $3::uuid, $4, NOW() + INTERVAL '24 hours')
                    """,
                    request.idempotency_key.strip(), user.user_id, task_id, request_hash,
                )
                task_event = await conn.fetchrow(
                    """
                    INSERT INTO task_events (task_id, task_attempt_id, event_type, event_data, created_at)
                    VALUES ($1::uuid, NULL, 'task_queued', $2::jsonb, NOW())
                    RETURNING task_event_id
                    """,
                    task_id,
                    json.dumps({"task_id": task_id, "status": "queued"}),
                )
                if not task_event:
                    raise RuntimeError("task lifecycle event was not created")
                await conn.execute(
                    """
                    INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload, status)
                    VALUES ('task', $1::uuid, 'task_queued', $2::jsonb, 'pending')
                    """,
                    task_id, json.dumps({
                        "task_id": task_id,
                        "task_event_id": task_event["task_event_id"],
                        "status": "queued",
                    }),
                )
                await conn.execute(
                    """
                    UPDATE task_drafts
                    SET status = 'confirmed', confirmed_task_id = $2::uuid, revision = revision + 1,
                        method_path = $4, method_filename = $5, method_preview = $6,
                        method_size_bytes = $7, method_hash_sha256 = $8,
                        dataset_resource_id = $9::uuid, dataset_filename = $10,
                        dataset_size_bytes = $11, dataset_hash_sha256 = $12,
                        missing_inputs = '[]'::jsonb, updated_at = NOW()
                    WHERE draft_id = $1::uuid AND owner_user_id = $3
                    """,
                    draft_id, task_id, user.user_id, str(draft.get("method_path") or ""),
                    method_filename, method_preview, len(method_bytes), method_hash,
                    dataset_resource_id, resource["logical_name"], dataset_size_bytes, dataset_hash,
                )
    except Exception:
        if method_final_created:
            method_final_path.unlink(missing_ok=True)
        raise
    return SubmitTaskBundleResponse(
        task_id=str(task_row["task_id"]),
        status=task_row["status"],
        attempt_count=int(task_row["attempt_count"] or 0),
    )


@app.post("/api/tasks", response_model=Dict[str, Any])
async def create_task_endpoint(
    request: CreateTaskRequest,
    user: Optional[Principal] = Depends(_require_task_api_key),
):
    """Create a new task with idempotency support."""
    pool = app.state.db_pool

    # The authenticated confirmation path is atomic and requires a user-scoped
    # idempotency key.  It never creates a second endpoint-level Outbox row.
    if user:
        if not request.idempotency_key:
            raise HTTPException(status_code=400, detail="idempotency_key is required")
        request_hash = hashlib.sha256(request.model_dump_json(exclude={"idempotency_key"}, exclude_none=True).encode()).hexdigest()
        task = Task(
            task_id=str(uuid.uuid4()),
            task_spec_id=request.task_spec_id,
            dataset_snapshot_id=request.dataset_snapshot_id,
            project_id=request.project_id,
            method_source_id=request.method_source_id,
            title=request.title,
            status="queued",
            max_attempts=request.max_attempts,
            # Legacy schema compatibility only; all Workers use the same
            # public-pool execution policy.
            required_trust_level="general",
            created_by=user.user_id,
        )
        try:
            result, is_new = await submit_task_atomically(
                pool,
                task,
                user_id=user.user_id,
                idempotency_key=request.idempotency_key,
                request_hash=request_hash,
            )
        except PermissionError:
            raise HTTPException(status_code=404, detail="Project or input not found")
        except ValueError as exc:
            detail = str(exc)
            raise HTTPException(status_code=409 if "idempotency" in detail else 400, detail=detail)
        return {
            "task_id": result.task_id,
            "status": result.status,
            "attempt_count": result.attempt_count,
            "duplicate": not is_new,
        }

    # Legacy open local-test path; it is disabled in acceptance/production.
    # Check idempotency
    if request.idempotency_key:
        existing = await check_idempotency(pool, request.idempotency_key)
        if existing and existing["resource_type"] == "task":
            existing_task = await get_task(pool, existing["resource_id"])
            if existing_task:
                return {
                    "task_id": existing_task["task_id"],
                    "status": existing_task["status"],
                    "duplicate": True,
                }

    task = Task(
        task_id=str(uuid.uuid4()),
        task_spec_id=request.task_spec_id,
        dataset_snapshot_id=request.dataset_snapshot_id,
        project_id=request.project_id,
        method_source_id=request.method_source_id,
        title=request.title,
        status="queued",
        max_attempts=request.max_attempts,
    )

    result, is_new = await create_task(pool, task, idempotency_key=request.idempotency_key)

    # Publish to outbox if new (legacy compatibility only)
    if is_new and result.task_id:
        try:
            await create_outbox_event(
                pool,
                aggregate_type="task",
                aggregate_id=result.task_id,
                event_type="task_queued",
                payload={"task_id": result.task_id, "status": "queued"},
            )
        except Exception:
            pass  # Outbox will be picked up by publisher

    return {
        "task_id": result.task_id,
        "status": result.status,
        "attempt_count": result.attempt_count,
        "duplicate": False,
    }


@app.get("/api/tasks/{task_id}")
async def get_task_endpoint(task_id: str, user: Optional[Principal] = Depends(_require_task_api_key)):
    """Get task details."""
    pool = app.state.db_pool
    task = await get_task(pool, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    if user and task.get("created_by") != user.user_id:
        raise HTTPException(status_code=404, detail="Task not found")
    return _public_task(task)


@app.get("/api/tasks/{task_id}/events", response_model=List[TaskEventResponse])
async def get_task_events_endpoint(
    task_id: str,
    limit: int = Query(100, ge=1, le=500),
    user: Optional[Principal] = Depends(_require_task_api_key),
):
    """Get task events."""
    pool = app.state.db_pool
    task = await get_task(pool, task_id)
    if not task or (user and task.get("created_by") != user.user_id):
        raise HTTPException(status_code=404, detail="Task not found")
    events = await get_task_events(pool, task_id, limit=limit)
    return events


@app.get("/api/tasks/{task_id}/artifacts", response_model=List[ArtifactResponse])
async def get_task_artifacts_endpoint(task_id: str, user: Optional[Principal] = Depends(_require_task_api_key)):
    """Get task artifacts."""
    pool = app.state.db_pool
    task = await get_task(pool, task_id)
    if not task or (user and task.get("created_by") != user.user_id):
        raise HTTPException(status_code=404, detail="Task not found")
    artifacts = await get_artifacts_for_task(pool, task_id)
    return artifacts


def _validate_artifact_path(storage_path: str) -> FilePath:
    """Validate an artifact storage path for safe download.

    Rejects symlinks, path traversal, and paths outside the allowed root.
    """
    allowed_root = FilePath(os.getenv("ARTIFACT_DOWNLOAD_ROOT", "/workspace/task-outputs")).resolve()
    original = FilePath(storage_path)
    if not original.is_absolute():
        raise HTTPException(status_code=403, detail="Artifact path must be absolute")
    try:
        # Check the lexical path before resolving it. This catches a raw
        # root/../secret path instead of letting normalization hide traversal.
        relative = original.relative_to(allowed_root)
    except ValueError:
        raise HTTPException(status_code=403, detail="Artifact path is outside the allowed directory")
    if ".." in relative.parts:
        raise HTTPException(status_code=403, detail="Artifact path traversal is not allowed")
    current = allowed_root
    for part in relative.parts:
        current = current / part
        try:
            if current.is_symlink():
                raise HTTPException(status_code=403, detail="Symlinked artifacts are not allowed")
        except OSError as exc:
            raise HTTPException(status_code=404, detail="Artifact file not found") from exc
    try:
        resolved = original.resolve(strict=False)
        resolved.relative_to(allowed_root)
    except (OSError, ValueError) as exc:
        raise HTTPException(status_code=403, detail="Artifact path is outside the allowed directory") from exc
    if not resolved.is_file():
        raise HTTPException(status_code=404, detail="Artifact file not found")
    return resolved


@app.get("/api/artifacts/{artifact_id}")
async def download_artifact_endpoint(artifact_id: str, user: Optional[Principal] = Depends(_require_task_api_key)):
    """Download an artifact ZIP file."""
    pool = app.state.db_pool
    artifact = await get_artifact(pool, artifact_id)
    if not artifact:
        raise HTTPException(status_code=404, detail="Artifact not found")
    if user:
        task = await get_task(pool, str(artifact.get("task_id")))
        if not task or task.get("created_by") != user.user_id:
            raise HTTPException(status_code=404, detail="Artifact not found")

    storage_path = artifact.get("storage_path") or ""
    if not storage_path:
        raise HTTPException(status_code=404, detail="Artifact has no storage path")

    resolved = _validate_artifact_path(storage_path)
    return FileResponse(
        str(resolved),
        media_type=artifact.get("content_type") or "application/zip",
        filename=f"{artifact.get('name', 'artifact')}.zip",
    )


@app.post("/api/tasks/{task_id}/cancel")
async def cancel_task_endpoint(task_id: str, user: Optional[Principal] = Depends(_require_task_api_key)):
    """Cancel a running or queued task."""
    pool = app.state.db_pool
    task = await get_task(pool, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    if user and task.get("created_by") != user.user_id:
        raise HTTPException(status_code=404, detail="Task not found")
    if task["status"] not in ("queued", "claimed", "running"):
        raise HTTPException(status_code=400, detail=f"Cannot cancel task in status: {task['status']}")

    if task["status"] in ("queued",):
        result = await update_task_status(pool, task_id, TaskStatus.CANCELLED)
        if not result:
            raise HTTPException(status_code=400, detail="Failed to cancel task")
        return {"task_id": task_id, "status": "cancelled"}

    # For claimed/running tasks, request cancellation so the worker can
    # gracefully stop the Docker container before finalizing the status.
    result = await request_cancel_task(pool, task_id)
    if not result:
        raise HTTPException(status_code=400, detail="Failed to request cancellation")
    return {"task_id": task_id, "status": result["status"], "cancel_requested": True}


@app.get("/api/tasks")
async def list_tasks_endpoint(
    project_id: Optional[str] = None,
    limit: int = Query(50, ge=1, le=100),
    user: Optional[Principal] = Depends(_require_task_api_key),
):
    """List tasks, optionally filtered by project."""
    pool = app.state.db_pool
    if project_id:
        if user and not await user_can_access_project(pool, project_id, user.user_id):
            raise HTTPException(status_code=404, detail="Project not found")
        tasks = await get_tasks_by_project(
            pool,
            project_id,
            limit=limit,
            user_id=user.user_id if user else None,
        )
    else:
        # Return all recent tasks
        query = """
            SELECT task_id, task_spec_id, dataset_snapshot_id, project_id, method_source_id, title,
                   status, lease_owner, lease_token, lease_expires_at,
                   active_attempt_id, attempt_count, max_attempts,
                   result_artifact_id, error_message, created_by,
                   created_at, updated_at, finished_at
            FROM tasks
            WHERE ($1::text IS NULL OR created_by = $1)
            ORDER BY created_at DESC
            LIMIT $2
        """
        async with pool.acquire() as conn:
            rows = await conn.fetch(query, user.user_id if user else None, limit)
        tasks = [_public_task(_task_row_to_dict(row)) for row in rows]
    if project_id:
        tasks = [_public_task(task) for task in tasks]
    return {"tasks": tasks}


# ---- SSE endpoint for task events ----


def _decode_sse_resume_cursor(value: Optional[str]) -> tuple[Optional[str], Optional[int]]:
    """Split the Redis cursor from the durable DB event ID when available."""
    raw = str(value or "").strip()
    if not raw:
        return None, None
    match = re.fullmatch(r"(.+)\|db:(\d+)", raw)
    if match:
        return match.group(1), int(match.group(2))
    return raw, None

@app.get("/api/tasks/{task_id}/events/stream")
async def task_events_sse_endpoint(
    task_id: str,
    request: Request = None,  # type: ignore[assignment]
    last_event_id: Optional[str] = None,
    user: Optional[Principal] = Depends(_require_task_api_key),
):
    """SSE endpoint for real-time task events."""
    async def event_generator():
        pool = app.state.db_pool
        task = await get_task(pool, task_id)
        if not task or (user and task.get("created_by") != user.user_id):
            return
        # EventSource reconnects with the Last-Event-ID header.  Keep the
        # query parameter for explicit clients, but prefer the browser header
        # when it is present.
        resume_event_id = last_event_id or (request.headers.get("last-event-id") if request else None)
        redis_resume_cursor, db_resume_id = _decode_sse_resume_cursor(resume_event_id)
        redis = get_redis_client()

        # Heartbeat: yield a ": keep-alive" comment every 15s so proxies and
        # browsers don't time out idle connections. Close the stream after a
        # bounded lifetime (default 2h); the frontend reconnects automatically
        # with last_event_id, so no events are lost.
        keepalive_seconds = 15.0
        max_connection_seconds = float(os.getenv("SSE_MAX_CONNECTION_SECONDS", "7200"))
        started_at = time.monotonic()
        last_activity = started_at

        # Send initial state
        task = await get_task(pool, task_id)
        if not task:
            yield {"event": "error", "data": json.dumps({"message": "Task not found"})}
            return

        yield {
            "event": "task_state",
            "data": json.dumps({
                "task_id": task_id,
                "status": task["status"],
                "attempt_count": task["attempt_count"],
            }),
        }

        # If Redis is available, stream from there
        if redis and redis.is_connected:
            # Keep the request argument immutable inside the async generator.
            # Assigning to ``last_event_id`` here would make it a local
            # closure variable and crash before the first Redis read.
            event_cursor = redis_resume_cursor
            seen_ids = set()
            emitted_durable_ids: set[int] = set()
            if event_cursor:
                seen_ids.add(event_cursor)

            while True:
                events = await redis.read_task_events(task_id, last_event_id=event_cursor, count=20)
                for event in events:
                    cursor_only = event.get("_cursor_only")
                    if cursor_only:
                        event_cursor = str(cursor_only)
                        continue
                    msg_id = event.get("_message_id", "")
                    if msg_id in seen_ids:
                        continue
                    seen_ids.add(msg_id)
                    event_cursor = str(event.get("_stream_cursor") or msg_id)

                    durable_event_id = event.get("task_event_id")
                    if durable_event_id is None and isinstance(event.get("data"), dict):
                        durable_event_id = event["data"].get("task_event_id")
                    sse_id = msg_id
                    if durable_event_id is not None:
                        try:
                            durable_event_id = int(durable_event_id)
                            emitted_durable_ids.add(durable_event_id)
                            sse_id = f"{msg_id}|db:{durable_event_id}"
                        except (TypeError, ValueError):
                            pass

                    yield {
                        "event": event.get("event_type", "update"),
                        "id": sse_id,
                        "data": json.dumps(event),
                    }

                # Check if task is terminal
                if task["status"] in ("succeeded", "failed", "cancelled", "timeout"):
                    # Redis is a fan-out cache, not the source of truth.  A
                    # bounded scan of a shared stream can advance past this
                    # task's final event, so reconcile the durable DB event
                    # log before closing the terminal SSE response.
                    try:
                        durable_after = max(
                            int(db_resume_id or 0),
                            max(emitted_durable_ids, default=0),
                        )
                        durable_events = await get_task_events(
                            pool, task_id, limit=500, after_id=durable_after
                        )
                        for durable_event in durable_events:
                            durable_id = int(durable_event["task_event_id"])
                            if durable_id in emitted_durable_ids:
                                continue
                            emitted_durable_ids.add(durable_id)
                            yield {
                                "event": durable_event["event_type"],
                                "id": f"db:{durable_id}",
                                "data": json.dumps(durable_event),
                            }
                    except Exception:
                        logger.exception("Failed to reconcile terminal task events for %s", task_id)
                    yield {"event": "task_terminal", "data": json.dumps({"status": task["status"]})}
                    break

                if time.monotonic() - started_at >= max_connection_seconds:
                    break
                if events:
                    last_activity = time.monotonic()
                elif time.monotonic() - last_activity >= keepalive_seconds:
                    yield {"comment": "keep-alive"}
                    last_activity = time.monotonic()

                await asyncio.sleep(0.5)
                # Refresh task status
                task = await get_task(pool, task_id)
                if not task:
                    break
        else:
            # Fallback: poll database events
            try:
                last_id = max(0, db_resume_id if db_resume_id is not None else int(resume_event_id or "0"))
            except (TypeError, ValueError):
                # Older Redis messages may not carry a durable DB event ID.
                # There is no safe numeric translation for those legacy
                # cursors, so retain the conservative replay behavior. New
                # outbox messages use the composite id above and resume
                # without replaying persisted events.
                last_id = 0
            while True:
                events = await get_task_events(pool, task_id, limit=50, after_id=last_id)
                for event in events:
                    eid = event.get("task_event_id", 0)
                    if eid > last_id:
                        last_id = eid
                        yield {
                            "event": event.get("event_type", "update"),
                            "id": str(eid),
                            "data": json.dumps(event),
                        }

                task = await get_task(pool, task_id)
                if not task or task["status"] in ("succeeded", "failed", "cancelled", "timeout"):
                    break
                if time.monotonic() - started_at >= max_connection_seconds:
                    break
                if events:
                    last_activity = time.monotonic()
                elif time.monotonic() - last_activity >= keepalive_seconds:
                    yield {"comment": "keep-alive"}
                    last_activity = time.monotonic()
                await asyncio.sleep(1)

    return EventSourceResponse(event_generator())


# ---- Worker API endpoints ----

@app.post("/api/worker/poll")
async def worker_poll_endpoint(request: Request, _: Optional[Principal] = Depends(_require_task_api_key)):
    """Development-only compatibility poll endpoint.

    Deployed Workers consume the authenticated Redis stream.  Keeping a
    public SQL poller enabled in acceptance/production would allow any
    session or leaked legacy API key to enumerate other users' queued tasks.
    """
    if os.getenv("APP_ENV", "development").lower() not in {"development", "dev", "test"} or not _env_flag("LOCAL_DEV_OPEN_TASK_API", False):
        raise HTTPException(status_code=404, detail="Worker SQL polling is disabled; use the Redis Worker stream")
    pool = app.state.db_pool
    query = """
        SELECT task_id, title, status, task_spec_id, dataset_snapshot_id, project_id
        FROM tasks
        WHERE status = 'queued'
          AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
        ORDER BY created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
    """
    async with pool.acquire() as conn:
        row = await conn.fetchrow(query)
    if not row:
        return {"available": False}
    return {
        "available": True,
        "task_id": str(row["task_id"]),
        "task_spec_id": str(row["task_spec_id"]),
        "dataset_snapshot_id": str(row["dataset_snapshot_id"]),
        "project_id": str(row["project_id"]),
        "title": row["title"],
    }


@app.post("/api/outbox/publish")
async def publish_outbox_endpoint(user: Optional[Principal] = Depends(_require_task_api_key)):
    """Manually trigger outbox publishing.

    Requires a connected Redis: events are only marked published after they
    are actually delivered to the stream. When Redis is down the request is
    rejected (503) — silently marking events published would lose them.
    """
    if not user and not (
        os.getenv("APP_ENV", "development").lower() in {"development", "dev", "test"}
        and _env_flag("LOCAL_DEV_OPEN_TASK_API", False)
    ):
        raise HTTPException(status_code=403, detail="Operator permission required")
    if user and not _worker_enrollment_admin_allowed(user):
        raise HTTPException(status_code=403, detail="Operator permission required")
    redis = get_redis_client()
    if not redis or not redis.is_connected:
        raise HTTPException(
            status_code=503,
            detail="Redis unavailable; outbox events are kept pending for automatic recovery",
        )
    pool = app.state.db_pool
    publisher = getattr(app.state, "outbox_publisher", None)
    if publisher is not None:
        processed = await publisher._publish_batch()
    else:
        # No in-process publisher (e.g. tests) — run one ad-hoc batch.
        from backend.code_agent.outbox import OutboxPublisher
        processed = await OutboxPublisher(pool, redis)._publish_batch()
    return {"processed": processed, "mode": "redis"}


@app.get("/api/worker/health")
async def worker_health_endpoint(user: Optional[Principal] = Depends(_require_task_api_key)):
    """Health check for workers."""
    if not user and not (
        os.getenv("APP_ENV", "development").lower() in {"development", "dev", "test"}
        and _env_flag("LOCAL_DEV_OPEN_TASK_API", False)
    ):
        raise HTTPException(status_code=403, detail="Operator permission required")
    if user and not _worker_enrollment_admin_allowed(user):
        raise HTTPException(status_code=403, detail="Operator permission required")
    redis = get_redis_client()
    workers = []
    if redis and redis.is_connected:
        workers = await redis.get_alive_workers()
    return {
        "status": "healthy",
        "redis_connected": redis.is_connected if redis else False,
        "active_workers": workers,
    }


# ---- Helpers ----

def _row_optional(row: Any, key: str) -> Any:
    try:
        return row[key]
    except (KeyError, IndexError, TypeError, AttributeError):
        return None

def _task_row_to_dict(row: Any) -> Dict[str, Any]:
    """Convert a task row to a dictionary."""
    return {
        "task_id": str(row["task_id"]),
        "task_spec_id": str(row["task_spec_id"]),
        "dataset_snapshot_id": str(row["dataset_snapshot_id"]),
        "project_id": str(row["project_id"]),
        "method_source_id": str(_row_optional(row, "method_source_id")) if _row_optional(row, "method_source_id") else None,
        "title": row["title"],
        "status": row["status"],
        "lease_owner": row["lease_owner"],
        "lease_token": row["lease_token"],
        "lease_expires_at": row["lease_expires_at"].isoformat() if row["lease_expires_at"] else None,
        "active_attempt_id": row["active_attempt_id"],
        "attempt_count": row["attempt_count"],
        "max_attempts": row["max_attempts"],
        "result_artifact_id": row["result_artifact_id"],
        "error_message": row["error_message"],
        "created_by": row["created_by"],
        "created_at": row["created_at"].isoformat() if row["created_at"] else None,
        "updated_at": row["updated_at"].isoformat() if row["updated_at"] else None,
        "finished_at": row["finished_at"].isoformat() if row["finished_at"] else None,
    }


def _public_task(task: Dict[str, Any]) -> Dict[str, Any]:
    """Remove lease and worker-internal fields from browser responses."""
    return {key: value for key, value in task.items() if key not in {"lease_token"}}
