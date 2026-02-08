"""
paperAgent - Research assistant for academic papers.

Uses Agno framework with Moonshot kimi-k2.5 model.
Features: paper search, text viewing, plotting, context management.
"""

import os
import json
from typing import Any, Dict, List, Optional
from dataclasses import dataclass, field

from agno.agent import Agent
from agno.models.openai import OpenAILike

# Import tools
from agent.tools.paper_search import PaperSearchTools, CacheMiddleware, SizeMiddleware
from agent.tools.paper_viewer import PaperViewerTools, RegexForceMiddleware
from agent.tools.python_plotter import PythonPlottingTools
from agent.paperReaderWorkflow import PaperReaderWorkflow


@dataclass
class PaperReference:
    """Compressed paper reference for context management."""
    url: str
    title: str
    abstract: str
    paper_id: Optional[str] = None


@dataclass
class ToolCallRecord:
    """Record of a tool call for context management."""
    tool_name: str
    arguments: Dict[str, Any]
    result_summary: str
    paper_references: List[PaperReference] = field(default_factory=list)
    is_compressed: bool = False


class ContextManager:
    """
    Manages context window usage with automatic compression.
    
    When context reaches 93% capacity, compresses older tool calls
    by keeping only the last 3 in full, converting others to paper
    reference summaries (url, title, abstract).
    """

    MAX_CONTEXT_RATIO = 0.93
    KEEP_RECENT_TOOLS = 3
    # Approximate token count (chars / 4)
    MAX_CONTEXT_TOKENS = 128000

    def __init__(self):
        self.tool_history: List[ToolCallRecord] = []
        self.compressed_references: List[PaperReference] = []
        self.context_saves: List[str] = []  # Saved context snapshots

    def estimate_tokens(self, text: str) -> int:
        """Rough token estimation (1 token ≈ 4 chars for English)."""
        return len(text) // 4

    def get_current_context_size(self, messages: List[Dict]) -> int:
        """Estimate current context size in tokens."""
        total_text = json.dumps(messages, ensure_ascii=False)
        return self.estimate_tokens(total_text)

    def should_compress(self, messages: List[Dict]) -> bool:
        """Check if context needs compression."""
        current_size = self.get_current_context_size(messages)
        threshold = int(self.MAX_CONTEXT_TOKENS * self.MAX_CONTEXT_RATIO)
        return current_size >= threshold

    def record_tool_call(
        self,
        tool_name: str,
        arguments: Dict[str, Any],
        result: str,
    ) -> None:
        """Record a tool call for potential compression."""
        # Extract paper references from result
        references = self._extract_paper_references(tool_name, result)

        record = ToolCallRecord(
            tool_name=tool_name,
            arguments=arguments,
            result_summary=result[:500] + "..." if len(result) > 500 else result,
            paper_references=references,
        )
        self.tool_history.append(record)

    def _extract_paper_references(
        self,
        tool_name: str,
        result: str,
    ) -> List[PaperReference]:
        """Extract paper references from tool results."""
        references = []
        
        try:
            data = json.loads(result)
            
            # Handle list of papers
            if isinstance(data, list):
                for item in data:
                    if isinstance(item, dict) and "title" in item:
                        ref = PaperReference(
                            url=item.get("pdf_url") or item.get("url") or item.get("entry_id", ""),
                            title=item.get("title", "Unknown"),
                            abstract=item.get("summary") or item.get("abstract", "")[:200],
                            paper_id=item.get("id") or item.get("pmid"),
                        )
                        references.append(ref)
            
            # Handle single paper
            elif isinstance(data, dict) and "title" in data:
                ref = PaperReference(
                    url=data.get("pdf_url") or data.get("entry_id", ""),
                    title=data.get("title", "Unknown"),
                    abstract=data.get("summary", "")[:200],
                    paper_id=data.get("id"),
                )
                references.append(ref)
                
        except (json.JSONDecodeError, TypeError):
            pass

        return references

    def compress(self, messages: List[Dict]) -> List[Dict]:
        """
        Compress context by:
        1. Saving current context to storage
        2. Keeping only last 3 tool calls in full
        3. Converting older calls to paper reference summaries
        """
        if len(self.tool_history) <= self.KEEP_RECENT_TOOLS:
            return messages

        # Save context snapshot
        self.context_saves.append(json.dumps(messages, ensure_ascii=False))

        # Separate recent and old tool calls
        old_tools = self.tool_history[:-self.KEEP_RECENT_TOOLS]
        recent_tools = self.tool_history[-self.KEEP_RECENT_TOOLS:]

        # Extract all paper references from old tools
        for tool_record in old_tools:
            tool_record.is_compressed = True
            self.compressed_references.extend(tool_record.paper_references)

        # Remove duplicates by paper_id/url
        seen = set()
        unique_refs = []
        for ref in self.compressed_references:
            key = ref.paper_id or ref.url
            if key and key not in seen:
                seen.add(key)
                unique_refs.append(ref)
        self.compressed_references = unique_refs

        # Update tool history
        self.tool_history = recent_tools

        # Create compressed context summary
        compressed_summary = self._create_compressed_summary()

        # Rebuild messages with compression
        compressed_messages = []
        for msg in messages:
            if msg.get("role") == "system":
                # Append compression notice to system message
                content = msg.get("content", "")
                content += f"\n\n[CONTEXT COMPRESSED]\n{compressed_summary}"
                compressed_messages.append({**msg, "content": content})
            else:
                # Keep user messages and recent assistant messages
                compressed_messages.append(msg)

        return compressed_messages

    def _create_compressed_summary(self) -> str:
        """Create a summary of compressed context."""
        summary_parts = ["Previously explored papers:"]
        
        for ref in self.compressed_references[:20]:  # Limit to 20 references
            summary_parts.append(
                f"- [{ref.title}]({ref.url}): {ref.abstract[:100]}..."
            )

        return "\n".join(summary_parts)

    def get_paper_memory(self) -> List[Dict]:
        """Get all remembered papers for reference."""
        return [
            {
                "paper_id": ref.paper_id,
                "title": ref.title,
                "url": ref.url,
                "abstract": ref.abstract,
            }
            for ref in self.compressed_references
        ]


