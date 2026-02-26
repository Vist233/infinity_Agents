"""
paperAgent - Research assistant for academic papers.

Uses Agno framework with Moonshot kimi-k2.5 model.
Features: paper search, paper reading, methodology visualization, image analysis.
"""

import os
import sys
import json
from typing import Any, Dict, List, Optional, Iterator, Literal
from pathlib import Path
import shutil
from datetime import datetime, timezone

# Fix imports when running as script
if __name__ == "__main__":
    current_file = Path(__file__).resolve()
    project_root = current_file.parent.parent
    if str(project_root) not in sys.path:
        sys.path.insert(0, str(project_root))

from agno.agent import Agent
from agno.models.openai import OpenAILike
from agno.utils.pprint import pprint_run_response

# Import tools
from agent.tools.paper_search import PaperSearchTools, SizeMiddleware
# [DISABLED] Plotting tools temporarily disabled
# from agent.tools.plotly_charts import PlotlyVisualizationTools
# from agent.tools.python_plotter import PythonPlottingTools
from agent.tools.file_tools import FileSystemTools
from agent.tools.image_analyzer import ImageAnalysisTools
from agent.session_repo_pg import SessionRepoPG, SessionRecord
from agent.papers_repo_pg import PapersRepoPG

PROJECT_ROOT = Path(__file__).resolve().parent.parent
GLOBAL_PAPERS_CACHE_ROOT = PROJECT_ROOT / "papers" / "cache"

# ============================================================================
# Database-based Cache (replaces JSON file cache)
# ============================================================================

class DatabaseCacheMiddleware:
    """Middleware for caching API responses in PostgreSQL table."""

    def __init__(self, db: PapersRepoPG, ttl_seconds: int = 3600):
        self.db = db
        self.ttl_seconds = ttl_seconds
    
    def _get_cache_key(self, func_name: str, *args, **kwargs) -> str:
        """Generate a cache key from function name and arguments."""
        import hashlib
        key_data = f"{func_name}:{args}:{sorted(kwargs.items())}"
        return hashlib.md5(key_data.encode()).hexdigest()

    def get(self, func_name: str, *args, **kwargs) -> Optional[str]:
        """Get cached result if available and not expired."""
        cache_key = self._get_cache_key(func_name, *args, **kwargs)
        row = self.db.get_cache(cache_key)
        if row:
            expires_at = row["expires_at"]
            if isinstance(expires_at, str):
                expires_at = datetime.fromisoformat(expires_at)
            if expires_at.tzinfo is None:
                expires_at = expires_at.replace(tzinfo=timezone.utc)
            if datetime.now(tz=timezone.utc) < expires_at:
                return row["data"]
            self.db.delete_cache(cache_key)
        return None

    def set(self, func_name: str, result: str, *args, **kwargs) -> None:
        """Cache the result."""
        cache_key = self._get_cache_key(func_name, *args, **kwargs)
        self.db.set_cache(cache_key, func_name, result, self.ttl_seconds)


# ============================================================================
# Agent Instructions (optimized)
# ============================================================================

