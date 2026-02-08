from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import List, Dict, Any
from fastapi.middleware.cors import CORSMiddleware
#from agent.paperAgent import get_paper_agent
from agent.test_paperAgent import SimplePaperAgent as get_paper_agent
from contextlib import asynccontextmanager
import os
import logging
from agent.util import estimate_tokens, estimate_message_tokens
import uuid
from backend.db import insert_session, init_db, close_db, get_session_messages, insert_message

logging.basicConfig(level=logging.INFO)

@asynccontextmanager
async def lifespan(app):
    await init_db(app)
    yield
    await close_db(app)

app = FastAPI(lifespan=lifespan)
paper_agent = get_paper_agent()


app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

class ChatRequest(BaseModel):
    session_id: str
    messages: List[Dict[str, Any]]

@app.post("/api/sessions")
async def create_session():
    session_id = str(uuid.uuid4())
    try:
        pool = app.state.db_pool
        await insert_session(pool, session_id)
    except Exception:
        logging.exception("Failed to create session")
        raise HTTPException(status_code=500, detail="Failed to create session")

    return {"session_id": session_id}

@app.post("/chat")
async def chat_endpoint(request: ChatRequest):
    """
    PaperAgent Web API 接口
    """
    session_id = request.session_id
    user_query = ""
    for m in reversed(request.messages):
        if m.get("role") == "user":
            user_query = m.get("content", "")
            break
    
    async def event_generator():
        try:
            pool = app.state.db_pool
            #logging.info("Incoming messages (truncated): %s", request.messages[-6:])
            prompt_tokens = estimate_message_tokens(request.messages)

            await insert_message(pool, session_id, "user", user_query)
            response_stream = paper_agent.run(user_query, stream=True)
            #流式读取回复
            response_text = ""
            for chunk in response_stream:
                content = None
                if hasattr(chunk, "choices") and len(chunk.choices) > 0:
                    delta = getattr(chunk.choices[0], "delta", None)
                    if delta:
                        content = getattr(delta, "content", None)
                elif hasattr(chunk, "content"):
                    content = chunk.content
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
    uvicorn.run(app, host="0.0.0.0", port=8000)
