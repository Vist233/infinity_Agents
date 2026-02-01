from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import List
from fastapi.middleware.cors import CORSMiddleware
import os
from openai import AsyncOpenAI

class ChatService:
    def __init__(self):
        self.client = AsyncOpenAI(
            api_key=os.getenv("MOONSHOT_API_KEY"),
            base_url="https://api.moonshot.cn/v1",
        )
        self.model = "kimi-k2-turbo-preview"

    async def get_streaming_response(self, messages):
        """
        接收消息历史，返回流式生成器
        messages 格式: [{"role": "user", "content": "..."}]
        """
        try:
            response = await self.client.chat.completions.create(
                model=self.model,
                messages=messages,
                stream=True
            )

            async for chunk in response:
                delta = chunk.choices[0].delta
                if delta.content:
                    yield delta.content 
                    
        except Exception as e:
            yield f"Error: 脑子卡住了喵... ({str(e)})"

app = FastAPI()
chat = ChatService()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  
    allow_methods=["*"],
    allow_headers=["*"],
)

class ChatRequest(BaseModel):
    messages: List[dict]

@app.post("/chat")
async def chat_endpoint(request: ChatRequest):
    """
    Web API 接口：接收前端传来的消息历史，流式返回结果
    """
    async def event_generator():
        async for text in chat.get_streaming_response(request.messages):
            yield text

    return StreamingResponse(event_generator(), media_type="text/plain")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)