# Agent instructions
PAPER_AGENT_INSTRUCTIONS = [
    "You are an expert research assistant specialized in academic literature.",
    "",
    "Your capabilities:",
    "1. **Paper Search**: Search ArXiv and PubMed for relevant papers using search_papers.",
    "2. **Paper Reading**: Download and read paper content using read_paper_content, view_paper_page, or search_paper_text.",
    "3. **Paper Analysis**: Use analyze_paper to generate detailed methodology reports from PDFs.",
    "4. **Text Analysis**: Use regex patterns to find specific information in papers.",
    "4. **Visualization**: Create charts to visualize research trends or data using create_chart, create_bar_chart, or create_line_chart.",
    "",
    "Guidelines:",
    "- When searching, start with broad queries then refine.",
    "- When reading papers, use page-specific or regex search for efficiency.",
    "- Summarize key findings clearly with proper citations.",
    "- Create visualizations when they help explain trends or comparisons.",
    "- Format responses in clear markdown with proper structure.",
    "",
    "If context has been compressed, refer to the paper memory for previously explored papers.",
]


def create_paper_agent(
    api_key: Optional[str] = None,
    base_url: str = "https://api.moonshot.cn/v1",
    model_id: str = "kimi-k2-thinking-turbo",
    enable_context_management: bool = True,
    force_regex_search: bool = False,
) -> Agent:
    """
    Create a paperAgent instance.

    Args:
        api_key: Moonshot API key. Defaults to MOONSHOT_API_KEY env var.
        base_url: API base URL.
        model_id: Model identifier.
        enable_context_management: Enable automatic context compression.
        force_regex_search: Force regex search mode for testing.

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
    size_middleware = SizeMiddleware(max_chars=50000, max_articles=10)
    regex_middleware = RegexForceMiddleware(force_regex=force_regex_search)

    tools = [
        PaperSearchTools(
            cache_middleware=cache_middleware,
            size_middleware=size_middleware,
        ),
        PaperViewerTools(
            regex_middleware=regex_middleware,
        ),
        PythonPlottingTools(),
        PaperReaderWorkflow(
            api_key=api_key,
            base_url=base_url,
            model_id=model_id,
        ),
    ]

    # Create agent
    agent = Agent(
        model=model,
        tools=tools,
        instructions=PAPER_AGENT_INSTRUCTIONS,
        markdown=True,
        description="PaperAgent: Research assistant for academic papers with search, reading, and visualization capabilities.",
        debug_mode=False,
    )

    # Attach context manager if enabled
    if enable_context_management:
        agent._context_manager = ContextManager()

    return agent


# Module-level default agent instance
_default_agent: Optional[Agent] = None


def get_paper_agent() -> Agent:
    """Get or create the default paperAgent instance."""
    global _default_agent
    if _default_agent is None:
        _default_agent = create_paper_agent()
    return _default_agent


if __name__ == "__main__":
    from agno.utils.pprint import pprint_run_response

    agent = create_paper_agent()
    
    print("PaperAgent initialized. Enter a research topic or 'exit' to quit.")
    while True:
        user_input = input("\n> ").strip()
        if user_input.lower() == "exit":
            break
        if not user_input:
            continue
        
        response = agent.run(user_input)
        pprint_run_response(response)
