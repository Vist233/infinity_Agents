from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse, FileResponse
from pathlib import Path as FilePath
from pydantic import BaseModel
from typing import List, Dict, Any, Optional
from fastapi.middleware.cors import CORSMiddleware
from agent.paperAgent import create_paper_agent
from contextlib import asynccontextmanager
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
    insert_message,
    get_all_sessions,
    update_session_title,
    delete_session,
)

logging.basicConfig(level=logging.INFO)

@asynccontextmanager
async def lifespan(app):
    await init_db(app)
    app.state.session_agents = {}
    yield
    await close_db(app)

app = FastAPI(lifespan=lifespan)

def _get_or_create_session_agent(session_id: str):
    agents = app.state.session_agents
    agent = agents.get(session_id)
    if agent is None:
        agent = create_paper_agent()
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

# Allowed directories for file serving
_PROJECT_ROOT = FilePath(__file__).parent.parent
_ALLOWED_FILE_DIRS = [
    _PROJECT_ROOT / "papers",
    _PROJECT_ROOT / "agent" / "tools" / "plot_outputs",
    _PROJECT_ROOT / "agent" / "tools" / "plotly_outputs",
]

@app.get("/api/files/{file_path:path}")
async def serve_file(file_path: str):
    """Serve images and files from allowed project directories."""
    target = FilePath(file_path)
    
    # If relative path, try to find it in allowed dirs
    if not target.is_absolute():
        for allowed in _ALLOWED_FILE_DIRS:
            candidate = allowed / file_path
            if candidate.exists():
                target = candidate
                break
    
    # Security: ensure path is within allowed directories
    resolved = target.resolve()
    allowed = any(
        str(resolved).startswith(str(d.resolve()))
        for d in _ALLOWED_FILE_DIRS
    )
    if not allowed or not resolved.exists() or not resolved.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    
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
    for d in _ALLOWED_FILE_DIRS:
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


class SessionTitleUpdate(BaseModel):
    title: str

@app.post("/api/sessions")
async def create_session():
    session_id = str(uuid.uuid4())
    try:
        pool = app.state.db_pool
        await insert_session(pool, session_id)
        _get_or_create_session_agent(session_id)
    except Exception:
        logging.exception("Failed to create session")
        raise HTTPException(status_code=500, detail="Failed to create session")

    return {"session_id": session_id}

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

@app.post("/chat")
async def chat_endpoint(request: ChatRequest):
    """
    PaperAgent Web API 接口
    """
    session_id = request.session_id
    user_query = ""
    user_index = -1
    for i in range(len(request.messages) - 1, -1, -1):
        m = request.messages[i]
        if m.get("role") == "user":
            user_query = m.get("content", "")
            user_index = i
            break
    
    async def event_generator():
        try:
            pool = app.state.db_pool
            #logging.info("Incoming messages (truncated): %s", request.messages[-6:])
            prompt_tokens = estimate_message_tokens(request.messages)

            await insert_message(pool, session_id, "user", user_query)
            session_agent = _get_or_create_session_agent(session_id)
            prompt = _build_prompt_from_messages(request.messages, user_index, user_query)
            response_stream = session_agent.run(prompt, stream=True)
            #流式读取回复
            response_text = ""
            for chunk in response_stream:
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
                        # Agno may return list of content items
                        parts = [item if isinstance(item, str) else getattr(item, "text", str(item)) for item in raw]
                        content = "".join(parts) if parts else None
                elif isinstance(chunk, str):
                    content = chunk
                if content:
                    response_text += content
                    yield content
                    
            if response_text:
                await insert_message(pool, session_id, "assistant", response_text)

            # Token消耗统计
            response_tokens = estimate_tokens(response_text)
            total_tokens = prompt_tokens + response_tokens
            notice = f"\n\n[DONE] 消耗 tokens - prompt: {prompt_tokens}, response: {response_tokens}, total: {total_tokens}"
            logging.info("Chat finished. prompt=%s response=%s total=%s", prompt_tokens, response_tokens, total_tokens)
            yield notice

            # # 在每次交互后进行记忆压缩
            # if hasattr(paper_agent, "_context_manager"):
            #     all_messages = paper_agent.memory.get_all_messages()
            #     if paper_agent._context_manager.should_compress(all_messages):
            #         paper_agent.memory.messages = paper_agent._context_manager.compress(all_messages)

        except Exception as e:
            logging.exception("Error in chat event generator")
            yield f"\n\n[Error]: 搜索文献时遇到点麻烦... ({str(e)})"

    return StreamingResponse(event_generator(), media_type="text/plain")

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
