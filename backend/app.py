from fastapi import FastAPI, Depends, HTTPException, Request, WebSocket, WebSocketDisconnect, UploadFile, File, Form
from fastapi.responses import FileResponse, RedirectResponse, StreamingResponse, JSONResponse
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
import mimetypes
import json
import hashlib
import secrets
import time
from agent.util import estimate_tokens
import uuid

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
    list_session_uploaded_papers,
    insert_session_tool_call,
    get_recent_session_tool_calls,
    get_recent_tool_calls_keep_from_id,
    get_tool_calls_for_compression,
    upsert_session_context_compression_state,
    update_session_context_compression_state,
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
from backend.security import redact_secrets, safe_relative_path
from backend.security import validate_outbound_url
from backend.secrets import decrypt_secret, encrypt_secret, secret_fingerprint

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
    app.state.token_verifier = TokenVerifier()

    # Ensure the default project exists (design doc §13.1).
    try:
        from backend.code_agent.task_service import ensure_default_project
        await ensure_default_project(app.state.db_pool)
    except Exception as exc:
        logger.warning("Could not ensure default project: %s", exc)
    app.state.session_agents = {}
    app.state.session_meta = {}
    app.state.oauth_states = {}

    # Start Outbox Publisher if Redis is available
    try:
        from backend.code_agent.outbox import OutboxPublisher
        from backend.code_agent.redis_client import RedisClient
        redis_url = os.getenv("REDIS_URL", "redis://localhost:6379/0")
        redis_client = RedisClient(redis_url)
        await redis_client.connect()
        if redis_client.is_connected:
            app.state.outbox_publisher = OutboxPublisher(
                app.state.db_pool, redis_client, poll_interval=1.0
            )
            await app.state.outbox_publisher.start()
            app.state.redis_client = redis_client
            logger.info("Outbox Publisher started")
        else:
            app.state.outbox_publisher = None
            app.state.redis_client = None
    except Exception as exc:
        logger.warning("Outbox Publisher not started: %s", exc)
        app.state.outbox_publisher = None
        app.state.redis_client = None

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
    await close_db(app)

app = FastAPI(lifespan=lifespan)


def _safe_return_to(value: Optional[str]) -> str:
    candidate = str(value or "/").strip()
    if not candidate.startswith("/") or candidate.startswith("//"):
        return "/"
    return candidate


def _cookie_secure() -> bool:
    return _env_flag("COOKIE_SECURE", os.getenv("APP_ENV", "development").lower() in {"production", "prod"})


async def _record_principal(principal: Principal) -> None:
    """Persist the issuer/subject mapping without storing bearer credentials."""
    pool = getattr(app.state, "db_pool", None)
    if pool is None:
        return
    try:
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


