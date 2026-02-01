from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import List, Dict, Any
from fastapi.middleware.cors import CORSMiddleware
from agent.paperAgent import get_paper_agent
import os
import logging
from agent.util import estimate_tokens, estimate_message_tokens

logging.basicConfig(level=logging.INFO)
import logging

app = FastAPI()
paper_agent = get_paper_agent()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

class ChatRequest(BaseModel):
    messages: List[Dict[str, Any]]

@app.post("/chat")
async def chat_endpoint(request: ChatRequest):
    """
    PaperAgent Web API 接口
    """
    user_query = ""
    for m in reversed(request.messages):
        if m.get("role") == "user":
            user_query = m.get("content", "")
            break
    
    async def event_generator():
        try:
            logging.info("Incoming messages (truncated): %s", request.messages[-6:])
            prompt_tokens = estimate_message_tokens(request.messages)

            response_stream = paper_agent.run(user_query, stream=True)
            #流式读取回复
            response_text = ""
            for chunk in response_stream:
                content = getattr(chunk, "content", None)
                if content is None and isinstance(chunk, str):
                    content = chunk
                if content:
                    response_text += content
                    yield content

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



if __name__ == "__main__":
    import uvicorn
    if not os.getenv("MOONSHOT_API_KEY"):
        print("Warning: MOONSHOT_API_KEY not found in environment variables.")
    uvicorn.run(app, host="0.0.0.0", port=8000)