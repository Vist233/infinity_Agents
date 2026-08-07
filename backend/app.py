from fastapi import FastAPI, Depends, HTTPException, Request, WebSocket, WebSocketDisconnect, UploadFile, File
from fastapi.responses import FileResponse
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
import logging
import mimetypes
import json
import hashlib
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
from backend.auth import Principal, TokenVerifier, require_user, verify_websocket_token

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
        "https://infinity.zhangyvjing.com,http://localhost:3000",
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

    for allowed in allowed_dirs:
        candidate = allowed / normalized
        if candidate.exists() and candidate.is_file():
            return candidate

    # For plain filenames in img:// refs, search recursively.
    if "/" not in normalized and "\\" not in normalized:
        for allowed in allowed_dirs:
            for candidate in allowed.rglob(normalized):
                if candidate.is_file():
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
    in_session = str(resolved).startswith(str(session_root))
    in_shared = str(resolved).startswith(str(_SHARED_PAPERS_CACHE_ROOT.resolve()))
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
    if _SESSIONS_ROOT.exists():
        for session_dir in _SESSIONS_ROOT.iterdir():
            if not session_dir.is_dir():
                continue
            candidate = session_dir / normalized
            if candidate.exists() and candidate.is_file():
                return candidate
    # Backward compatibility for basename refs.
    if "/" not in normalized:
        for d in [*_LEGACY_ALLOWED_FILE_DIRS, _SHARED_PAPERS_CACHE_ROOT]:
            for candidate in d.rglob(normalized):
                if candidate.is_file():
                    return candidate
        if _SESSIONS_ROOT.exists():
            for candidate in _SESSIONS_ROOT.rglob(normalized):
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
    access_token: str
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
    if not os.getenv("MOONSHOT_API_KEY"):
        print("Warning: MOONSHOT_API_KEY not found in environment variables.")
    uvicorn.run(app, host="0.0.0.0", port=8008)


# ============================================================================
# CodeAgent Integration
# ============================================================================

import secrets

from backend.code_agent.service import run_code_agent_stream
from backend.code_agent.analysis_agent import run_analysis_stream


import time

class _CodeSessionState:
    __slots__ = ("messages", "run_state", "created_at", "last_used")
    def __init__(self) -> None:
        self.messages: list[dict] = []
        self.run_state: dict = {
            "running": False,
            "phase": None,
            "toolName": None,
            "elapsedMs": 0,
            "attempt": 1,
            "maxAttempts": 1,
            "tokenInfo": None,
            "terminal": None,
        }
        self.created_at = time.monotonic()
        self.last_used = self.created_at


_code_sessions: dict[str, _CodeSessionState] = {}
_CODE_SESSION_TTL = 3600  # 1 hour idle timeout
_CODE_SESSION_MAX = 1000  # max concurrent sessions
_CODE_CLEANUP_INTERVAL = 300  # clean every 5 minutes
_CODE_LAST_CLEANUP = [0.0]


def _cleanup_code_sessions() -> None:
    now = time.monotonic()
    if now - _CODE_LAST_CLEANUP[0] < _CODE_CLEANUP_INTERVAL:
        return
    _CODE_LAST_CLEANUP[0] = now
    expired = [sid for sid, s in _code_sessions.items() if now - s.last_used > _CODE_SESSION_TTL]
    for sid in expired:
        del _code_sessions[sid]
    if len(_code_sessions) > _CODE_SESSION_MAX:
        oldest_first = sorted(_code_sessions.items(), key=lambda item: item[1].last_used)
        excess = len(_code_sessions) - _CODE_SESSION_MAX
        for sid, _ in oldest_first[:excess]:
            del _code_sessions[sid]


@app.post("/api/code/sessions")
async def create_code_session():
    _cleanup_code_sessions()
    session_id = secrets.token_hex(16)
    _code_sessions[session_id] = _CodeSessionState()
    return {"session_id": session_id}


@app.get("/api/code/sessions/{session_id}/messages")
async def get_code_session_messages(session_id: str):
    _cleanup_code_sessions()
    state = _code_sessions.get(session_id)
    if not state:
        return []
    state.last_used = time.monotonic()
    return state.messages