def _set_session_cookie(response, principal: Principal) -> None:
    response.set_cookie(
        SESSION_COOKIE_NAME,
        create_session_cookie(principal),
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


@app.get("/auth/login")
async def auth_login(request: Request, return_to: str = "/"):
    """Start Authorization Code + PKCE; acceptance can use the local OIDC spy."""
    safe_return = _safe_return_to(return_to)
    dev_login = _env_flag("AUTH_DEV_LOGIN_ENABLED", False)
    authorization_url = "/auth/dev/authorize" if dev_login else os.getenv("OIDC_AUTHORIZATION_URL", "").strip()
    client_id = "local-oidc-client" if dev_login else os.getenv("OIDC_CLIENT_ID", "").strip()
    if not authorization_url or not client_id:
        raise HTTPException(status_code=503, detail="OIDC login is not configured")
    state = secrets.token_urlsafe(32)
    nonce = secrets.token_urlsafe(32)
    verifier = secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    request.app.state.oauth_states[state] = {
        "verifier": verifier,
        "nonce": nonce,
        "return_to": safe_return,
        "expires_at": time.time() + 600,
    }
    from urllib.parse import urlencode
    redirect_uri = os.getenv("OIDC_REDIRECT_URI", str(request.url_for("auth_callback")))
    query = urlencode({
        "response_type": "code",
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "scope": os.getenv("OIDC_SCOPE", "openid profile email"),
        "state": state,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "nonce": nonce,
    })
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
    if not _env_flag("AUTH_DEV_LOGIN_ENABLED", False):
        raise HTTPException(status_code=404, detail="Not found")
    if client_id != "local-oidc-client" or code_challenge_method != "S256" or not code_challenge:
        raise HTTPException(status_code=400, detail="Invalid PKCE request")
    expected_redirect = os.getenv("OIDC_REDIRECT_URI", str(request.url_for("auth_callback")))
    if redirect_uri != expected_redirect:
        raise HTTPException(status_code=400, detail="Invalid redirect URI")
    if not re.fullmatch(r"[A-Za-z0-9._@:-]{1,128}", user_id):
        raise HTTPException(status_code=400, detail="Invalid local user ID")
    state_data = request.app.state.oauth_states.get(state)
    if not state_data or state_data.get("nonce") != nonce or state_data.get("code_challenge") not in {None, code_challenge}:
        raise HTTPException(status_code=400, detail="Invalid OIDC state")
    state_data["code_challenge"] = code_challenge
    from urllib.parse import urlencode
    return RedirectResponse(
        url=f"{redirect_uri}?{urlencode({'code': f'dev:{user_id}', 'state': state})}",
        status_code=303,
    )


@app.get("/auth/dev/login")
async def auth_dev_login(return_to: str = "/", user_id: str = "alice"):
    """Local-only login endpoint used by deterministic acceptance tests."""
    if not _env_flag("AUTH_DEV_LOGIN_ENABLED", False):
        raise HTTPException(status_code=404, detail="Not found")
    if not re.fullmatch(r"[A-Za-z0-9._@:-]{1,128}", user_id):
        raise HTTPException(status_code=400, detail="Invalid local user ID")
    principal = Principal(user_id=user_id, issuer="local-oidc-spy", subject=user_id)
    await _record_principal(principal)
    response = RedirectResponse(url=_safe_return_to(return_to), status_code=303)
    _set_session_cookie(response, principal)
    return response


@app.get("/auth/callback", name="auth_callback")
async def auth_callback(request: Request, code: str, state: str, error: Optional[str] = None):
    if error:
        raise HTTPException(status_code=401, detail="OIDC authorization was denied")
    state_cookie = request.cookies.get("oidc_state")
    state_data = request.app.state.oauth_states.pop(state, None)
    if not state_data or state_cookie != state or float(state_data.get("expires_at", 0)) <= time.time():
        raise HTTPException(status_code=400, detail="Invalid or expired OIDC state")
    if _env_flag("AUTH_DEV_LOGIN_ENABLED", False) and code.startswith("dev:"):
        if not state_data.get("code_challenge"):
            raise HTTPException(status_code=400, detail="PKCE verification failed")
        principal_id = code[4:] or "local-user"
        if not re.fullmatch(r"[A-Za-z0-9._@:-]{1,128}", principal_id):
            raise HTTPException(status_code=401, detail="Invalid local authorization code")
        principal = Principal(user_id=principal_id, issuer="local-oidc-spy", subject=principal_id)
    else:
        token_url = os.getenv("OIDC_TOKEN_URL", "").strip()
        if not token_url:
            raise HTTPException(status_code=503, detail="OIDC token endpoint is not configured")
        import httpx
        redirect_uri = os.getenv("OIDC_REDIRECT_URI", str(request.url_for("auth_callback")))
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
    _set_session_cookie(response, principal)
    return response


@app.get("/auth/me")
async def auth_me(user: Principal = Depends(require_user)):
    return {"user_id": user.user_id, "issuer": user.issuer, "subject": user.subject, "email": user.email}


@app.get("/auth/logout")
@app.post("/auth/logout")
async def auth_logout(return_to: str = "/"):
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
        "https://infinity.zhangyvjing.com,http://localhost:3000,http://127.0.0.1:3000,http://127.0.0.1:3010",
    ).split(",")
    if origin.strip()
]

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
        if origin and origin not in _CORS_ORIGINS:
            return JSONResponse({"detail": "Cross-origin state change rejected"}, status_code=403)
        csrf_cookie = request.cookies.get(CSRF_COOKIE_NAME)
        csrf_header = request.headers.get("x-csrf-token")
        if not csrf_cookie or not csrf_header or not hmac.compare_digest(csrf_cookie, csrf_header):
            return JSONResponse({"detail": "CSRF token required"}, status_code=403)
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

    existing = await list_session_uploaded_papers(pool, session_id)
    if len(existing) >= _MAX_SESSION_UPLOAD_PAPERS:
        raise HTTPException(status_code=400, detail=f"Upload limit exceeded: max {_MAX_SESSION_UPLOAD_PAPERS} papers per session")

    session_root = _get_session_root(session_id)
    uploads_dir = session_root / "uploads"
    md_dir = session_root / "md"
    extracted_root = session_root / "extracted"
    uploads_dir.mkdir(parents=True, exist_ok=True)
    md_dir.mkdir(parents=True, exist_ok=True)
    extracted_root.mkdir(parents=True, exist_ok=True)

    paper_id = _generate_uploaded_paper_id()
    stored_pdf_abs = uploads_dir / f"{paper_id}.pdf"

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
    finally:
        await file.close()

    if total_bytes <= 0:
        if stored_pdf_abs.exists():
            stored_pdf_abs.unlink()
        raise HTTPException(status_code=400, detail="Uploaded file is empty")

    try:
        with stored_pdf_abs.open("rb") as f:
            signature = f.read(5)
        if signature != b"%PDF-":
            raise HTTPException(status_code=400, detail="Uploaded file is not a valid PDF")
    except HTTPException:
        if stored_pdf_abs.exists():
            stored_pdf_abs.unlink()
        raise
    except Exception:
        if stored_pdf_abs.exists():
            stored_pdf_abs.unlink()
        raise HTTPException(status_code=400, detail="Failed to validate uploaded PDF")

    extractor = PDFExtractor(output_base_dir=extracted_root)
    try:
        extracted = extractor.extract(str(stored_pdf_abs), paper_id=paper_id)
    except Exception as e:
        logging.exception("Failed to extract uploaded PDF")
        raise HTTPException(status_code=500, detail=f"PDF extraction failed: {e}")

    canonical_md_abs = md_dir / f"{paper_id}.md"
    canonical_md_abs.write_text(_build_uploaded_canonical_md(paper_id, extracted), encoding="utf-8")

    stored_pdf_path = _to_project_relative(stored_pdf_abs)
    canonical_md_path = _to_project_relative(canonical_md_abs)
    images_dir = _to_project_relative(extracted.images_dir)
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
    if metadata is None:
        raise HTTPException(status_code=500, detail="Failed to persist uploaded paper metadata")

    await upsert_session_paper_link(pool, session_id, paper_id, source_ref=f"uploaded://{paper_id}")

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

