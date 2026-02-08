"""
Plotly Visualization Tools - Reusable chart functions for paper analysis.

Creates sunburst, treemap, bar, and line charts with consistent styling.
Optimized for bioinformatics methodology visualization.
"""

import json
import uuid
from pathlib import Path
from typing import Dict, List, Any, Optional, Tuple
from collections import Counter

from agno.tools import Toolkit
from agno.utils.log import log_debug, logger

try:
    import plotly.express as px
    import plotly.graph_objects as go
    from plotly.subplots import make_subplots
except ImportError:
    raise ImportError(
        "`plotly` not installed. Please install using `pip install plotly kaleido`"
    )


# Output directory for generated charts
CHART_OUTPUT_DIR = Path(__file__).parent.parent.parent / "papers" / "charts"


# ============================================================================
# Reusable Plotting Functions
# ============================================================================

def create_sunburst(
    data: Dict[str, Any],
    title: str = "Sunburst Chart",
    output_path: Optional[Path] = None,
) -> Tuple[go.Figure, Optional[str]]:
    """
    Create a sunburst chart from hierarchical data.
    
    Args:
        data: Dict with 'labels', 'parents', 'values' keys.
              - labels: List of node names
              - parents: List of parent node names (empty string for root)
              - values: List of values for sizing
        title: Chart title.
        output_path: If provided, save chart to this path.
    
    Returns:
        Tuple of (figure, saved_path or None)
    
    Example:
        data = {
            "labels": ["Methods", "QC", "Alignment", "FastQC", "STAR"],
            "parents": ["", "Methods", "Methods", "QC", "Alignment"],
            "values": [0, 0, 0, 5, 3],
        }
    """
    fig = go.Figure(go.Sunburst(
        labels=data["labels"],
        parents=data["parents"],
        values=data.get("values", [1] * len(data["labels"])),
        branchvalues="total",
        hovertemplate="<b>%{label}</b><br>Count: %{value}<extra></extra>",
        marker=dict(
            colors=data.get("values", [1] * len(data["labels"])),
            colorscale="Blues",
        ),
    ))
    
    fig.update_layout(
        title=dict(text=title, x=0.5, font=dict(size=18)),
        margin=dict(t=60, l=10, r=10, b=10),
        font=dict(family="Inter, sans-serif"),
    )
    
    saved_path = None
    if output_path:
        output_path = Path(output_path)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        fig.write_image(str(output_path), width=800, height=800, scale=2)
        saved_path = str(output_path)
    
    return fig, saved_path


def create_treemap(
    data: Dict[str, Any],
    title: str = "Treemap",
    output_path: Optional[Path] = None,
) -> Tuple[go.Figure, Optional[str]]:
    """
    Create a treemap from hierarchical data.
    
    Args:
        data: Same format as create_sunburst.
        title: Chart title.
        output_path: If provided, save chart to this path.
    
    Returns:
        Tuple of (figure, saved_path or None)
    """
    fig = go.Figure(go.Treemap(
        labels=data["labels"],
        parents=data["parents"],
        values=data.get("values", [1] * len(data["labels"])),
        branchvalues="total",
        hovertemplate="<b>%{label}</b><br>Count: %{value}<extra></extra>",
        marker=dict(
            colorscale="Viridis",
            cornerradius=5,
        ),
        textfont=dict(size=14),
    ))
    
    fig.update_layout(
        title=dict(text=title, x=0.5, font=dict(size=18)),
        margin=dict(t=60, l=10, r=10, b=10),
        font=dict(family="Inter, sans-serif"),
    )
    
    saved_path = None
    if output_path:
        output_path = Path(output_path)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        fig.write_image(str(output_path), width=1000, height=600, scale=2)
        saved_path = str(output_path)
    
    return fig, saved_path


