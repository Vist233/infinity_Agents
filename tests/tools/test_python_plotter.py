import json
from pathlib import Path

import pytest

from agent.tools.python_plotter import PythonPlottingTools


def _assert_success(raw: str) -> dict:
    payload = json.loads(raw)
    assert payload.get("success") is True, payload
    return payload


def test_create_chart_matplotlib_forces_output_path_and_no_cwd_leak(tmp_path, monkeypatch):
    cwd = tmp_path / "cwd"
    cwd.mkdir(parents=True, exist_ok=True)
    monkeypatch.chdir(cwd)

    output_dir = tmp_path / "session_plot_outputs"
    tool = PythonPlottingTools(output_dir=output_dir)

    raw = tool.create_chart(
        code="""
import matplotlib.pyplot as plt
plt.figure()
plt.plot([1, 2, 3], [1, 4, 9])
plt.title("demo")
plt.savefig("cute_turtle.png")
""",
        filename="cute_turtle",
        chart_type="matplotlib",
    )
    result = _assert_success(raw)

    assert result["image_ref"] == "img://./cute_turtle.png"
    assert (output_dir / "cute_turtle.png").is_file()
    assert not (cwd / "cute_turtle.png").exists()


def test_create_chart_matplotlib_without_manual_save_still_persists(tmp_path, monkeypatch):
    cwd = tmp_path / "cwd_no_manual_save"
    cwd.mkdir(parents=True, exist_ok=True)
    monkeypatch.chdir(cwd)

    output_dir = tmp_path / "session_plot_outputs_no_manual_save"
    tool = PythonPlottingTools(output_dir=output_dir)

    raw = tool.create_chart(
        code="""
import matplotlib.pyplot as plt
plt.figure()
plt.plot([0, 1, 2], [2, 1, 0])
plt.title("auto-save")
""",
        filename="auto_saved_chart",
        chart_type="matplotlib",
    )
    result = _assert_success(raw)

    assert result["image_ref"] == "img://./auto_saved_chart.png"
    assert (output_dir / "auto_saved_chart.png").is_file()
    assert not (cwd / "auto_saved_chart.png").exists()


def test_create_chart_plotly_forces_output_path_and_no_cwd_leak(tmp_path, monkeypatch):
    pytest.importorskip("plotly.graph_objects")

    cwd = tmp_path / "cwd_plotly"
    cwd.mkdir(parents=True, exist_ok=True)
    monkeypatch.chdir(cwd)

    output_dir = tmp_path / "session_plotly_outputs"
    tool = PythonPlottingTools(output_dir=output_dir)

    write_targets = []

    def _fake_write_image(self, file, *args, **kwargs):
        del self, args, kwargs
        target = Path(file)
        write_targets.append(target)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(b"fake-png")

    monkeypatch.setattr("plotly.graph_objects.Figure.write_image", _fake_write_image)

    raw = tool.create_chart(
        code="""
fig = go.Figure(data=go.Bar(x=["a"], y=[1]))
fig.write_image("x.png")
""",
        filename="plotly_forced_path",
        chart_type="plotly",
    )
    result = _assert_success(raw)

    assert result["image_ref"] == "img://./plotly_forced_path.png"
    assert (output_dir / "plotly_forced_path.png").is_file()
    assert not (cwd / "x.png").exists()
    assert write_targets == [output_dir / "plotly_forced_path.png"]