from pydantic import BaseModel, Field
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
        except Exception as exc:
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
    store_idempotency_key,
    create_task_spec,
    create_dataset_snapshot,
    freeze_task_spec,
    get_task_spec,
    create_task,
    submit_task_atomically,
    get_task,
    get_tasks_by_project,
    update_task_status,
    renew_lease,
    create_task_event,
    get_task_events,
    create_outbox_event,
    create_artifact,
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
    worker_id: Optional[str] = None
    namespace: str
    ttl_seconds: int = Field(default=600, ge=30, le=3600)


# ---- Redis client singleton ----

_redis_client: Optional[RedisClient] = None


def get_redis_client() -> Optional[RedisClient]:
    global _redis_client
    if _redis_client is None:
        redis_url = os.getenv("REDIS_URL", "redis://localhost:6379/0")
        _redis_client = RedisClient(redis_url)
    return _redis_client


def _worker_enrollment_admin_allowed(user: Principal) -> bool:
    """Allow cross-user legacy Worker administration only to explicit admins."""
    configured = {
        value.strip()
        for value in os.getenv("WORKER_ENROLLMENT_ADMIN_USER_IDS", "").split(",")
        if value.strip()
    }
    return user.user_id in configured


def _legacy_worker_issue_allowed(user: Principal) -> bool:
    """Keep the local one-time endpoint usable in explicit test environments."""
    environment = os.getenv("APP_ENV", "development").lower()
    return environment in {"development", "test", "acceptance"} or _worker_enrollment_admin_allowed(user)


def _configured_superuser_ids() -> set[str]:
    return {
        value.strip()
        for value in os.getenv("WORKER_SUPERUSER_USER_IDS", "").split(",")
        if value.strip()
    }


def _worker_trust_level(user: Principal) -> str:
    role = str(user.role or "").strip().lower().replace(" ", "_")
    if role in {"superuser", "super_admin", "superadmin"} or user.user_id in _configured_superuser_ids():
        return "owner_trusted"
    return "institution_trusted"