PAPER_AGENT_INSTRUCTIONS = """You are an expert research assistant specialized in academic literature analysis.

## Available Tools

### Paper Search
- `search_paper(query, num_results=5)` - Search ArXiv

### Paper Reading
- `read_paper(paper_ref, action="cat", pattern=None, start_line=1, max_lines=200, case_sensitive=False)`
  - Fine-grained reading/searching on canonical paper Markdown
  - If not cached, automatically downloads/extracts PDF and materializes Markdown cache
  - Supports uploaded session paper refs: `uploaded://{paper_id}`

# ### Plotting & Visualization (DISABLED)
# - `create_chart(code, filename, chart_type)` - Execute Python code to create charts (matplotlib/plotly)
# - `create_bar_chart(data, title, ...)` - Quick bar chart from data dict
# - `create_line_chart(x_data, y_data, title, ...)` - Quick line chart
# - `create_methodology_comparison(paper_reports_json)` - Sunburst chart comparing methodologies
# - `create_tool_frequency(paper_reports_json)` - Tool usage frequency chart

### File & Image Understanding
- `list_files(directory="")` - List files/folders in session sandbox and shared cache
- `read_file(file_path, max_chars=50000)` - Read text files (JSON/MD/TXT)
- `read_image(file_path)` - Resolve image and return canonical image reference + markdown
- `analyze_image(image_path, prompt=...)` - Analyze chart/figure/image content with vision model
  - `file_path/image_path` 支持多种输入：相对路径、绝对路径、`img://./...`、`![...](img://./...)`、`/api/sessions/{id}/files/...`

## Recommended Workflow

1. **Search**: Use `search_paper` to find relevant papers
2. **Deep dive**: Use `read_paper` for detailed reading/grep/head/tail/outline
   - Search 与 Read 需要分步执行，不要在同一轮对搜索结果批量一次性全部阅读
   - 例外：当用户明确提供单篇 `pdf_url` 时，可以直接调用 `read_paper` 读取该单篇论文
# 3. **Visualize**: Use `create_chart` or quick chart tools to generate analytical plots (DISABLED)
#    - 绘图代码只负责绘制，不要在代码中手动保存图片
4. **Inspect images**: Use `read_image`/`analyze_image` for chart outputs, extracted figures, and local screenshots
5. **Embed images**: All chart/image tools return a `markdown` field like `![chart](img://./xxx.png)`.
   Copy this exact Markdown into your response — the system will automatically render the image.
   NEVER modify the `img://` reference or try to construct one yourself.
   新标准统一使用 `img://./...`，由后端将 `./` 映射到会话可访问的真实文件路径。
   在 Ubuntu 22 环境下，绘图时优先使用系统 CJK 字体（如 Noto Sans CJK），避免中文标题/坐标轴出现方块字；优先沿用工具默认字体配置，不要覆盖为不支持中文的字体。
6. **Summarize**: Integrate findings and answer the user's question

## Important Notes

- **Always respond in Chinese (Simplified)**
- Cite paper sources with titles and IDs when referencing
- When embedding charts, use the `markdown` field from the tool response directly
- For follow-up detailed reading, prefer `read_paper`
- Access control: only papers searched/read in this session are readable
- Uploaded PDFs in the current session are readable via `read_paper("uploaded://{paper_id}")`
- When the user asks to output an operation manual, use this template:
  1. Per-paper card: data type, software/version, commands or pseudo-commands, input->process->output, downstream usage, observed phenotype/conclusion.
  2. Cross-paper unified pipeline.
  3. Risks and missing parameters.
  4. Executable checklist.
  5. If a flow is needed, output a `mermaid` code block.
"""


# ============================================================================
# Agent Factory
# ============================================================================

