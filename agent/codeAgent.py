"""
codeAgent - Deep file analysis agent using Claude Agent SDK with Plotly skill.

Uses the project-configured Anthropic Messages-compatible Coding Provider.
"""

import os
import asyncio
from pathlib import Path
from typing import AsyncIterator, Optional

try:
    from claude_agent_sdk import (
        query,
        ClaudeAgentOptions,
        tool,
        create_sdk_mcp_server,
        AssistantMessage,
        TextBlock,
    )
except ImportError:
    raise ImportError(
        "`claude-agent-sdk` not installed. Please install using `pip install claude-agent-sdk`"
    )

try:
    import plotly.express as px
    import plotly.graph_objects as go
    import plotly.io as pio
except ImportError:
    raise ImportError(
        "`plotly` not installed. Please install using `pip install plotly kaleido`"
    )

from backend.coding_provider import CodingProviderProfile


# Output directory for generated charts
PLOTLY_OUTPUT_DIR = Path(__file__).parent / "tools" / "plotly_outputs"


@tool(
    "generate_plotly_chart",
    "Generate a Plotly chart from Python code and save it as an image. Returns the image URI for embedding in reports.",
    {
        "code": str,  # Python code that creates a Plotly figure (must assign to 'fig')
        "filename": str,  # Output filename (without extension, will be .png)
        "title": str,  # Chart title for reference
    },
)
async def generate_plotly_chart(args: dict) -> dict:
    """Execute Plotly code and save the resulting chart as an image."""
    PLOTLY_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    code = args.get("code", "")
    filename = args.get("filename", "chart")
    title = args.get("title", "Untitled Chart")

    # Ensure filename has no extension (we add .png)
    filename = filename.replace(".png", "").replace(".html", "")
    output_path = PLOTLY_OUTPUT_DIR / f"{filename}.png"

    # Create a safe execution environment
    local_vars = {
        "px": px,
        "go": go,
        "pio": pio,
    }

    try:
        # Execute the plotting code
        exec(code, {"__builtins__": __builtins__}, local_vars)

        # Get the figure from local_vars
        fig = local_vars.get("fig")
        if fig is None:
            return {
                "success": False,
                "error": "Code must create a variable named 'fig' containing the Plotly figure.",
            }

        # Save the figure as PNG
        fig.write_image(str(output_path), width=1200, height=800, scale=2)

        return {
            "success": True,
            "image_uri": str(output_path),
            "title": title,
            "message": f"Chart saved to {output_path}. Use this URI in your markdown report: ![{title}]({output_path})",
        }

    except Exception as e:
        return {
            "success": False,
            "error": f"Failed to generate chart: {str(e)}",
        }


# System prompt for deep file analysis
CODE_AGENT_SYSTEM_PROMPT = """You are an expert code analyst and technical writer.

Your task is to perform deep analysis of files and codebases. Follow these guidelines:

1. **Thorough Exploration**: Read and examine all relevant files carefully. Don't skip details.

2. **Multi-directional Analysis**: 
   - Understand the architecture and structure
   - Identify patterns and anti-patterns
   - Check for potential bugs or issues
   - Evaluate code quality and maintainability
   - Analyze dependencies and their usage

3. **Visualization**: Use the generate_plotly_chart tool to create visualizations that help explain:
   - Code structure diagrams
   - Dependency graphs
   - Metric distributions
   - Any data that benefits from visual representation

4. **Professional Report**: Generate a comprehensive markdown report that includes:
   - Executive summary
   - Detailed findings with code references
   - Embedded charts using image URIs: ![Chart Title](image_path)
   - Recommendations and action items
   - Conclusion

Always be thorough and professional. When you create charts, reference them in your report using the returned image_uri."""


class CodeAgent:
    """Code analysis agent using Claude Agent SDK with Plotly visualization skill."""

    def __init__(
        self,
        working_dir: Optional[str] = None,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        model_id: Optional[str] = None,
    ):
        """
        Initialize the CodeAgent.

        Args:
            working_dir: Directory to analyze. Defaults to current directory.
            api_key: Coding Provider key, held only by the worker gateway.
            base_url: Anthropic Messages-compatible base URL.
        """
        self.working_dir = Path(working_dir) if working_dir else Path.cwd()
        profile = CodingProviderProfile.from_environment()
        self.api_key = api_key or profile.api_key
        self.base_url = base_url
        self.base_url = self.base_url or profile.base_url
        self.model_id = (model_id or profile.model_id).strip()

        if not self.api_key:
            raise ValueError(
                "Coding Provider key required or pass an attempt-scoped gateway credential."
            )

        # Create MCP server with Plotly tool
        self.plotly_server = create_sdk_mcp_server(
            name="plotly",
            version="1.0.0",
            tools=[generate_plotly_chart],
        )

    def _get_options(self) -> ClaudeAgentOptions:
        """Get Claude Agent SDK options configured for this agent."""
        return ClaudeAgentOptions(
            cwd=str(self.working_dir),
            system_prompt=CODE_AGENT_SYSTEM_PROMPT,
            allowed_tools=[
                "Read",
                "Write",
                "Bash",
                "mcp__plotly__generate_plotly_chart",
            ],
            mcp_servers={"plotly": self.plotly_server},
            permission_mode="acceptEdits",
            model=self.model_id,
            api_key=self.api_key,
            api_base_url=self.base_url,
        )

    async def analyze(self, prompt: str) -> AsyncIterator[str]:
        """
        Run analysis with the given prompt.

        Args:
            prompt: Analysis prompt describing what to analyze.

        Yields:
            Response text chunks as they stream.
        """
        options = self._get_options()

        async for message in query(prompt=prompt, options=options):
            if isinstance(message, AssistantMessage):
                for block in message.content:
                    if isinstance(block, TextBlock):
                        yield block.text

    async def analyze_full(self, prompt: str) -> str:
        """
        Run analysis and return the complete response.

        Args:
            prompt: Analysis prompt describing what to analyze.

        Returns:
            Complete response text.
        """
        result = []
        async for chunk in self.analyze(prompt):
            result.append(chunk)
        return "".join(result)


async def run_code_analysis(
    prompt: str,
    working_dir: Optional[str] = None,
    stream: bool = True,
) -> str:
    """
    Convenience function to run code analysis.

    Args:
        prompt: Analysis prompt.
        working_dir: Directory to analyze.
        stream: Whether to print streaming output.

    Returns:
        Complete analysis report.
    """
    agent = CodeAgent(working_dir=working_dir)

    if stream:
        result = []
        async for chunk in agent.analyze(prompt):
            print(chunk, end="", flush=True)
            result.append(chunk)
        print()  # Final newline
        return "".join(result)
    else:
        return await agent.analyze_full(prompt)


if __name__ == "__main__":
    # Example usage
    import sys

    prompt = sys.argv[1] if len(sys.argv) > 1 else "Analyze this codebase and provide a comprehensive report."
    working_dir = sys.argv[2] if len(sys.argv) > 2 else "."

    asyncio.run(run_code_analysis(prompt, working_dir))