@app.post("/api/worker-enrollments")
async def issue_worker_enrollment_endpoint(
    request: WorkerEnrollmentRequest,
    user: Principal = Depends(require_user),
):
    """Create a persistent Worker registration, or serve the legacy token path."""
    if request.worker_id:
        if not _legacy_worker_issue_allowed(user):
            raise HTTPException(status_code=403, detail="Legacy Worker enrollment requires operator permission")
        from backend.worker_enrollment import issue_enrollment_token

        try:
            token = await issue_enrollment_token(
                app.state.db_pool,
                request.worker_id,
                request.namespace,
                ttl_seconds=request.ttl_seconds,
            )
        except Exception as exc:
            raise HTTPException(status_code=400, detail="Worker enrollment request is invalid") from exc
        return {
            "worker_id": token.worker_id,
            "namespace": token.namespace,
            "enrollment_token": token.token,
            "expires_at": token.expires_at,
            "one_time": True,
        }

    from backend.worker_enrollment import issue_persistent_worker

    try:
        registration = await issue_persistent_worker(
            app.state.db_pool,
            user_id=user.user_id,
            namespace=request.namespace,
            trust_level=_worker_trust_level(user),
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Worker registration request is invalid") from exc
    return {
        "worker_id": registration.worker_id,
        "namespace": registration.namespace,
        "trust_level": registration.trust_level,
        "worker_credential": registration.worker_credential,
        "credential_expires_at": registration.credential_expires_at,
        "control_base_url": os.getenv("APP_BASE_URL", "http://localhost:8008").rstrip("/"),
        "persistent": True,
        "one_time": False,
    }


@app.get("/api/worker-enrollments")
async def list_worker_enrollments_endpoint(user: Principal = Depends(require_user)):
    """List persistent Workers without exposing credentials or other users."""
    from backend.worker_enrollment import list_persistent_workers

    workers = await list_persistent_workers(app.state.db_pool, user_id=user.user_id)
    current_trust = _worker_trust_level(user)
    return {"workers": [{**worker, "trust_level": current_trust} for worker in workers]}


@app.post("/api/worker-enrollments/{worker_id}/revoke")
async def revoke_worker_enrollment_endpoint(
    worker_id: str,
    namespace: str,
    user: Principal = Depends(require_user),
):
    can_revoke_other_users = _worker_enrollment_admin_allowed(user) or _worker_trust_level(user) == "owner_trusted"
    from backend.worker_enrollment import revoke_worker

    revoked = await revoke_worker(
        app.state.db_pool,
        worker_id,
        namespace,
        user_id=user.user_id,
        allow_other_users=can_revoke_other_users,
    )
    if not revoked:
        raise HTTPException(status_code=404, detail="Active Worker enrollment not found")
    return {"worker_id": worker_id, "namespace": namespace, "status": "revoked"}


# ---- Task API endpoints ----

# Upload limits (design doc §40): streamed to disk, never held in memory.
MAX_DATASET_UPLOAD_BYTES = int(os.getenv("DATASET_UPLOAD_MAX_BYTES", str(5 * 1024**3)))
MAX_METHOD_SOURCE_BYTES = int(os.getenv("METHOD_SOURCE_MAX_BYTES", str(200 * 1024**2)))

_METHOD_SOURCE_EXTENSIONS = {".html", ".htm", ".pdf", ".md", ".txt", ".doc", ".docx"}


async def _require_task_api_key(request: Request) -> Optional[Principal]:
    """Resolve the authenticated Task principal.

    Acceptance/production always use the same HttpOnly session or verified
    bearer token as the rest of the application.  The legacy shared token is
    available only behind an explicit development flag so a missing token can
    never silently open a deployed Task API.
    """
    if _env_flag("AUTH_REQUIRED_TASK_API", False):
        principal = await require_user(request)
        request.state.task_principal = principal
        return principal
    if _env_flag("ALLOW_LEGACY_TASK_API_TOKEN", False):
        import hmac
        expected = os.getenv("TASK_API_TOKEN", "").strip()
        if expected:
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
    """Fixed-window per-user rate limit. Fails open when Redis is unavailable."""
    redis = get_redis_client()
    if not redis or not redis.is_connected:
        return True, -1
    limit, window = _rate_limit_settings()
    allowed, remaining = await redis.check_rate_limit(user_id, limit, window, action=action)
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


def _validate_dataset_file(path: FilePath) -> Dict[str, Any]:
    """Perform bounded, deterministic dataset validation before freezing it."""
    import csv
    import zipfile

    try:
        info = path.stat()
        if info.st_size <= 0:
            return {"passed": False, "code": "empty", "message": "Dataset is empty"}
        if path.suffix.lower() == ".zip":
            with zipfile.ZipFile(path) as archive:
                names = archive.namelist()
                if not names or len(names) > 10000:
                    return {"passed": False, "code": "zip_entries", "message": "ZIP must contain 1-10000 entries"}
                for name in names:
                    safe = name.replace("\\", "/")
                    if safe.startswith("/") or any(part == ".." for part in safe.split("/")):
                        return {"passed": False, "code": "zip_traversal", "message": "ZIP contains path traversal"}
                    mode = (archive.getinfo(name).external_attr >> 16) & 0o170000
                    if mode and mode != 0o100000 and not name.endswith("/"):
                        return {"passed": False, "code": "zip_special_file", "message": "ZIP contains a special file"}
            return {"passed": True, "format": "zip", "size_bytes": info.st_size, "entry_count": len(names)}
        if path.suffix.lower() in {".csv", ".tsv"}:
            sample = path.read_text(encoding="utf-8", errors="strict")[:2 * 1024 * 1024]
            delimiter = "\t" if path.suffix.lower() == ".tsv" else ","
            rows = list(csv.reader(sample.splitlines(), delimiter=delimiter))
            if not rows or len(rows[0]) < 1:
                return {"passed": False, "code": "no_columns", "message": "Dataset has no columns"}
            return {"passed": True, "format": path.suffix.lower().lstrip("."), "size_bytes": info.st_size, "column_count": len(rows[0]), "sample_rows": max(0, len(rows) - 1)}
        # Binary/scientific formats get a bounded existence/size check here;
        # format-specific verifiers run in the isolated Job.
        return {"passed": True, "format": path.suffix.lower().lstrip(".") or "binary", "size_bytes": info.st_size}
    except (OSError, UnicodeError, ValueError, zipfile.BadZipFile) as exc:
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
    file: UploadFile = File(...),
    user: Principal = Depends(require_user),
):
    """Store an uploaded file behind an opaque, project-authorized Resource ID."""
    pool = app.state.db_pool
    if not await user_can_access_project(pool, project_id, user.user_id):
        raise HTTPException(status_code=404, detail="Project not found")
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
        raise HTTPException(status_code=500, detail="Resource storage failed") from exc
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
    if user and (not spec or not await user_can_access_project(pool, str(spec["project_id"]), user.user_id)):
        raise HTTPException(status_code=404, detail="TaskSpec not found")
    frozen = await freeze_task_spec(pool, task_spec_id)
    if not frozen:
        raise HTTPException(status_code=409, detail="TaskSpec is already frozen or does not exist")
    return {"task_spec_id": frozen.task_spec_id, "status": frozen.status, "frozen": True}