@app.websocket("/ws/code")
async def code_ws_endpoint(websocket: WebSocket):
    """CodeAgent WebSocket endpoint.

    Unlike /ws/chat, this endpoint intentionally does NOT require JWT auth.
    CodeAgent sessions are anonymous and created via /api/code/sessions without
    user authentication.
    """
    await websocket.accept()
    session_id: str | None = None
    state: _CodeSessionState | None = None
    try:
        raw = await websocket.receive_json()
        session_id = raw.get("session_id")
        messages = raw.get("messages", [])
        _cleanup_code_sessions()
        if not session_id or session_id not in _code_sessions:
            await websocket.send_json({"type": "error", "message": "Invalid session_id"})
            await websocket.close(code=1003)
            return
        state = _code_sessions[session_id]
        state.last_used = time.monotonic()
        user_query = ""
        for m in reversed(messages):
            if m.get("role") == "user":
                user_query = m.get("content", "")
                break
        if not user_query.strip():
            await websocket.send_json({"type": "error", "message": "Empty query"})
            await websocket.close(code=1003)
            return
        state.messages.append({"role": "user", "content": user_query})
        state.run_state.update({"running": True, "phase": "thinking", "toolName": None, "terminal": None})
        await websocket.send_json({"type": "status", "phase": "thinking", "elapsed_ms": 0, "attempt": 1, "max_attempts": 1})
        response_text = ""

        async def _safe_send(payload: Dict[str, Any]) -> None:
            try:
                await websocket.send_json(payload)
            except Exception:
                pass

        async for event in run_code_agent_stream(user_query):
            etype = event.get("type")
            if etype == "status":
                state.run_state["phase"] = event.get("phase")
                state.run_state["toolName"] = event.get("tool_name")
                state.run_state["elapsedMs"] = event.get("elapsed_ms", 0)
                await _safe_send(event)
            elif etype == "chunk":
                response_text += event.get("content", "")
                await _safe_send(event)
            elif etype == "done":
                state.run_state.update({"running": False, "phase": None, "terminal": "success", "tokenInfo": event.get("token_info")})
                await _safe_send(event)
            elif etype == "error":
                state.run_state.update({"running": False, "phase": None, "terminal": "error"})
                await _safe_send(event)
        if response_text:
            state.messages.append({"role": "assistant", "content": response_text})
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        logging.exception("CodeAgent WS error")
        try:
            await websocket.send_json({"type": "error", "message": str(exc)})
        except Exception:
            pass
    finally:
        if session_id and session_id in _code_sessions:
            _code_sessions[session_id].last_used = time.monotonic()
        try:
            await websocket.close()
        except Exception:
            pass


@app.websocket("/ws/analysis")
async def analysis_ws_endpoint(websocket: WebSocket):
    """Analysis Agent WebSocket endpoint.

    Generates TaskSpec drafts from user conversations without executing
    analysis directly.
    """
    await websocket.accept()
    try:
        raw = await websocket.receive_json()
        session_id = raw.get("session_id")
        messages = raw.get("messages", [])
        if not session_id:
            await websocket.send_json({"type": "error", "message": "Missing session_id"})
            await websocket.close(code=1003)
            return

        user_query = ""
        for m in reversed(messages):
            if m.get("role") == "user":
                user_query = m.get("content", "")
                break
        if not user_query.strip():
            await websocket.send_json({"type": "error", "message": "Empty query"})
            await websocket.close(code=1003)
            return

        async def _safe_send(payload: Dict[str, Any]) -> None:
            try:
                await websocket.send_json(payload)
            except Exception:
                pass

        async for event in run_analysis_stream(user_query, messages=messages):
            await _safe_send(event)
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        logging.exception("AnalysisAgent WS error")
        try:
            await websocket.send_json({"type": "error", "message": str(exc)})
        except Exception:
            pass
    finally:
        try:
            await websocket.close()
        except Exception:
            pass


# ============================================================================
# Task Execution System (Infinity Agent)
# ============================================================================

from pydantic import BaseModel, Field
from sse_starlette.sse import EventSourceResponse