def create_paper_agent(
    api_key: Optional[str] = None,
    base_url: str = "https://api.moonshot.cn/v1",
    chat_model_id: Optional[str] = None,
    vision_model_id: Optional[str] = None,
    workflow_model_id: Optional[str] = None,
    default_num_results: int = 5,
    papers_db: Optional[PapersRepoPG] = None,
    session_id: Optional[str] = None,
    session_root: Optional[Path] = None,
    storage_mode: Literal["legacy", "sandboxed"] = "legacy",
) -> Agent:
    """
    Create a paperAgent instance.

    Args:
        api_key: Moonshot API key. Defaults to MOONSHOT_API_KEY env var.
        base_url: API base URL.
        chat_model_id: Chat orchestration model identifier. Defaults to kimi-k2.5.
        vision_model_id: Vision model identifier. Defaults to PAPER_AGENT_VISION_MODEL or chat model.
        workflow_model_id: Deprecated, kept for API compatibility.
        default_num_results: Default number of search results.
        papers_db: Optional PapersRepoPG instance for caching.

    Returns:
        Configured Agent instance.
    """
    GLOBAL_PAPERS_CACHE_ROOT.mkdir(parents=True, exist_ok=True)
    api_key = api_key or os.environ.get("MOONSHOT_API_KEY")
    if not api_key:
        raise ValueError(
            "API key required. Set MOONSHOT_API_KEY environment variable."
        )
    chat_model_id = (chat_model_id or os.environ.get("PAPER_AGENT_CHAT_MODEL") or "kimi-k2.5").strip()
    if chat_model_id in {"kimi-k2-thinking-turbo", "kimi-k2-turbo"}:
        chat_model_id = "kimi-k2.5"
    if not chat_model_id:
        chat_model_id = "kimi-k2.5"
    vision_model_id = (vision_model_id or os.environ.get("PAPER_AGENT_VISION_MODEL") or chat_model_id).strip()
    if not vision_model_id:
        vision_model_id = chat_model_id
    _ = workflow_model_id
    disable_chat_thinking = os.environ.get("PAPER_AGENT_CHAT_DISABLE_THINKING", "1").strip().lower() not in {"0", "false", "no", "off"}
    chat_extra_body = {"thinking": {"type": "disabled"}} if disable_chat_thinking else None

    # Configure model
    model = OpenAILike(
        id=chat_model_id,
        api_key=api_key,
        base_url=base_url,
        extra_body=chat_extra_body,
    )

    # Configure tools with database cache
    if papers_db is None:
        effective_session_id = session_id or "00000000-0000-0000-0000-000000000000"
        papers_db = PapersRepoPG(session_id=effective_session_id)
    
    cache_middleware = DatabaseCacheMiddleware(papers_db, ttl_seconds=3600)
    size_middleware = SizeMiddleware(max_chars=50000, max_articles=default_num_results)
    # [DISABLED] Plotting output dirs
    # plot_output_dir = session_root / "plot_outputs" if session_root is not None else None
    # plotly_output_dir = session_root / "plotly_outputs" if session_root is not None else None
    shared_papers_dir = GLOBAL_PAPERS_CACHE_ROOT
    allowed_file_dirs = [
        shared_papers_dir,
        shared_papers_dir / "downloads",
        shared_papers_dir / "md",
        shared_papers_dir / "extracted",
        shared_papers_dir / "reports",
    ]
    if session_root is not None:
        allowed_file_dirs.extend(
            [
                session_root,
                # session_root / "plot_outputs",    # [DISABLED]
                # session_root / "plotly_outputs",  # [DISABLED]
                session_root / "reports",
                session_root / "md",
                session_root / "extracted",
            ]
        )

    tools = [
        PaperSearchTools(
            enable_read=True,
            cache_middleware=cache_middleware,
            size_middleware=size_middleware,
            papers_db=papers_db,
            download_dir=shared_papers_dir / "downloads",
            shared_cache_root=shared_papers_dir,
        ),
        # [DISABLED] Plotting tools
        # PlotlyVisualizationTools(output_dir=plotly_output_dir),
        # PythonPlottingTools(output_dir=plot_output_dir),
        FileSystemTools(allowed_dirs=allowed_file_dirs),
        ImageAnalysisTools(
            api_key=api_key,
            base_url=base_url,
            model_id=vision_model_id,
            allowed_dirs=allowed_file_dirs,
        ),
    ]

    # Create agent with streaming enabled
    agent = Agent(
        model=model,
        tools=tools,
        instructions=PAPER_AGENT_INSTRUCTIONS,
        markdown=True,
        description="PaperAgent: 生物信息学论文研究助手",
        stream=True,  # Enable streaming
        debug_mode=True,
    )

    return agent


# ============================================================================
# Interactive Runner with Streaming
# ============================================================================