@app.post("/api/dataset-snapshots/upload", response_model=Dict[str, Any])
async def upload_dataset_endpoint(
    project_id: str = Form(...),
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
    upload_root = FilePath(os.getenv("RESOURCE_STORAGE_ROOT", "/workspace/resources")).resolve()
    resource_id = str(uuid.uuid4())
    staging_root = upload_root / ".staging"
    resource_root = upload_root / "datasets"
    upload = await _stream_upload_to_disk(file, staging_root, MAX_DATASET_UPLOAD_BYTES)
    source = FilePath(upload["stored_path"])
    destination = resource_root / resource_id
    resource_root.mkdir(parents=True, exist_ok=True)
    try:
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
    except Exception as exc:
        source.unlink(missing_ok=True)
        destination.unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail="Dataset resource storage failed") from exc
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
        spec_project = await conn.fetchval(
            "SELECT project_id FROM task_specs WHERE task_spec_id = $1::uuid",
            request.task_spec_id,
        )
    if spec_project is None or str(spec_project) != str(request.project_id):
        raise HTTPException(status_code=404, detail="TaskSpec not found")
    if user:
        if not request.resource_id:
            raise HTTPException(status_code=400, detail="resource_id is required")
        resource = await _get_project_resource(pool, request.resource_id, user.user_id)
        if not resource or resource["project_id"] != request.project_id or resource["kind"] != "dataset":
            raise HTTPException(status_code=404, detail="Dataset resource not found")
        resource_root = FilePath(os.getenv("RESOURCE_STORAGE_ROOT", "/workspace/resources"))
        resolved = _safe_storage_path(resource_root, resource["storage_key"])
        stored_path = str(resolved)
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
    validation_result = _validate_dataset_file(resolved)
    snapshot = DatasetSnapshot(
        dataset_snapshot_id=str(uuid.uuid4()),
        task_spec_id=request.task_spec_id,
        project_id=request.project_id,
        original_filename=request.original_filename,
        stored_path=stored_path,
        validation_result=validation_result,
        validation_passed=bool(validation_result.get("passed")),
    )
    if request.file_hash_sha256:
        snapshot.file_hash_sha256 = request.file_hash_sha256
    result = await create_dataset_snapshot(pool, snapshot)
    return {
        "dataset_snapshot_id": result.dataset_snapshot_id,
        "version": result.version,
        "created_at": result.created_at,
    }