from backend.code_agent.task_service import (
    check_idempotency,
    store_idempotency_key,
    create_task_spec,
    create_dataset_snapshot,
    create_task,
    get_task,
    get_tasks_by_project,
    update_task_status,
    renew_lease,
    create_task_event,
    get_task_events,
    create_outbox_event,
    get_pending_outbox_events,
    mark_outbox_published,
    create_artifact,
    get_artifacts_for_task,
    get_artifact,
    request_cancel_task,
    ensure_default_project,
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
    stored_path: str
    file_hash_sha256: Optional[str] = None
    validation_passed: bool = False


class CreateTaskRequest(BaseModel):
    project_id: str
    task_spec_id: str
    dataset_snapshot_id: str
    title: str
    method_source_id: Optional[str] = None
    idempotency_key: Optional[str] = None
    max_attempts: int = Field(default=3, ge=1, le=10)


class DatasetUploadResponse(BaseModel):
    stored_path: str
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
    storage_path: str
    file_size_bytes: Optional[int] = None
    checksum_sha256: Optional[str] = None
    created_at: Optional[str] = None


# ---- Redis client singleton ----

_redis_client: Optional[RedisClient] = None


def get_redis_client() -> Optional[RedisClient]:
    global _redis_client
    if _redis_client is None:
        redis_url = os.getenv("REDIS_URL", "redis://localhost:6379/0")
        _redis_client = RedisClient(redis_url)
    return _redis_client


# ---- Task API endpoints ----

# Upload limits (design doc §40): streamed to disk, never held in memory.
MAX_DATASET_UPLOAD_BYTES = int(os.getenv("DATASET_UPLOAD_MAX_BYTES", str(5 * 1024**3)))
MAX_METHOD_SOURCE_BYTES = int(os.getenv("METHOD_SOURCE_MAX_BYTES", str(200 * 1024**2)))

_METHOD_SOURCE_EXTENSIONS = {".html", ".htm", ".pdf", ".md", ".txt", ".doc", ".docx"}


async def _require_task_api_key(request: Request) -> None:
    """Optional shared-secret gate for the Task API (design doc §41 MVP).

    When TASK_API_TOKEN is set, Task API requests must carry it in the
    X-API-Key header. Browser EventSource cannot set custom headers, so the
    `api_key` query parameter is accepted ONLY on the SSE stream endpoint
    (URLs can leak into logs/referers). Unset = local dev mode (open access).
    """
    import hmac

    expected = os.getenv("TASK_API_TOKEN", "").strip()
    if not expected:
        return
    provided = request.headers.get("X-API-Key", "")
    if not provided and request.url.path.rstrip("/").endswith("/events/stream"):
        provided = request.query_params.get("api_key") or ""
    if not hmac.compare_digest(provided, expected):
        raise HTTPException(status_code=401, detail="Invalid or missing X-API-Key")


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


@app.get("/api/projects/default", response_model=Dict[str, Any])
async def get_default_project_endpoint(_: None = Depends(_require_task_api_key)):
    """Return the default project, creating it on first use (design doc §13.1)."""
    pool = app.state.db_pool
    return await ensure_default_project(pool)


@app.post("/api/method-sources/upload", response_model=Dict[str, Any])
async def upload_method_source_endpoint(
    file: UploadFile = File(...),
    _: None = Depends(_require_task_api_key),
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
    project = await ensure_default_project(pool)
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
        "stored_path": result.stored_path,
        "file_hash_sha256": result.file_hash_sha256,
        "file_size_bytes": result.file_size_bytes,
        "created_at": result.created_at,
    }


@app.post("/api/task-specs", response_model=Dict[str, Any])
async def create_task_spec_endpoint(
    request: CreateTaskSpecRequest,
    _: None = Depends(_require_task_api_key),
):
    """Create a new TaskSpec."""
    pool = app.state.db_pool
    spec = TaskSpec(
        task_spec_id=str(uuid.uuid4()),
        project_id=request.project_id,
        title=request.title,
        analysis_type=request.analysis_type,
        research_question=request.research_question,
        spec_json=request.spec_json,
    )
    result = await create_task_spec(pool, spec)
    return {
        "task_spec_id": result.task_spec_id,
        "revision": result.revision,
        "status": result.status,
        "created_at": result.created_at,
    }


@app.post("/api/dataset-snapshots/upload", response_model=Dict[str, Any])
async def upload_dataset_endpoint(
    file: UploadFile = File(...),
    _: None = Depends(_require_task_api_key),
):
    """Upload a dataset file (streamed to disk with a size cap)."""
    safe_name = FilePath(file.filename or "dataset.bin").name
    if not safe_name:
        raise HTTPException(status_code=400, detail="Empty filename")

    upload_root = FilePath(os.getenv("DATASET_UPLOAD_ROOT", "/tmp/uploaded-datasets"))
    return await _stream_upload_to_disk(file, upload_root, MAX_DATASET_UPLOAD_BYTES)


@app.post("/api/dataset-snapshots", response_model=Dict[str, Any])
async def create_dataset_endpoint(
    request: CreateDatasetRequest,
    _: None = Depends(_require_task_api_key),
):
    """Create a dataset snapshot."""
    pool = app.state.db_pool
    # The executor mounts/copies stored_path verbatim, so it must point inside
    # a known upload root — never anywhere else on the filesystem.
    allowed_roots = [
        FilePath(os.getenv("DATASET_UPLOAD_ROOT", "/tmp/uploaded-datasets")).resolve(),
        FilePath(os.getenv("METHOD_SOURCE_UPLOAD_ROOT", "/tmp/uploaded-method-sources")).resolve(),
    ]
    resolved = FilePath(request.stored_path).resolve()
    if not any(resolved.is_relative_to(root) for root in allowed_roots):
        raise HTTPException(status_code=400, detail="stored_path is outside the upload root")
    snapshot = DatasetSnapshot(
        dataset_snapshot_id=str(uuid.uuid4()),
        task_spec_id=request.task_spec_id,
        project_id=request.project_id,
        original_filename=request.original_filename,
        stored_path=request.stored_path,
        validation_passed=request.validation_passed,
    )
    if request.file_hash_sha256:
        snapshot.file_hash_sha256 = request.file_hash_sha256
    result = await create_dataset_snapshot(pool, snapshot)
    return {
        "dataset_snapshot_id": result.dataset_snapshot_id,
        "version": result.version,
        "created_at": result.created_at,
    }


@app.post("/api/tasks", response_model=Dict[str, Any])
async def create_task_endpoint(
    request: CreateTaskRequest,
    _: None = Depends(_require_task_api_key),
):
    """Create a new task with idempotency support."""
    pool = app.state.db_pool

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

    # Publish to outbox if new
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
async def get_task_endpoint(task_id: str, _: None = Depends(_require_task_api_key)):
    """Get task details."""
    pool = app.state.db_pool
    task = await get_task(pool, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    return task


@app.get("/api/tasks/{task_id}/events", response_model=List[TaskEventResponse])
async def get_task_events_endpoint(
    task_id: str,
    limit: int = 100,
    _: None = Depends(_require_task_api_key),
):
    """Get task events."""
    pool = app.state.db_pool
    events = await get_task_events(pool, task_id, limit=limit)
    return events


@app.get("/api/tasks/{task_id}/artifacts", response_model=List[ArtifactResponse])
async def get_task_artifacts_endpoint(task_id: str, _: None = Depends(_require_task_api_key)):
    """Get task artifacts."""
    pool = app.state.db_pool
    artifacts = await get_artifacts_for_task(pool, task_id)
    return artifacts


def _validate_artifact_path(storage_path: str) -> FilePath:
    """Validate an artifact storage path for safe download.

    Rejects symlinks, path traversal, and paths outside the allowed root.
    """
    resolved = FilePath(storage_path).resolve()
    if not resolved.is_file():
        raise HTTPException(status_code=404, detail="Artifact file not found")
    if resolved.is_symlink():
        raise HTTPException(status_code=403, detail="Symlinked artifacts are not allowed")
    allowed_root = FilePath(os.getenv("ARTIFACT_DOWNLOAD_ROOT", "/tmp/task-outputs")).resolve()
    try:
        resolved.relative_to(allowed_root)
    except ValueError:
        raise HTTPException(status_code=403, detail="Artifact path is outside the allowed directory")
    return resolved


@app.get("/api/artifacts/{artifact_id}")
async def download_artifact_endpoint(artifact_id: str, _: None = Depends(_require_task_api_key)):
    """Download an artifact ZIP file."""
    pool = app.state.db_pool
    artifact = await get_artifact(pool, artifact_id)
    if not artifact:
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
async def cancel_task_endpoint(task_id: str, _: None = Depends(_require_task_api_key)):
    """Cancel a running or queued task."""
    pool = app.state.db_pool
    task = await get_task(pool, task_id)
    if not task:
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
    _: None = Depends(_require_task_api_key),
):
    """List tasks, optionally filtered by project."""
    pool = app.state.db_pool
    if project_id:
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
            ORDER BY created_at DESC
            LIMIT $1
        """
        async with pool.acquire() as conn:
            rows = await conn.fetch(query, limit)
        tasks = [_task_row_to_dict(row) for row in rows]
    return {"tasks": tasks}


# ---- SSE endpoint for task events ----

@app.get("/api/tasks/{task_id}/events/stream")
async def task_events_sse_endpoint(
    task_id: str,
    last_event_id: Optional[str] = None,
    _: None = Depends(_require_task_api_key),
):
    """SSE endpoint for real-time task events."""
    async def event_generator():
        pool = app.state.db_pool
        redis = get_redis_client()

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
                await asyncio.sleep(1)

    return EventSourceResponse(event_generator())


# ---- Worker API endpoints ----

@app.post("/api/worker/poll")
async def worker_poll_endpoint():
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
async def publish_outbox_endpoint():
    """Manually trigger outbox publishing (for when Redis is unavailable)."""
    pool = app.state.db_pool
    redis = get_redis_client()
    if not redis or not redis.is_connected:
        # Process in-process without Redis
        events = await get_pending_outbox_events(pool, 50)
        processed = 0
        for event in events:
            # Just mark as published
            await mark_outbox_published(pool, event["outbox_event_id"])
            processed += 1
        return {"processed": processed, "mode": "in-process"}
    return {"processed": 0, "mode": "redis"}


@app.get("/api/worker/health")
async def worker_health_endpoint():
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

def _task_row_to_dict(row: Any) -> Dict[str, Any]:
    """Convert a task row to a dictionary."""
    return {
        "task_id": str(row["task_id"]),
        "task_spec_id": str(row["task_spec_id"]),
        "dataset_snapshot_id": str(row["dataset_snapshot_id"]),
        "project_id": str(row["project_id"]),
        "method_source_id": str(row["method_source_id"]) if row.get("method_source_id") else None,
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