def create_bar_chart(
    data: Dict[str, float],
    title: str = "Bar Chart",
    xlabel: str = "Category",
    ylabel: str = "Value",
    output_path: Optional[Path] = None,
    horizontal: bool = False,
    color_by_value: bool = True,
) -> Tuple[go.Figure, Optional[str]]:
    """
    Create a styled bar chart.
    
    Args:
        data: Dict mapping category names to values.
        title: Chart title.
        xlabel: X-axis label.
        ylabel: Y-axis label.
        output_path: If provided, save chart to this path.
        horizontal: If True, create horizontal bar chart.
        color_by_value: If True, color bars by their values.
    
    Returns:
        Tuple of (figure, saved_path or None)
    """
    categories = list(data.keys())
    values = list(data.values())
    
    if horizontal:
        fig = go.Figure(go.Bar(
            x=values,
            y=categories,
            orientation="h",
            marker=dict(
                color=values if color_by_value else "steelblue",
                colorscale="Blues" if color_by_value else None,
            ),
            text=values,
            textposition="outside",
        ))
        fig.update_layout(
            xaxis_title=ylabel,
            yaxis_title=xlabel,
            yaxis=dict(autorange="reversed"),
        )
    else:
        fig = go.Figure(go.Bar(
            x=categories,
            y=values,
            marker=dict(
                color=values if color_by_value else "steelblue",
                colorscale="Blues" if color_by_value else None,
            ),
            text=values,
            textposition="outside",
        ))
        fig.update_layout(
            xaxis_title=xlabel,
            yaxis_title=ylabel,
            xaxis_tickangle=-45,
        )
    
    fig.update_layout(
        title=dict(text=title, x=0.5, font=dict(size=18)),
        margin=dict(t=60, l=80, r=40, b=80),
        font=dict(family="Inter, sans-serif"),
        plot_bgcolor="white",
    )
    
    saved_path = None
    if output_path:
        output_path = Path(output_path)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        fig.write_image(str(output_path), width=1000, height=600, scale=2)
        saved_path = str(output_path)
    
    return fig, saved_path


def create_line_chart(
    x_data: List[Any],
    y_data: List[float],
    title: str = "Line Chart",
    xlabel: str = "X",
    ylabel: str = "Y",
    output_path: Optional[Path] = None,
    show_markers: bool = True,
) -> Tuple[go.Figure, Optional[str]]:
    """
    Create a styled line chart.
    
    Args:
        x_data: X-axis values.
        y_data: Y-axis values.
        title: Chart title.
        xlabel: X-axis label.
        ylabel: Y-axis label.
        output_path: If provided, save chart to this path.
        show_markers: If True, show point markers.
    
    Returns:
        Tuple of (figure, saved_path or None)
    """
    fig = go.Figure(go.Scatter(
        x=x_data,
        y=y_data,
        mode="lines+markers" if show_markers else "lines",
        line=dict(color="royalblue", width=2),
        marker=dict(size=8) if show_markers else None,
    ))
    
    fig.update_layout(
        title=dict(text=title, x=0.5, font=dict(size=18)),
        xaxis_title=xlabel,
        yaxis_title=ylabel,
        margin=dict(t=60, l=80, r=40, b=60),
        font=dict(family="Inter, sans-serif"),
        plot_bgcolor="white",
        xaxis=dict(showgrid=True, gridcolor="lightgray"),
        yaxis=dict(showgrid=True, gridcolor="lightgray"),
    )
    
    saved_path = None
    if output_path:
        output_path = Path(output_path)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        fig.write_image(str(output_path), width=1000, height=600, scale=2)
        saved_path = str(output_path)
    
    return fig, saved_path


# ============================================================================
# Methodology Comparison Visualization
# ============================================================================