class PaperAgentRunner:
    """
    Interactive runner for PaperAgent with session management and streaming output.
    """
    
    def __init__(
        self,
        user_id: str = "default_user",
        api_key: Optional[str] = None,
        base_url: str = "https://api.moonshot.cn/v1",
        chat_model_id: str = "kimi-k2.5",
        vision_model_id: Optional[str] = None,
        workflow_model_id: str = "kimi-k2.5",
        default_num_results: int = 5,
        max_context_messages: int = 20,
    ):
        self.user_id = user_id
        self.max_context_messages = max_context_messages
        self.api_key = api_key
        self.base_url = base_url
        self.chat_model_id = chat_model_id
        self.vision_model_id = vision_model_id
        self.workflow_model_id = workflow_model_id
        self.default_num_results = default_num_results
        self.sessions_root = Path(__file__).resolve().parent.parent / "papers" / "sessions"
        
        self.session_db = SessionRepoPG()
        self.papers_db: Optional[PapersRepoPG] = None
        self.agent: Optional[Agent] = None
        
        self.session_id: Optional[str] = None
        self.messages: List[Dict] = []

    def _session_root(self, session_id: str) -> Path:
        """Resolve workspace root for a given session."""
        return self.sessions_root / session_id

    def _bind_session_workspace(self, session_id: str) -> None:
        """
        Bind runner agent/tools to a session-local workspace.
        Keeps per-session files isolated under papers/sessions/{session_id}.
        """
        session_root = self._session_root(session_id)
        session_root.mkdir(parents=True, exist_ok=True)
        self.papers_db = PapersRepoPG(session_id=session_id)
        self.agent = create_paper_agent(
            api_key=self.api_key,
            base_url=self.base_url,
            chat_model_id=self.chat_model_id,
            vision_model_id=self.vision_model_id,
            workflow_model_id=self.workflow_model_id,
            default_num_results=self.default_num_results,
            papers_db=self.papers_db,
            session_id=session_id,
            session_root=session_root,
            storage_mode="sandboxed",
        )
    
    def start_session(self, session_id: Optional[str] = None) -> str:
        """Start or resume a session."""
        if session_id:
            record = self.session_db.get_session(self.user_id, session_id)
            if record:
                self.session_id = session_id
                self.messages = record.messages
                self._bind_session_workspace(self.session_id)
                print(f"📂 恢复会话: {session_id}")
                if record.title:
                    print(f"   主题: {record.title}")
                return session_id
            else:
                print(f"⚠️  会话 {session_id} 不存在，创建新会话")
        
        # Create new session
        self.session_id = self.session_db.create_session(self.user_id, storage_mode="sandboxed")
        self.messages = []
        self._bind_session_workspace(self.session_id)
        print(f"✨ 新会话: {self.session_id}")
        return self.session_id
    
    def chat(self, user_message: str) -> str:
        """Process a user message with streaming output."""
        if not self.session_id:
            self.start_session()
        
        # Add user message to history
        self.messages.append({"role": "user", "content": user_message})
        
        # Build context
        context_messages = self._build_context()
        context_str = self._format_context(context_messages)
        full_prompt = f"{context_str}\n\nUser: {user_message}" if context_str else user_message
        
        # Run agent with streaming
        try:
            response_content = self._run_with_streaming(full_prompt)
            
            # Add assistant message to history
            self.messages.append({"role": "assistant", "content": response_content})
            
            # Save to database
            self._save_session()
            
            return response_content
            
        except Exception as e:
            error_msg = f"❌ 错误: {str(e)}"
            self.messages.append({"role": "assistant", "content": error_msg})
            self._save_session()
            return error_msg
    
    def _run_with_streaming(self, prompt: str) -> str:
        """Run agent and stream output to terminal."""
        if self.agent is None:
            raise RuntimeError("Agent not initialized. Please start a session first.")
        response = self.agent.run(prompt, stream=True)
        
        full_content = []
        current_tool = None
        
        print()  # New line before output
        
        for chunk in response:
            # Check for tool calls
            if hasattr(chunk, 'tools') and chunk.tools:
                for tool in chunk.tools:
                    tool_name = getattr(tool, 'name', None) or getattr(tool, 'function', {}).get('name', 'unknown')
                    if tool_name != current_tool:
                        current_tool = tool_name
                        print(f"\n🔧 调用工具: {tool_name}")
            
            # Stream text content
            if hasattr(chunk, 'content') and chunk.content:
                content = chunk.content
                if isinstance(content, str):
                    print(content, end='', flush=True)
                    full_content.append(content)
                elif isinstance(content, list):
                    for item in content:
                        if isinstance(item, str):
                            print(item, end='', flush=True)
                            full_content.append(item)
        
        print()  # New line after output
        return ''.join(full_content)
    
    def _build_context(self) -> List[Dict]:
        """Build context from recent messages."""
        history = self.messages[:-1]
        if len(history) > self.max_context_messages:
            history = history[-self.max_context_messages:]
        return history
    
    def _format_context(self, messages: List[Dict]) -> str:
        """Format messages into context string."""
        if not messages:
            return ""
        
        context_parts = ["[对话历史]"]
        for msg in messages:
            role = "用户" if msg.get("role") == "user" else "助手"
            content = msg.get("content", "")
            if len(content) > 500:
                content = content[:500] + "..."
            context_parts.append(f"{role}: {content}")
        
        return "\n".join(context_parts)
    
    def _save_session(self, title: Optional[str] = None) -> None:
        """Save current session to database."""
        if not self.session_id:
            return
        
        if title is None and len(self.messages) >= 1:
            first_user_msg = next(
                (m for m in self.messages if m.get("role") == "user"),
                None
            )
            if first_user_msg:
                title = first_user_msg.get("content", "")[:50]
        
        self.session_db.save_messages(
            self.user_id,
            self.session_id,
            self.messages,
            title=title,
        )
    
    def list_sessions(self, limit: int = 10) -> List[SessionRecord]:
        """List recent sessions."""
        return self.session_db.list_sessions(self.user_id, limit)
    
    def delete_session(self, session_id: str) -> bool:
        """Delete a session."""
        deleted = self.session_db.delete_session(self.user_id, session_id)
        if deleted:
            session_root = self._session_root(session_id)
            if session_root.exists():
                shutil.rmtree(session_root, ignore_errors=True)
        return deleted


