"""
paperAgent - Research assistant for academic papers.

Uses Agno framework with Moonshot kimi-k2.5 model.
Features: paper search, paper analysis workflow, methodology visualization.
"""

import os
import sys
import json
import uuid
from typing import Any, Dict, List, Optional
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
from agent.tools.paper_search import PaperSearchTools, CacheMiddleware, SizeMiddleware
from agent.paperReaderWorkflow import PaperReaderWorkflow
from agent.tools.plotly_charts import PlotlyVisualizationTools
from agent.session_db import SessionDatabase, SessionRecord


# Agent instructions
PAPER_AGENT_INSTRUCTIONS = """You are an expert research assistant specialized in bioinformatics and academic literature analysis.

## Your Workflow

When a user requests research on a topic, follow this workflow:

1. **Search Papers**: Use `search_papers` to find relevant papers on the topic. Default returns 5 papers but you can request more with `num_results`.

2. **Analyze Papers**: For each relevant paper, use `analyze_paper` to generate a detailed methodology report. This extracts:
   - Pipeline steps and tools used
   - Parameters and settings
   - Database references
   - Key findings

3. **Compare & Visualize**: After analyzing multiple papers, use visualization tools to:
   - Create methodology comparison sunburst charts with `create_methodology_comparison`
   - Show tool frequency across papers with `create_tool_frequency`

4. **Summarize**: Provide a comprehensive summary of:
   - Common methodologies across papers
   - Recommended best practices
   - Tool/software landscape

## Guidelines

- When searching, be specific with bioinformatics keywords
- Analyze at least 3-5 papers for meaningful comparison
- Always generate visualization for multi-paper analysis
- Format responses in clear Chinese markdown
- Include citations to source papers

## Available Tools

1. `search_papers(query, num_results=5)` - Search ArXiv + PubMed
2. `analyze_paper(pdf_url_or_path)` - Generate methodology report from PDF
3. `create_methodology_comparison(paper_reports_json)` - Sunburst chart
4. `create_tool_frequency(paper_reports_json, top_n=15)` - Bar chart
5. `create_custom_sunburst(labels, parents, values, title)` - Custom visualization
6. `create_custom_bar_chart(data_json, title, xlabel, ylabel)` - Custom bar chart
"""


def create_paper_agent(
    api_key: Optional[str] = None,
    base_url: str = "https://api.moonshot.cn/v1",
    model_id: str = "kimi-k2-thinking-turbo",
    default_num_results: int = 5,
) -> Agent:
    """
    Create a paperAgent instance.

    Args:
        api_key: Moonshot API key. Defaults to MOONSHOT_API_KEY env var.
        base_url: API base URL.
        model_id: Model identifier.
        default_num_results: Default number of search results.

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

    # Configure tools with middleware
    cache_middleware = CacheMiddleware(ttl_seconds=3600)
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
        ),
        PlotlyVisualizationTools(),
    ]

    # Create agent
    agent = Agent(
        model=model,
        tools=tools,
        instructions=PAPER_AGENT_INSTRUCTIONS,
        markdown=True,
        description="PaperAgent: Research assistant for bioinformatics papers with search, analysis, and visualization.",
        debug_mode=False,
    )

    return agent


class PaperAgentRunner:
    """
    Interactive runner for PaperAgent with session management.
    
    Manages conversation history via SQLite for context persistence.
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
        
        self.db = SessionDatabase()
        self.agent = create_paper_agent(
            api_key=api_key,
            base_url=base_url,
            model_id=model_id,
            default_num_results=default_num_results,
        )
        
        self.session_id: Optional[str] = None
        self.messages: List[Dict] = []
    
    def start_session(self, session_id: Optional[str] = None) -> str:
        """
        Start or resume a session.
        
        Args:
            session_id: Existing session ID to resume. If None, creates new session.
        
        Returns:
            The session ID.
        """
        if session_id:
            record = self.db.get_session(self.user_id, session_id)
            if record:
                self.session_id = session_id
                self.messages = record.messages
                print(f"Resumed session: {session_id}")
                if record.title:
                    print(f"Session topic: {record.title}")
                return session_id
            else:
                print(f"Session {session_id} not found. Creating new session.")
        
        # Create new session
        self.session_id = self.db.create_session(self.user_id)
        self.messages = []
        print(f"New session created: {self.session_id}")
        return self.session_id
    
    def chat(self, user_message: str) -> str:
        """
        Process a user message and return the agent's response.
        
        Args:
            user_message: The user's input.
        
        Returns:
            The agent's response.
        """
        if not self.session_id:
            self.start_session()
        
        # Add user message to history
        self.messages.append({"role": "user", "content": user_message})
        
        # Build context (limit to recent messages)
        context_messages = self._build_context()
        
        # Build the full prompt including context
        context_str = self._format_context(context_messages)
        full_prompt = f"{context_str}\n\nUser: {user_message}" if context_str else user_message
        
        # Run agent
        try:
            response = self.agent.run(full_prompt)
            
            # Extract response content
            response_content = self._extract_response(response)
            
            # Add assistant message to history
            self.messages.append({"role": "assistant", "content": response_content})
            
            # Save to database
            self._save_session()
            
            return response_content
            
        except Exception as e:
            error_msg = f"Error: {str(e)}"
            self.messages.append({"role": "assistant", "content": error_msg})
            self._save_session()
            return error_msg
    
    def _build_context(self) -> List[Dict]:
        """Build context from recent messages."""
        # Skip the last message (just added)
        history = self.messages[:-1]
        
        # Limit to max_context_messages
        if len(history) > self.max_context_messages:
            history = history[-self.max_context_messages:]
        
        return history
    
    def _format_context(self, messages: List[Dict]) -> str:
        """Format messages into context string."""
        if not messages:
            return ""
        
        context_parts = ["[Previous conversation context]"]
        for msg in messages:
            role = msg.get("role", "unknown")
            content = msg.get("content", "")
            # Truncate long messages
            if len(content) > 500:
                content = content[:500] + "..."
            context_parts.append(f"{role.capitalize()}: {content}")
        
        return "\n".join(context_parts)
    
    def _extract_response(self, response: Any) -> str:
        """Extract text content from agent response."""
        if hasattr(response, "content"):
            if isinstance(response.content, str):
                return response.content
            elif isinstance(response.content, list):
                return "\n".join(str(item) for item in response.content)
        
        # Try to get from messages
        if hasattr(response, "messages") and response.messages:
            for msg in reversed(response.messages):
                if hasattr(msg, "content") and msg.content:
                    return str(msg.content)
        
        return str(response)
    
    def _save_session(self, title: Optional[str] = None) -> None:
        """Save current session to database."""
        if not self.session_id:
            return
        
        # Auto-generate title from first user message
        if title is None and len(self.messages) >= 1:
            first_user_msg = next(
                (m for m in self.messages if m.get("role") == "user"),
                None
            )
            if first_user_msg:
                title = first_user_msg.get("content", "")[:50]
        
        self.db.save_messages(
            self.user_id,
            self.session_id,
            self.messages,
            title=title,
        )
    
    def list_sessions(self, limit: int = 10) -> List[SessionRecord]:
        """List recent sessions."""
        return self.db.list_sessions(self.user_id, limit)
    
    def delete_session(self, session_id: str) -> bool:
        """Delete a session."""
        return self.db.delete_session(self.user_id, session_id)


