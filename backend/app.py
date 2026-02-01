from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import List, Dict, Any
from fastapi.middleware.cors import CORSMiddleware
from agent.paperAgent import get_paper_agent
import os

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
    user_query = request.messages[-1]["content"] if request.messages else ""
    
    async def event_generator():
        try:
            # 使用 agent.run 发起流式请求
            response_stream = paper_agent.run(user_query, stream=True)
            
            for chunk in response_stream:
                if chunk.content:
                    yield chunk.content
                    
            # # 在每次交互后进行记忆压缩
            # if hasattr(paper_agent, "_context_manager"):
            #     all_messages = paper_agent.memory.get_all_messages()
            #     if paper_agent._context_manager.should_compress(all_messages):
            #         # 执行压缩逻辑
            #         paper_agent.memory.messages = paper_agent._context_manager.compress(all_messages)

        except Exception as e:
            yield f"\n\n[Error]: 搜索文献时遇到点麻烦... ({str(e)})"

    return StreamingResponse(event_generator(), media_type="text/plain")

if __name__ == "__main__":
    import uvicorn
    if not os.getenv("MOONSHOT_API_KEY"):
        print("Warning: MOONSHOT_API_KEY not found in environment variables.")
    uvicorn.run(app, host="0.0.0.0", port=8000)