@app.post("/api/tasks/direct", response_model=Dict[str, Any])
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
    limit: int = 100,
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
    allowed_root = FilePath(
        os.getenv("ARTIFACT_DOWNLOAD_ROOT", "/workspace/task-outputs")
    ).resolve()
    original = FilePath(storage_path)
    try:
        resolved = original.absolute()
        relative = resolved.relative_to(allowed_root)
    except ValueError:
        raise HTTPException(status_code=403, detail="Artifact path is outside the allowed directory")
    current = allowed_root
    for part in relative.parts:
        current = current / part
        try:
            if current.is_symlink():
                raise HTTPException(status_code=403, detail="Symlinked artifacts are not allowed")
        except OSError as exc:
            raise HTTPException(status_code=404, detail="Artifact file not found") from exc
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
    limit: int = 50,
    user: Optional[Principal] = Depends(_require_task_api_key),
):
    """List tasks, optionally filtered by project."""
    pool = app.state.db_pool
    if project_id:
        if user and not await user_can_access_project(pool, project_id, user.user_id):
            raise HTTPException(status_code=404, detail="Project not found")
        tasks = await get_tasks_by_project(pool, project_id, limit=limit)
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

@app.get("/api/tasks/{task_id}/events/stream")
async def task_events_sse_endpoint(
    task_id: str,
    last_event_id: Optional[str] = None,
    user: Optional[Principal] = Depends(_require_task_api_key),
):
    """SSE endpoint for real-time task events."""
    async def event_generator():
        pool = app.state.db_pool
        task = await get_task(pool, task_id)
        if not task or (user and task.get("created_by") != user.user_id):
            return
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
            seen_ids = set()
            if last_event_id:
                seen_ids.add(last_event_id)

            while True:
                events = await redis.read_task_events(task_id, last_event_id=last_event_id, count=20)
                for event in events:
                    msg_id = event.get("_message_id", "")
                    if msg_id in seen_ids:
                        continue
                    seen_ids.add(msg_id)
                    last_event_id = msg_id

                    yield {
                        "event": event.get("event_type", "update"),
                        "id": msg_id,
                        "data": json.dumps(event),
                    }

                # Check if task is terminal
                if task["status"] in ("succeeded", "failed", "cancelled", "timeout"):
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
            last_id = 0
            while True:
                events = await get_task_events(pool, task_id, limit=50)
                for event in events:
                    eid = event.get("task_event_id", 0)
                    if eid > last_id:
                        last_id = eid
                        yield {
                            "event": event.get("event_type", "update"),
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
async def worker_poll_endpoint(_: None = Depends(_require_task_api_key)):
    """Worker polling endpoint for task discovery (fallback when Redis unavailable)."""
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
async def publish_outbox_endpoint(_: None = Depends(_require_task_api_key)):
    """Manually trigger outbox publishing.

    Requires a connected Redis: events are only marked published after they
    are actually delivered to the stream. When Redis is down the request is
    rejected (503) — silently marking events published would lose them.
    """
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
async def worker_health_endpoint(_: None = Depends(_require_task_api_key)):
    """Health check for workers."""
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