# ============================================================================
# Module-level default agent
# ============================================================================

_default_agent: Optional[Agent] = None

def get_paper_agent() -> Agent:
    """Get or create the default paperAgent instance."""
    global _default_agent
    if _default_agent is None:
        _default_agent = create_paper_agent()
    return _default_agent


# ============================================================================
# CLI Entry Point
# ============================================================================

if __name__ == "__main__":
    print("=" * 60)
    print("📚 PaperAgent - 生物信息学论文研究助手")
    print("=" * 60)
    print("\n命令:")
    print("  /new           - 创建新会话")
    print("  /sessions      - 列出历史会话 (显示完整ID)")
    print("  /resume <id>   - 恢复指定会话")
    print("  /delete <id>   - 删除指定会话")
    print("  /exit          - 退出程序")
    print("=" * 60)
    
    user_id = os.environ.get("PAPER_AGENT_USER", "default_user")
    runner = PaperAgentRunner(user_id=user_id)
    runner.start_session()
    
    while True:
        try:
            user_input = input("\n> ").strip()
        except (KeyboardInterrupt, EOFError):
            print("\n👋 再见!")
            break
        
        if not user_input:
            continue
        
        # Handle commands
        if user_input.startswith("/"):
            parts = user_input.split(maxsplit=1)
            cmd = parts[0].lower()
            arg = parts[1] if len(parts) > 1 else None
            
            if cmd == "/exit":
                print("👋 再见!")
                break
            
            elif cmd == "/new":
                runner.start_session()
                continue
            
            elif cmd == "/sessions":
                sessions = runner.list_sessions(limit=20)
                if sessions:
                    print("\n📁 历史会话:")
                    print("-" * 70)
                    for s in sessions:
                        title = s.title or "(无标题)"
                        # Show full session_id
                        print(f"ID: {s.session_id}")
                        print(f"    标题: {title[:40]}")
                        print(f"    更新: {s.updated_at}")
                        print()
                else:
                    print("暂无历史会话")
                continue
            
            elif cmd == "/resume":
                if arg:
                    sessions = runner.list_sessions(limit=50)
                    matched = [s for s in sessions if s.session_id.startswith(arg)]
                    if len(matched) == 1:
                        runner.start_session(matched[0].session_id)
                    elif len(matched) > 1:
                        print(f"⚠️  多个会话匹配 '{arg}':")
                        for m in matched:
                            print(f"  - {m.session_id}")
                    else:
                        print(f"❌ 未找到会话: {arg}")
                else:
                    print("用法: /resume <session_id>")
                continue
            
            elif cmd == "/delete":
                if arg:
                    sessions = runner.list_sessions(limit=50)
                    matched = [s for s in sessions if s.session_id.startswith(arg)]
                    if len(matched) == 1:
                        if runner.delete_session(matched[0].session_id):
                            print(f"🗑️  已删除会话: {matched[0].session_id}")
                        else:
                            print("❌ 删除失败")
                    elif len(matched) > 1:
                        print(f"⚠️  多个会话匹配 '{arg}'")
                    else:
                        print(f"❌ 未找到会话: {arg}")
                else:
                    print("用法: /delete <session_id>")
                continue
            
            else:
                print(f"❓ 未知命令: {cmd}")
                continue
        
        # Process user message (streaming output)
        response = runner.chat(user_input)
