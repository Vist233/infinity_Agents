"""
Python Plotting Tools - Generate charts using Matplotlib and Plotly.

Saves generated charts to a designated output directory.
"""

import os
import json
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Dict, List, Optional

from agno.tools import Toolkit
from agno.utils.log import log_debug, logger
from agent.tools.image_path_utils import to_img_ref


PLOT_OUTPUT_DIR = Path(__file__).parent / "plot_outputs"


class PythonPlottingTools(Toolkit):
    """Tools for generating charts and visualizations."""
    _FONT_PRIORITY = [
        "Noto Sans CJK SC",
        "Noto Sans CJK",
        "WenQuanYi Micro Hei",
        "Microsoft YaHei",
        "SimHei",
        "DejaVu Sans",
    ]
    _CJK_FONT_MARKERS = [
        "noto sans cjk",
        "wenquanyi micro hei",
        "microsoft yahei",
        "simhei",
    ]

    def __init__(
        self,
        output_dir: Optional[Path] = None,
        **kwargs,
    ):
        self.output_dir = output_dir or PLOT_OUTPUT_DIR

        tools: List[Any] = [
            self.create_chart,
            self.create_bar_chart,
            self.create_line_chart,
        ]

        super().__init__(name="python_plotting_tools", tools=tools, **kwargs)

    def _is_nearly_blank_image(self, image_path: Path) -> bool:
        """Detect obviously blank images (e.g., pure white canvases)."""
        try:
            from PIL import Image, ImageStat

            img = Image.open(image_path).convert("RGB")
            stat = ImageStat.Stat(img)
            mean = stat.mean
            std = stat.stddev
            avg_mean = sum(mean) / len(mean)
            avg_std = sum(std) / len(std)
            # Very bright with almost no variance => visually blank.
            return avg_mean >= 253 and avg_std < 1.0
        except Exception:
            # If detection fails, do not block chart output.
            return False

    def _configure_matplotlib_cjk_font(self, plt) -> Dict[str, Any]:
        """Configure matplotlib with best-effort CJK-capable font fallback."""
        selected_font = "DejaVu Sans"
        cjk_ready = False

        try:
            import matplotlib.font_manager as font_manager

            available_fonts = {
                font.name
                for font in font_manager.fontManager.ttflist
                if getattr(font, "name", None)
            }

            for font_name in self._FONT_PRIORITY:
                if font_name in available_fonts:
                    selected_font = font_name
                    break
            else:
                lower_map = {name.lower(): name for name in available_fonts}
                for marker in self._CJK_FONT_MARKERS:
                    matched = next((name for key, name in lower_map.items() if marker in key), None)
                    if matched:
                        selected_font = matched
                        break

            selected_lower = selected_font.lower()
            cjk_ready = any(marker in selected_lower for marker in self._CJK_FONT_MARKERS)
        except Exception as e:
            logger.warning(f"Failed to inspect system fonts, fallback to defaults: {e}")

        font_fallback = [selected_font] + [f for f in self._FONT_PRIORITY if f != selected_font]
        plt.rcParams["font.family"] = "sans-serif"
        plt.rcParams["font.sans-serif"] = font_fallback
        plt.rcParams["axes.unicode_minus"] = False

        return {
            "selected_font": selected_font,
            "cjk_ready": cjk_ready,
        }

    @contextmanager
    def _temporary_working_dir(self, target_dir: Path):
        """Temporarily run code within a target working directory."""
        previous_dir = Path.cwd()
        os.chdir(target_dir)
        try:
            yield
        finally:
            os.chdir(previous_dir)

    def create_chart(
        self,
        code: str,
        filename: Optional[str] = None,
        chart_type: str = "matplotlib",
    ) -> str:
        """Execute Python code to create a chart and save it as an image.

        Args:
            code (str): Python code that creates a figure.
                       Do not manually save files inside code; the tool saves automatically.
                       For plotly, assign to 'fig' variable.
            filename (str, optional): Output filename without extension. Auto-generated if not provided.
            chart_type (str, optional): 'matplotlib' or 'plotly'. Defaults to 'matplotlib'.

        Returns:
            str: JSON with the saved image path or error.
        """
        if not filename:
            filename = f"chart_{uuid.uuid4().hex[:8]}"

        self.output_dir.mkdir(parents=True, exist_ok=True)
        output_path = self.output_dir / f"{filename}.png"

        try:
            font_info: Optional[Dict[str, Any]] = None
            warning: Optional[str] = None

            if chart_type == "matplotlib":
                import matplotlib
                matplotlib.use("Agg")  # Non-interactive backend
                import matplotlib.pyplot as plt
                font_info = self._configure_matplotlib_cjk_font(plt)
                if not font_info.get("cjk_ready", False):
                    warning = "No CJK font detected. Install fonts-noto-cjk for proper Chinese rendering."

                # Clear any existing figures
                plt.clf()
                plt.close("all")

                did_save = False
                original_plt_savefig = plt.savefig
                from matplotlib.figure import Figure
                original_figure_savefig = Figure.savefig

                def _forced_plt_savefig(*args, **kwargs):
                    nonlocal did_save
                    did_save = True
                    sanitized_kwargs = dict(kwargs)
                    sanitized_kwargs.pop("fname", None)
                    passthrough_args = args[1:] if args else ()
                    return original_plt_savefig(
                        str(output_path),
                        *passthrough_args,
                        **sanitized_kwargs,
                    )

                def _forced_figure_savefig(self_figure, *args, **kwargs):
                    nonlocal did_save
                    did_save = True
                    sanitized_kwargs = dict(kwargs)
                    sanitized_kwargs.pop("fname", None)
                    passthrough_args = args[1:] if args else ()
                    return original_figure_savefig(
                        self_figure,
                        str(output_path),
                        *passthrough_args,
                        **sanitized_kwargs,
                    )

                local_vars = {"plt": plt}
                plt.savefig = _forced_plt_savefig
                Figure.savefig = _forced_figure_savefig
                try:
                    with self._temporary_working_dir(self.output_dir):
                        exec(code, {"__builtins__": __builtins__}, local_vars)
                    if not did_save:
                        original_plt_savefig(str(output_path), dpi=150, bbox_inches="tight")
                finally:
                    plt.savefig = original_plt_savefig
                    Figure.savefig = original_figure_savefig
                    plt.close("all")

                if self._is_nearly_blank_image(output_path):
                    output_path.unlink(missing_ok=True)
                    return json.dumps({
                        "error": (
                            "Generated image is blank. Please ensure the plotting code "
                            "actually draws visible content before saving."
                        )
                    })

            elif chart_type == "plotly":
                import plotly.express as px
                import plotly.graph_objects as go

                did_save = False
                original_write_image = go.Figure.write_image

                def _forced_write_image(self_figure, *args, **kwargs):
                    nonlocal did_save
                    did_save = True
                    sanitized_kwargs = dict(kwargs)
                    sanitized_kwargs.pop("file", None)
                    passthrough_args = args[1:] if args else ()
                    return original_write_image(
                        self_figure,
                        str(output_path),
                        *passthrough_args,
                        **sanitized_kwargs,
                    )

                local_vars = {"px": px, "go": go}
                go.Figure.write_image = _forced_write_image
                try:
                    with self._temporary_working_dir(self.output_dir):
                        exec(code, {"__builtins__": __builtins__}, local_vars)

                    fig = local_vars.get("fig")
                    if fig is None:
                        return json.dumps({
                            "error": "Plotly code must create a 'fig' variable."
                        })

                    if not did_save:
                        fig.write_image(str(output_path), width=1000, height=600, scale=2)
                finally:
                    go.Figure.write_image = original_write_image

            else:
                return json.dumps({"error": f"Unknown chart_type: {chart_type}"})

            log_debug(f"Chart saved to {output_path}")
            img_ref = to_img_ref(f"{filename}.png")
            response: Dict[str, Any] = {
                "success": True,
                "image_ref": img_ref,
                "markdown": f"![{filename}]({img_ref})",
            }
            if font_info is not None:
                response["font_info"] = font_info
            if warning:
                response["warning"] = warning
            return json.dumps(response)

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

        self.output_dir.mkdir(parents=True, exist_ok=True)
        output_path = self.output_dir / f"{filename}.png"

        try:
            import matplotlib
            matplotlib.use("Agg")
            import matplotlib.pyplot as plt
            font_info = self._configure_matplotlib_cjk_font(plt)
            warning = None
            if not font_info.get("cjk_ready", False):
                warning = "No CJK font detected. Install fonts-noto-cjk for proper Chinese rendering."

            plt.figure(figsize=(10, 6))
            plt.bar(list(data.keys()), list(data.values()), color="steelblue")
            plt.title(title)
            plt.xlabel(xlabel)
            plt.ylabel(ylabel)
            plt.xticks(rotation=45, ha="right")
            plt.tight_layout()
            plt.savefig(str(output_path), dpi=150)
            plt.close()

            img_ref = to_img_ref(f"{filename}.png")
            response: Dict[str, Any] = {
                "success": True,
                "image_ref": img_ref,
                "markdown": f"![{filename}]({img_ref})",
                "font_info": font_info,
            }
            if warning:
                response["warning"] = warning
            return json.dumps(response)

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

        self.output_dir.mkdir(parents=True, exist_ok=True)
        output_path = self.output_dir / f"{filename}.png"

        try:
            import matplotlib
            matplotlib.use("Agg")
            import matplotlib.pyplot as plt
            font_info = self._configure_matplotlib_cjk_font(plt)
            warning = None
            if not font_info.get("cjk_ready", False):
                warning = "No CJK font detected. Install fonts-noto-cjk for proper Chinese rendering."

            plt.figure(figsize=(10, 6))
            plt.plot(x_data, y_data, marker="o", linewidth=2, markersize=6)
            plt.title(title)
            plt.xlabel(xlabel)
            plt.ylabel(ylabel)
            plt.grid(True, alpha=0.3)
            plt.tight_layout()
            plt.savefig(str(output_path), dpi=150)
            plt.close()

            img_ref = to_img_ref(f"{filename}.png")
            response: Dict[str, Any] = {
                "success": True,
                "image_ref": img_ref,
                "markdown": f"![{filename}]({img_ref})",
                "font_info": font_info,
            }
            if warning:
                response["warning"] = warning
            return json.dumps(response)

        except Exception as e:
            return json.dumps({"error": str(e)})
