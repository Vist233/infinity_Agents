"""
paperAgent - Research assistant for academic papers.

Uses Agno framework with Moonshot kimi-k2.5 model.
Features: paper search, paper analysis, methodology visualization.
"""

import os
import sys
import json
from typing import Any, Dict, List, Optional, Iterator
from pathlib import Path

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
from agent.paperReaderWorkflow import PaperReaderWorkflow
from agent.tools.plotly_charts import PlotlyVisualizationTools
from agent.session_db import SessionDatabase, SessionRecord
from agent.papers_db import PapersDatabase


# ============================================================================
# Database-based Cache (replaces JSON file cache)
# ============================================================================

class DatabaseCacheMiddleware:
    """Middleware for caching API responses in SQLite database."""

    def __init__(self, db: PapersDatabase, ttl_seconds: int = 3600):
        self.db = db
        self.ttl_seconds = ttl_seconds
        self._init_cache_table()

    def _init_cache_table(self) -> None:
        """Initialize cache table in the papers database."""
        import sqlite3
        from datetime import datetime
        
        with self.db._get_connection() as conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS cache (
                    cache_key TEXT PRIMARY KEY,
                    func_name TEXT,
                    data TEXT,
                    created_at TEXT,
                    expires_at TEXT
                )
            """)
            conn.execute("""
                CREATE INDEX IF NOT EXISTS idx_cache_expires ON cache(expires_at)
            """)
            conn.commit()
    
    def _get_cache_key(self, func_name: str, *args, **kwargs) -> str:
        """Generate a cache key from function name and arguments."""
        import hashlib
        key_data = f"{func_name}:{args}:{sorted(kwargs.items())}"
        return hashlib.md5(key_data.encode()).hexdigest()

    def get(self, func_name: str, *args, **kwargs) -> Optional[str]:
        """Get cached result if available and not expired."""
        from datetime import datetime
        
        cache_key = self._get_cache_key(func_name, *args, **kwargs)
        
        with self.db._get_connection() as conn:
            row = conn.execute(
                "SELECT data, expires_at FROM cache WHERE cache_key = ?",
                (cache_key,)
            ).fetchone()
            
            if row:
                expires_at = datetime.fromisoformat(row["expires_at"])
                if datetime.utcnow() < expires_at:
                    return row["data"]
                else:
                    # Expired, delete it
                    conn.execute("DELETE FROM cache WHERE cache_key = ?", (cache_key,))
                    conn.commit()
        return None

    def set(self, func_name: str, result: str, *args, **kwargs) -> None:
        """Cache the result."""
        from datetime import datetime, timedelta
        
        cache_key = self._get_cache_key(func_name, *args, **kwargs)
        now = datetime.utcnow()
        expires_at = now + timedelta(seconds=self.ttl_seconds)
        
        with self.db._get_connection() as conn:
            conn.execute("""
                INSERT OR REPLACE INTO cache (cache_key, func_name, data, created_at, expires_at)
                VALUES (?, ?, ?, ?, ?)
            """, (cache_key, func_name, result, now.isoformat(), expires_at.isoformat()))
            conn.commit()


# ============================================================================
# Agent Instructions (optimized)
# ============================================================================

PAPER_AGENT_INSTRUCTIONS = """You are an expert research assistant specialized in academic literature analysis.

## Available Tools

### Paper Search
- `search_papers(query, num_results=5)` - Search ArXiv and PubMed
  - Input: search keywords
  - Output: list of papers (title, authors, abstract, PDF link, etc.)

### Paper Analysis  
- `analyze_paper(pdf_url_or_path)` - Deep analysis of a single paper
  - Input: PDF URL or local path
  - Output: structured analysis report (methodology, tools, parameters, databases, key findings)

### Visualization
- `create_methodology_comparison(paper_reports_json)` - Generate methodology comparison sunburst chart
- `create_tool_frequency(paper_reports_json, top_n=15)` - Generate tool usage frequency bar chart
- `create_custom_sunburst/bar_chart` - Custom charts

## Suggested Workflow

1. **Search papers**: Build appropriate search terms based on user questions, adjust `num_results` for more results
2. **Analyze papers**: Use `analyze_paper` on papers of interest to extract detailed information
3. **Compare & visualize**: After analyzing multiple papers, consider generating visualization charts for comparison
4. **Summarize**: Integrate analysis results and clearly answer user questions

## Important Notes

- **Always respond in Chinese (Simplified)**
- Cite paper sources when referencing
- Explain reasons when tool calls fail
"""


# ============================================================================
# Agent Factory
# ============================================================================

def create_paper_agent(
    api_key: Optional[str] = None,
    base_url: str = "https://api.moonshot.cn/v1",
    model_id: str = "kimi-k2-thinking",
    default_num_results: int = 5,
    papers_db: Optional[PapersDatabase] = None,
) -> Agent:
    """
    Create a paperAgent instance.

    Args:
        api_key: Moonshot API key. Defaults to MOONSHOT_API_KEY env var.
        base_url: API base URL.
        model_id: Model identifier.
        default_num_results: Default number of search results.
        papers_db: Optional PapersDatabase instance for caching.

    Returns:
        Configured Agent instance.
    """
    api_key = api_key or os.environ.get("MOONSHOT_API_KEY")
    if not api_key:
        raise ValueError(
            "API key required. Set MOONSHOT_API_KEY environment variable."
        )

    # Configure model
    model = OpenAILike(
        id=model_id,
        api_key=api_key,
        base_url=base_url,
    )

    # Configure tools with database cache
    if papers_db is None:
        papers_db = PapersDatabase()
    
    cache_middleware = DatabaseCacheMiddleware(papers_db, ttl_seconds=3600)
    size_middleware = SizeMiddleware(max_chars=50000, max_articles=default_num_results)

    tools = [
        PaperSearchTools(
            cache_middleware=cache_middleware,
            size_middleware=size_middleware,
        ),
        PaperReaderWorkflow(
            api_key=api_key,
            base_url=base_url,
            model_id=model_id,
            db=papers_db,
        ),
        PlotlyVisualizationTools(),
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
        model_id: str = "kimi-k2-thinking-turbo",
        default_num_results: int = 5,
        max_context_messages: int = 20,
    ):
        self.user_id = user_id
        self.max_context_messages = max_context_messages
        
        self.session_db = SessionDatabase()
        self.papers_db = PapersDatabase()
        
        self.agent = create_paper_agent(
            api_key=api_key,
            base_url=base_url,
            model_id=model_id,
            default_num_results=default_num_results,
            papers_db=self.papers_db,
        )
        
        self.session_id: Optional[str] = None
        self.messages: List[Dict] = []
    
    def start_session(self, session_id: Optional[str] = None) -> str:
        """Start or resume a session."""
        if session_id:
            record = self.session_db.get_session(self.user_id, session_id)
            if record:
                self.session_id = session_id
                self.messages = record.messages
                print(f"📂 恢复会话: {session_id}")
                if record.title:
                    print(f"   主题: {record.title}")
                return session_id
            else:
                print(f"⚠️  会话 {session_id} 不存在，创建新会话")
        
        # Create new session
        self.session_id = self.session_db.create_session(self.user_id)
        self.messages = []
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
        return self.session_db.delete_session(self.user_id, session_id)


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
