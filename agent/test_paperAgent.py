from openai import OpenAI
import logging
import os

class SimplePaperAgent:
    """
    极简版 Agent，直接透传 OpenAI/Moonshot 的标准流。
    """
    def __init__(self, base_url: str = "https://api.moonshot.cn/v1", model: str = "kimi-k2-thinking-turbo"):
        self.client = OpenAI(
            api_key=os.environ.get("MOONSHOT_API_KEY"), 
            base_url=base_url,
        )
        self.model = model
        # 兼容旧代码的占位符（如果你的业务逻辑依赖它们，否则可以删掉）
        self.memory = type('Obj', (), {'get_all_messages': lambda: []})
        self._context_manager = type('Obj', (), {'should_compress': lambda x: False})

    def run(self, query: str, stream: bool = True):
        logging.info(f"SimpleAgent 正在请求: {query}")
        
        # 直接返回 OpenAI 的原始 response 对象
        # 不需要做任何封装，因为路由层现在能看懂它了
        return self.client.chat.completions.create(
            model=self.model,
            messages=[
                {"role": "system", "content": "你是一个生物信息科研助手。"},
                {"role": "user", "content": query}
            ],
            stream=stream,
            temperature=0.3
        )
        