def create_methodology_sunburst(
    paper_reports: List[Dict[str, Any]],
    output_path: Optional[Path] = None,
) -> Tuple[go.Figure, Optional[str]]:
    """
    Create a sunburst chart comparing methodologies across multiple papers.
    
    Extracts common tools and steps from paper analysis reports
    and visualizes them as a hierarchical structure.
    
    Args:
        paper_reports: List of analysis results from PaperReaderWorkflow.
                      Each should have 'pipeline_steps' with 'step_name' and 'tools'.
        output_path: If provided, save chart to this path.
    
    Returns:
        Tuple of (figure, saved_path or None)
    """
    # Count tool usage across papers
    step_tools: Dict[str, Counter] = {}  # step_name -> Counter of tools
    
    for report in paper_reports:
        pipeline_steps = report.get("pipeline_steps", [])
        for step in pipeline_steps:
            step_name = step.get("step_name", "Unknown")
            tools = step.get("tools", [])
            
            if step_name not in step_tools:
                step_tools[step_name] = Counter()
            
            for tool in tools:
                if tool:
                    step_tools[step_name][tool] += 1
    
    # Build sunburst data
    labels = ["Methods"]
    parents = [""]
    values = [0]  # Root has 0, branches sum children
    
    for step_name, tool_counts in step_tools.items():
        # Add step as child of Methods
        labels.append(step_name)
        parents.append("Methods")
        values.append(0)  # Will be sum of children
        
        # Add individual tools
        for tool, count in tool_counts.items():
            labels.append(f"{tool} ({count}篇)")
            parents.append(step_name)
            values.append(count)
    
    data = {"labels": labels, "parents": parents, "values": values}
    
    return create_sunburst(
        data,
        title="生物信息分析方法对比",
        output_path=output_path,
    )


def create_tool_frequency_chart(
    paper_reports: List[Dict[str, Any]],
    output_path: Optional[Path] = None,
    top_n: int = 15,
) -> Tuple[go.Figure, Optional[str]]:
    """
    Create a horizontal bar chart showing tool usage frequency.
    
    Args:
        paper_reports: List of analysis results from PaperReaderWorkflow.
        output_path: If provided, save chart to this path.
        top_n: Number of top tools to show.
    
    Returns:
        Tuple of (figure, saved_path or None)
    """
    # Count all tools
    tool_counts: Counter = Counter()
    
    for report in paper_reports:
        pipeline_steps = report.get("pipeline_steps", [])
        for step in pipeline_steps:
            for tool in step.get("tools", []):
                if tool:
                    tool_counts[tool] += 1
    
    # Get top N tools
    top_tools = dict(tool_counts.most_common(top_n))
    
    return create_bar_chart(
        top_tools,
        title=f"工具使用频率 (Top {top_n})",
        xlabel="工具名称",
        ylabel="论文数量",
        output_path=output_path,
        horizontal=True,
    )


# ============================================================================
# Agno Toolkit Integration
# ============================================================================

