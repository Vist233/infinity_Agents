from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from pathlib import Path as FilePath
from pydantic import BaseModel
from typing import List, Dict, Any, Optional, Tuple
from fastapi.middleware.cors import CORSMiddleware
from agent.paperAgent import create_paper_agent
from contextlib import asynccontextmanager
import asyncio
import threading
import os
import re
import base64
import logging
import mimetypes
from agent.util import estimate_tokens, estimate_message_tokens
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


ENABLE_WS_STATUS_EVENTS = _env_flag("ENABLE_WS_STATUS_EVENTS", True)
ENABLE_FIRST_CHUNK_RETRY = _env_flag("ENABLE_FIRST_CHUNK_RETRY", True)
FIRST_CHUNK_TIMEOUT_SECONDS = max(1, _env_int("FIRST_CHUNK_TIMEOUT_SECONDS", 8))
MAX_STREAM_ATTEMPTS = 2 if ENABLE_FIRST_CHUNK_RETRY else 1

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


def _get_session_root(session_id: str) -> FilePath:
    return _SESSIONS_ROOT / session_id


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

def _build_prompt_from_messages(
    messages: List[Dict[str, Any]],
    user_index: int,
    user_query: str,
    max_messages: int = 20,
) -> str:
    if not messages and user_query:
        return user_query

    context_messages = messages[:user_index] if user_index >= 0 else messages
    if max_messages and len(context_messages) > max_messages:
        context_messages = context_messages[-max_messages:]

    lines: List[str] = []
    for m in context_messages:
        role = m.get("role")
        content = m.get("content")
        if not content:
            continue
        if role == "user":
            prefix = "User"
        elif role == "assistant":
            prefix = "Assistant"
        elif role:
            prefix = role.capitalize()
        else:
            prefix = "Message"
        lines.append(f"{prefix}: {content}")

    if lines and user_query:
        return "\n".join(lines) + f"\nUser: {user_query}"
    if user_query:
        return user_query
    return "\n".join(lines)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

def _resolve_relative_in_dirs(file_path: str, allowed_dirs: List[FilePath]) -> Optional[FilePath]:
    target = FilePath(file_path)
    if target.is_absolute() and target.exists():
        return target

    for allowed in allowed_dirs:
        candidate = allowed / file_path
        if candidate.exists() and candidate.is_file():
            return candidate

    # For plain filenames in img:// refs, search recursively.
    if "/" not in file_path and "\\" not in file_path:
        for allowed in allowed_dirs:
            for candidate in allowed.rglob(file_path):
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

def _resolve_image_ref(filename: str) -> Optional[FilePath]:
    """Resolve an img://filename reference to an actual file path."""
    for d in _LEGACY_ALLOWED_FILE_DIRS:
        candidate = d / filename
        if candidate.exists() and candidate.is_file():
            return candidate
    return None

def _replace_image_refs_with_base64(text: str) -> str:
    """Scan Markdown for ![alt](img://filename) and convert to base64 data URLs."""
    def _convert(match):
        alt, filename = match.group(1), match.group(2)
        resolved = _resolve_image_ref(filename)
        if not resolved:
            logging.warning(f"Image not found: img://{filename}")
            return match.group(0)
        ext = resolved.suffix.lower()
        mime = _IMAGE_MIME.get(ext)
        if not mime:
            return match.group(0)
        try:
            b64 = base64.b64encode(resolved.read_bytes()).decode('ascii')
            logging.info(f"Converted img://{filename} to base64 ({resolved.stat().st_size} bytes)")
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
        prompt_tokens = estimate_message_tokens(request.messages)
        should_insert_user_message = request.retry_attempt <= 0
        if should_insert_user_message:
            await insert_message(pool, session_id, "user", user_query)
        session_agent = await _get_or_create_session_agent(session_id)
        prompt = _build_prompt_from_messages(request.messages, user_index, user_query)
        emitted_tools: set[str] = set()

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
