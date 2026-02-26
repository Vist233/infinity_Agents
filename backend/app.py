from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect, UploadFile, File
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
    app.state.session_agents = {}
    app.state.session_meta = {}
    yield
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
        "用户上传了 PDF 论文，可用 read_paper('uploaded://{paper_id}') 阅读。",
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

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
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
    """Serve legacy files only (backward compatibility)."""
    target = _resolve_relative_in_dirs(file_path, _LEGACY_ALLOWED_FILE_DIRS)
    if target is None:
        raise HTTPException(status_code=404, detail="File not found")

    resolved = target.resolve()
    allowed = any(
        str(resolved).startswith(str(d.resolve()))
        for d in _LEGACY_ALLOWED_FILE_DIRS
    )
    if (
        not allowed
        or str(resolved).startswith(str(_SESSIONS_ROOT.resolve()))
        or not resolved.exists()
        or not resolved.is_file()
    ):
        raise HTTPException(status_code=404, detail="File not found")
    
    return FileResponse(str(resolved))


@app.get("/api/sessions/{session_id}/files/{file_path:path}")
async def serve_session_file(session_id: str, file_path: str):
    """Serve files scoped to a specific session sandbox."""
    try:
        uuid.UUID(session_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid session ID format")

    pool = app.state.db_pool
    meta = await get_session(pool, session_id)
    if not meta:
        raise HTTPException(status_code=404, detail="Session not found")

    if (meta.get("storage_mode") or "legacy") == "legacy":
        return await serve_file(file_path)

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
async def create_session():
    session_id = str(uuid.uuid4())
    try:
        pool = app.state.db_pool
        await insert_session(pool, session_id, storage_mode="sandboxed")
        await _get_or_create_session_agent(session_id)
    except Exception:
        logging.exception("Failed to create session")
        raise HTTPException(status_code=500, detail="Failed to create session")

    return {"session_id": session_id, "storage_mode": "sandboxed"}

@app.get("/api/sessions")
async def list_sessions():
    """
    获取会话列表（按最近更新时间倒序）
    """
    pool = app.state.db_pool
    if not pool:
        raise HTTPException(status_code=500, detail="Database not initialized")
    try:
        sessions = await get_all_sessions(pool)
        return sessions
    except Exception:
        logging.exception("Failed to fetch sessions")
        raise HTTPException(status_code=500, detail="Failed to fetch sessions")

@app.patch("/api/sessions/{session_id}/title")
async def update_session_title_endpoint(session_id: str, payload: SessionTitleUpdate):
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
        updated = await update_session_title(pool, session_id, title)
        if not updated:
            raise HTTPException(status_code=404, detail="Session not found")
        return {"session_id": session_id, "title": title}
    except HTTPException:
        raise
    except Exception:
        logging.exception("Failed to update session title")
        raise HTTPException(status_code=500, detail="Failed to update session title")

@app.delete("/api/sessions/{session_id}")
async def delete_session_endpoint(session_id: str):
    try:
        uuid.UUID(session_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid session ID format")

    pool = app.state.db_pool
    if not pool:
        raise HTTPException(status_code=500, detail="Database not initialized")

    try:
        deleted = await delete_session(pool, session_id)
        if not deleted:
            raise HTTPException(status_code=404, detail="Session not found")
        return {"session_id": session_id}
    except HTTPException:
        raise
    except Exception:
        logging.exception("Failed to delete session")
        raise HTTPException(status_code=500, detail="Failed to delete session")


@app.post("/api/sessions/{session_id}/uploads/papers")
async def upload_session_paper(session_id: str, file: UploadFile = File(...)):
    try:
        uuid.UUID(session_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid session ID format")

    pool = app.state.db_pool
    if not pool:
        raise HTTPException(status_code=500, detail="Database not initialized")

    meta = await get_session(pool, session_id)
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
async def list_uploaded_papers(session_id: str):
    try:
        uuid.UUID(session_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid session ID format")

    pool = app.state.db_pool
    if not pool:
        raise HTTPException(status_code=500, detail="Database not initialized")

    meta = await get_session(pool, session_id)
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
    except Exception:
        await websocket.send_json({
            "type": "error",
            "message": "Invalid payload, expected {session_id, messages}.",
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

    active_stop_event: Optional[threading.Event] = None
    active_response_stream: Any = None

    try:
        pool = app.state.db_pool
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
                    await websocket.send_json({"type": "chunk", "content": content})

            if should_retry_attempt:
                attempt += 1
                continue

            response_text = attempt_response
            active_stop_event = None
            active_response_stream = None
            break

        if not response_text:
            message = "模型未返回正文内容。"
            if did_auto_retry:
                message = "模型在8秒内未返回正文，已自动重试1次，仍未收到有效输出。"
            await websocket.send_json({"type": "error", "message": message})
            return

        await insert_message(pool, session_id, "assistant", response_text)

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
    except Exception as e:
        _stop_stream_worker(active_stop_event, active_response_stream)
        active_stop_event = None
        active_response_stream = None
        logging.exception("Error in websocket chat endpoint")
        try:
            await websocket.send_json({
                "type": "error",
                "message": f"搜索文献时遇到点麻烦... ({str(e)})",
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
async def get_session_history(session_id: str):
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
        messages = await get_session_messages(pool, session_id)
        if not messages:
            return []
            
        return messages

    except Exception as e:
        logging.error(f"Error fetching history for {session_id}: {e}")
        raise HTTPException(status_code=500, detail="Failed to retrieve chat history")

if __name__ == "__main__":
    import uvicorn
    if not os.getenv("MOONSHOT_API_KEY"):
        print("Warning: MOONSHOT_API_KEY not found in environment variables.")
    uvicorn.run(app, host="0.0.0.0", port=8008)
