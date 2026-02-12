"""
Python Plotting Tools - Generate charts using Matplotlib and Plotly.

Saves generated charts to a designated output directory.
"""

import json
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

from agno.tools import Toolkit
from agno.utils.log import log_debug, logger


PLOT_OUTPUT_DIR = Path(__file__).parent / "plot_outputs"


class PythonPlottingTools(Toolkit):
    """Tools for generating charts and visualizations."""

    def __init__(
        self,
        output_dir: Optional[Path] = None,
        **kwargs,
    ):
        self.output_dir = output_dir or PLOT_OUTPUT_DIR
        self.output_dir.mkdir(parents=True, exist_ok=True)

        tools: List[Any] = [
            self.create_chart,
            self.create_bar_chart,
            self.create_line_chart,
        ]

        super().__init__(name="python_plotting_tools", tools=tools, **kwargs)

    def create_chart(
        self,
        code: str,
        filename: Optional[str] = None,
        chart_type: str = "matplotlib",
    ) -> str:
        """Execute Python code to create a chart and save it as an image.

        Args:
            code (str): Python code that creates a figure. For matplotlib, use plt.savefig().
                       For plotly, assign to 'fig' variable.
            filename (str, optional): Output filename without extension. Auto-generated if not provided.
            chart_type (str, optional): 'matplotlib' or 'plotly'. Defaults to 'matplotlib'.

        Returns:
            str: JSON with the saved image path or error.
        """
        if not filename:
            filename = f"chart_{uuid.uuid4().hex[:8]}"

        output_path = self.output_dir / f"{filename}.png"

        try:
            if chart_type == "matplotlib":
                import matplotlib
                matplotlib.use("Agg")  # Non-interactive backend
                import matplotlib.pyplot as plt

                # Clear any existing figures
                plt.clf()
                plt.close("all")

                # Execute the code
                local_vars = {"plt": plt}
                exec(code, {"__builtins__": __builtins__}, local_vars)

                # Save the figure
                plt.savefig(str(output_path), dpi=150, bbox_inches="tight")
                plt.close("all")

            elif chart_type == "plotly":
                import plotly.express as px
                import plotly.graph_objects as go

                local_vars = {"px": px, "go": go}
                exec(code, {"__builtins__": __builtins__}, local_vars)

                fig = local_vars.get("fig")
                if fig is None:
                    return json.dumps({
                        "error": "Plotly code must create a 'fig' variable."
                    })

                fig.write_image(str(output_path), width=1000, height=600, scale=2)

            else:
                return json.dumps({"error": f"Unknown chart_type: {chart_type}"})

            log_debug(f"Chart saved to {output_path}")
            img_ref = f"img://{filename}.png"
            return json.dumps({
                "success": True,
                "image_ref": img_ref,
                "markdown": f"![{filename}]({img_ref})",
            })

        except Exception as e:
            logger.error(f"Chart creation error: {e}")
            return json.dumps({"error": str(e)})

    def create_bar_chart(
        self,
        data: Dict[str, float],
        title: str = "Bar Chart",
        xlabel: str = "Category",
        ylabel: str = "Value",
        filename: Optional[str] = None,
    ) -> str:
        """Create a simple bar chart from data.

        Args:
            data (Dict[str, float]): Dictionary mapping labels to values.
            title (str, optional): Chart title. Defaults to 'Bar Chart'.
            xlabel (str, optional): X-axis label. Defaults to 'Category'.
            ylabel (str, optional): Y-axis label. Defaults to 'Value'.
            filename (str, optional): Output filename without extension.

        Returns:
            str: JSON with the saved image path.
        """
        if not filename:
            filename = f"bar_chart_{uuid.uuid4().hex[:8]}"

        output_path = self.output_dir / f"{filename}.png"

        try:
            import matplotlib
            matplotlib.use("Agg")
            import matplotlib.pyplot as plt

            plt.figure(figsize=(10, 6))
            plt.bar(list(data.keys()), list(data.values()), color="steelblue")
            plt.title(title)
            plt.xlabel(xlabel)
            plt.ylabel(ylabel)
            plt.xticks(rotation=45, ha="right")
            plt.tight_layout()
            plt.savefig(str(output_path), dpi=150)
            plt.close()

            img_ref = f"img://{filename}.png"
            return json.dumps({
                "success": True,
                "image_ref": img_ref,
                "markdown": f"![{filename}]({img_ref})",
            })

        except Exception as e:
            return json.dumps({"error": str(e)})

    def create_line_chart(
        self,
        x_data: List[Any],
        y_data: List[float],
        title: str = "Line Chart",
        xlabel: str = "X",
        ylabel: str = "Y",
        filename: Optional[str] = None,
    ) -> str:
        """Create a simple line chart.

        Args:
            x_data (List): X-axis values.
            y_data (List[float]): Y-axis values.
            title (str, optional): Chart title.
            xlabel (str, optional): X-axis label.
            ylabel (str, optional): Y-axis label.
            filename (str, optional): Output filename without extension.

        Returns:
            str: JSON with the saved image path.
        """
        if not filename:
            filename = f"line_chart_{uuid.uuid4().hex[:8]}"

        output_path = self.output_dir / f"{filename}.png"

        try:
            import matplotlib
            matplotlib.use("Agg")
            import matplotlib.pyplot as plt

            plt.figure(figsize=(10, 6))
            plt.plot(x_data, y_data, marker="o", linewidth=2, markersize=6)
            plt.title(title)
            plt.xlabel(xlabel)
            plt.ylabel(ylabel)
            plt.grid(True, alpha=0.3)
            plt.tight_layout()
            plt.savefig(str(output_path), dpi=150)
            plt.close()

            img_ref = f"img://{filename}.png"
            return json.dumps({
                "success": True,
                "image_ref": img_ref,
                "markdown": f"![{filename}]({img_ref})",
            })

        except Exception as e:
            return json.dumps({"error": str(e)})
