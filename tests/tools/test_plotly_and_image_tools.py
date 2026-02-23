import json
from pathlib import Path
from types import SimpleNamespace

from PIL import Image

from agent.tools.plotly_charts import PlotlyVisualizationTools
from agent.tools.image_analyzer import ImageAnalysisTools


def test_plotly_custom_bar_chart_returns_markdown(monkeypatch, tmp_path):
    tool = PlotlyVisualizationTools(output_dir=tmp_path)

    def _fake_create_bar_chart(_data, _title, _xlabel, _ylabel, output_path, _horizontal, color_by_value=True):
        Path(output_path).parent.mkdir(parents=True, exist_ok=True)
        Path(output_path).write_bytes(b"fake-png")
        return (None, str(output_path))

    monkeypatch.setattr("agent.tools.plotly_charts.create_bar_chart", _fake_create_bar_chart)

    raw = tool.create_custom_bar_chart(
        data_json='{"A": 1, "B": 2}',
        title="Demo",
        filename="demo_chart",
    )
    result = json.loads(raw)

    assert result["success"] is True
    assert result["image_ref"] == "img://demo_chart.png"
    assert result["markdown"] == "![demo_chart](img://demo_chart.png)"


def test_plotly_custom_sunburst_validation(tmp_path):
    tool = PlotlyVisualizationTools(output_dir=tmp_path)

    raw = tool.create_custom_sunburst(
        labels='["root", "a"]',
        parents='[""]',
        values='[0, 1]',
    )
    result = json.loads(raw)

    assert "error" in result
    assert "length mismatch" in result["error"]


def test_image_analyzer_invalid_path_returns_error(tmp_path):
    tool = ImageAnalysisTools(api_key="test", allowed_dirs=[tmp_path])
    result = json.loads(tool.analyze_image("missing.png"))

    assert "error" in result
    assert "not found" in result["error"]


def test_image_analyzer_success_with_mocked_openai(monkeypatch, tmp_path):
    image_path = tmp_path / "chart.png"
    Image.new("RGB", (120, 80), color=(255, 255, 255)).save(image_path)

    class _FakeCompletions:
        @staticmethod
        def create(**kwargs):
            del kwargs
            return SimpleNamespace(
                choices=[SimpleNamespace(message=SimpleNamespace(content="图中为简单白底测试图像。"))]
            )

    class _FakeChat:
        completions = _FakeCompletions()

    class _FakeOpenAI:
        def __init__(self, **kwargs):
            del kwargs
            self.chat = _FakeChat()

    monkeypatch.setattr("agent.tools.image_analyzer.OpenAI", _FakeOpenAI)

    tool = ImageAnalysisTools(
        api_key="test",
        model_id="kimi-k2.5",
        allowed_dirs=[tmp_path],
    )

    raw = tool.analyze_image("chart.png", prompt="请描述内容", detail="high")
    result = json.loads(raw)

    assert result["success"] is True
    assert result["model"] == "kimi-k2.5"
    assert result["image_ref"] == "img://chart.png"
    assert "白底" in result["analysis"]


def test_image_analyzer_preserves_relative_path_ref(monkeypatch, tmp_path):
    image_path = tmp_path / "extracted" / "paper_x" / "images" / "fig.png"
    image_path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (64, 64), color=(200, 200, 200)).save(image_path)

    class _FakeCompletions:
        @staticmethod
        def create(**kwargs):
            del kwargs
            return SimpleNamespace(
                choices=[SimpleNamespace(message=SimpleNamespace(content="测试分析"))]
            )

    class _FakeChat:
        completions = _FakeCompletions()

    class _FakeOpenAI:
        def __init__(self, **kwargs):
            del kwargs
            self.chat = _FakeChat()

    monkeypatch.setattr("agent.tools.image_analyzer.OpenAI", _FakeOpenAI)

    tool = ImageAnalysisTools(
        api_key="test",
        model_id="kimi-k2.5",
        allowed_dirs=[tmp_path],
    )

    raw = tool.analyze_image("extracted/paper_x/images/fig.png")
    result = json.loads(raw)

    assert result["success"] is True
    assert result["image_ref"] == "img://extracted/paper_x/images/fig.png"


def test_image_analyzer_absolute_path_uses_relative_ref(monkeypatch, tmp_path):
    image_path = tmp_path / "extracted" / "paper_y" / "images" / "fig_abs.png"
    image_path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (80, 80), color=(100, 120, 140)).save(image_path)

    class _FakeCompletions:
        @staticmethod
        def create(**kwargs):
            del kwargs
            return SimpleNamespace(
                choices=[SimpleNamespace(message=SimpleNamespace(content="绝对路径分析"))]
            )

    class _FakeChat:
        completions = _FakeCompletions()

    class _FakeOpenAI:
        def __init__(self, **kwargs):
            del kwargs
            self.chat = _FakeChat()

    monkeypatch.setattr("agent.tools.image_analyzer.OpenAI", _FakeOpenAI)

    tool = ImageAnalysisTools(
        api_key="test",
        model_id="kimi-k2.5",
        allowed_dirs=[tmp_path],
    )

    raw = tool.analyze_image(str(image_path))
    result = json.loads(raw)

    assert result["success"] is True
    assert result["image_ref"] == "img://extracted/paper_y/images/fig_abs.png"