class PlotlyVisualizationTools(Toolkit):
    """
    Toolkit for creating visualizations in paper analysis workflows.
    
    Provides pre-built functions for common chart types with consistent styling.
    """
    
    def __init__(
        self,
        output_dir: Optional[Path] = None,
        **kwargs,
    ):
        self.output_dir = output_dir or CHART_OUTPUT_DIR
        self.output_dir.mkdir(parents=True, exist_ok=True)
        
        tools = [
            self.create_methodology_comparison,
            self.create_tool_frequency,
            self.create_custom_sunburst,
            self.create_custom_bar_chart,
        ]
        
        super().__init__(name="plotly_visualization_tools", tools=tools, **kwargs)
    
    def create_methodology_comparison(
        self,
        paper_reports_json: str,
        filename: Optional[str] = None,
    ) -> str:
        """
        Create a sunburst chart comparing methodologies across papers.
        
        Args:
            paper_reports_json: JSON string containing list of paper analysis reports.
                               Each report should have 'pipeline_steps' with 'step_name' and 'tools'.
            filename: Output filename without extension. Auto-generated if not provided.
        
        Returns:
            JSON with success status and saved image path.
        
        Example input:
            [{"pipeline_steps": [{"step_name": "QC", "tools": ["FastQC"]}]}]
        """
        try:
            paper_reports = json.loads(paper_reports_json)
        except json.JSONDecodeError as e:
            return json.dumps({"error": f"Invalid JSON: {e}"})
        
        if not filename:
            filename = f"methodology_comparison_{uuid.uuid4().hex[:8]}"
        
        output_path = self.output_dir / f"{filename}.png"
        
        try:
            _, saved_path = create_methodology_sunburst(paper_reports, output_path)
            
            return json.dumps({
                "success": True,
                "image_path": saved_path,
                "filename": filename,
                "chart_type": "sunburst",
            })
        except Exception as e:
            logger.error(f"Methodology comparison error: {e}")
            return json.dumps({"error": str(e)})
    
    def create_tool_frequency(
        self,
        paper_reports_json: str,
        top_n: int = 15,
        filename: Optional[str] = None,
    ) -> str:
        """
        Create a bar chart showing tool usage frequency across papers.
        
        Args:
            paper_reports_json: JSON string containing list of paper analysis reports.
            top_n: Number of top tools to show.
            filename: Output filename without extension.
        
        Returns:
            JSON with success status and saved image path.
        """
        try:
            paper_reports = json.loads(paper_reports_json)
        except json.JSONDecodeError as e:
            return json.dumps({"error": f"Invalid JSON: {e}"})
        
        if not filename:
            filename = f"tool_frequency_{uuid.uuid4().hex[:8]}"
        
        output_path = self.output_dir / f"{filename}.png"
        
        try:
            _, saved_path = create_tool_frequency_chart(paper_reports, output_path, top_n)
            
            return json.dumps({
                "success": True,
                "image_path": saved_path,
                "filename": filename,
                "chart_type": "bar_horizontal",
            })
        except Exception as e:
            logger.error(f"Tool frequency chart error: {e}")
            return json.dumps({"error": str(e)})
    
    def create_custom_sunburst(
        self,
        labels: str,
        parents: str,
        values: Optional[str] = None,
        title: str = "Sunburst Chart",
        filename: Optional[str] = None,
    ) -> str:
        """
        Create a custom sunburst chart.
        
        Args:
            labels: JSON array of node labels.
            parents: JSON array of parent labels (empty string for root).
            values: Optional JSON array of values for sizing.
            title: Chart title.
            filename: Output filename without extension.
        
        Returns:
            JSON with success status and saved image path.
        
        Example:
            labels: '["Root", "A", "B", "A1", "A2"]'
            parents: '["", "Root", "Root", "A", "A"]'
            values: '[0, 0, 5, 3, 2]'
        """
        try:
            labels_list = json.loads(labels)
            parents_list = json.loads(parents)
            values_list = json.loads(values) if values else [1] * len(labels_list)
        except json.JSONDecodeError as e:
            return json.dumps({"error": f"Invalid JSON: {e}"})
        
        if not filename:
            filename = f"sunburst_{uuid.uuid4().hex[:8]}"
        
        output_path = self.output_dir / f"{filename}.png"
        
        try:
            data = {
                "labels": labels_list,
                "parents": parents_list,
                "values": values_list,
            }
            _, saved_path = create_sunburst(data, title, output_path)
            
            return json.dumps({
                "success": True,
                "image_path": saved_path,
                "filename": filename,
                "chart_type": "sunburst",
            })
        except Exception as e:
            logger.error(f"Custom sunburst error: {e}")
            return json.dumps({"error": str(e)})
    
    def create_custom_bar_chart(
        self,
        data_json: str,
        title: str = "Bar Chart",
        xlabel: str = "Category",
        ylabel: str = "Value",
        horizontal: bool = False,
        filename: Optional[str] = None,
    ) -> str:
        """
        Create a custom bar chart.
        
        Args:
            data_json: JSON object mapping category names to values.
                      Example: '{"FastQC": 5, "MultiQC": 3}'
            title: Chart title.
            xlabel: X-axis label.
            ylabel: Y-axis label.
            horizontal: If True, create horizontal bar chart.
            filename: Output filename without extension.
        
        Returns:
            JSON with success status and saved image path.
        """
        try:
            data = json.loads(data_json)
        except json.JSONDecodeError as e:
            return json.dumps({"error": f"Invalid JSON: {e}"})
        
        if not filename:
            filename = f"bar_chart_{uuid.uuid4().hex[:8]}"
        
        output_path = self.output_dir / f"{filename}.png"
        
        try:
            _, saved_path = create_bar_chart(
                data, title, xlabel, ylabel,
                output_path, horizontal, color_by_value=True
            )
            
            return json.dumps({
                "success": True,
                "image_path": saved_path,
                "filename": filename,
                "chart_type": "bar_horizontal" if horizontal else "bar_vertical",
            })
        except Exception as e:
            logger.error(f"Custom bar chart error: {e}")
            return json.dumps({"error": str(e)})