# Module-level default agent instance
_default_agent: Optional[Agent] = None


def get_paper_agent() -> Agent:
    """Get or create the default paperAgent instance."""
    global _default_agent
    if _default_agent is None:
        _default_agent = create_paper_agent()
    return _default_agent


if __name__ == "__main__":
    print("=" * 60)
    print("PaperAgent - 生物信息学论文研究助手")
    print("=" * 60)
    print("\n命令:")
    print("  /new           - 创建新会话")
    print("  /sessions      - 列出历史会话")
    print("  /resume <id>   - 恢复指定会话")
    print("  /exit          - 退出程序")
    print("=" * 60)
    
    user_id = os.environ.get("PAPER_AGENT_USER", "default_user")
    runner = PaperAgentRunner(user_id=user_id)
    runner.start_session()
    
    while True:
        try:
            user_input = input("\n> ").strip()
        except (KeyboardInterrupt, EOFError):
            print("\n再见!")
            break
        
        if not user_input:
            continue
        
        # Handle commands
        if user_input.startswith("/"):
            parts = user_input.split(maxsplit=1)
            cmd = parts[0].lower()
            arg = parts[1] if len(parts) > 1 else None
            
            if cmd == "/exit":
                print("再见!")
                break
            
            elif cmd == "/new":
                runner.start_session()
                continue
            
            elif cmd == "/sessions":
                sessions = runner.list_sessions()
                if sessions:
                    print("\n历史会话:")
                    for s in sessions:
                        title = s.title or "(无标题)"
                        print(f"  {s.session_id[:8]}... | {title[:30]} | {s.updated_at}")
                else:
                    print("暂无历史会话")
                continue
            
            elif cmd == "/resume":
                if arg:
                    # Support partial ID match
                    sessions = runner.list_sessions(limit=50)
                    matched = [s for s in sessions if s.session_id.startswith(arg)]
                    if len(matched) == 1:
                        runner.start_session(matched[0].session_id)
                    elif len(matched) > 1:
                        print(f"多个会话匹配 '{arg}'，请提供更完整的 ID")
                    else:
                        print(f"未找到会话: {arg}")
                else:
                    print("用法: /resume <session_id>")
                continue
            
            else:
                print(f"未知命令: {cmd}")
                continue
        
        # Process user message
        print("\n思考中...")
        response = runner.chat(user_input)
        print("\n" + response)
