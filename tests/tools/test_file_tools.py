import json

from agent.tools.file_tools import FileSystemTools


def test_read_image_preserves_relative_path_reference(tmp_path):
    root = tmp_path / "papers_cache"
    image_path = root / "extracted" / "2103_03404" / "images" / "page1_img1.png"
    image_path.parent.mkdir(parents=True, exist_ok=True)
    image_path.write_bytes(b"fake-image")

    tools = FileSystemTools(allowed_dirs=[root])
    raw = tools.read_image("extracted/2103_03404/images/page1_img1.png")
    result = json.loads(raw)

    assert result["image_ref"] == "img://./extracted/2103_03404/images/page1_img1.png"
    assert result["markdown"] == "![page1_img1](img://./extracted/2103_03404/images/page1_img1.png)"
    assert "resolved_path" not in result


def test_read_image_basename_keeps_backward_compatible_ref(tmp_path):
    root = tmp_path / "papers_cache"
    image_path = root / "extracted" / "2103_03404" / "images" / "page1_img1.png"
    image_path.parent.mkdir(parents=True, exist_ok=True)
    image_path.write_bytes(b"fake-image")

    tools = FileSystemTools(allowed_dirs=[root])
    raw = tools.read_image("page1_img1.png")
    result = json.loads(raw)

    assert result["image_ref"] == "img://./page1_img1.png"
    assert result["markdown"] == "![page1_img1](img://./page1_img1.png)"


def test_read_image_absolute_path_returns_relative_ref(tmp_path):
    root = tmp_path / "papers_cache"
    image_path = root / "extracted" / "2103_03404" / "images" / "page2_img1.png"
    image_path.parent.mkdir(parents=True, exist_ok=True)
    image_path.write_bytes(b"fake-image")

    tools = FileSystemTools(allowed_dirs=[root])
    raw = tools.read_image(str(image_path))
    result = json.loads(raw)

    assert result["image_ref"] == "img://./extracted/2103_03404/images/page2_img1.png"
    assert result["markdown"] == "![page2_img1](img://./extracted/2103_03404/images/page2_img1.png)"


def test_read_image_windows_style_relative_path_is_normalized(tmp_path):
    root = tmp_path / "papers_cache"
    image_path = root / "extracted" / "paper_x" / "images" / "fig01.png"
    image_path.parent.mkdir(parents=True, exist_ok=True)
    image_path.write_bytes(b"fake-image")

    tools = FileSystemTools(allowed_dirs=[root])
    raw = tools.read_image(r"extracted\paper_x\images\fig01.png")
    result = json.loads(raw)

    assert result["image_ref"] == "img://./extracted/paper_x/images/fig01.png"


def test_read_image_accepts_img_scheme_path(tmp_path):
    root = tmp_path / "papers_cache"
    image_path = root / "extracted" / "paper_x" / "images" / "fig02.png"
    image_path.parent.mkdir(parents=True, exist_ok=True)
    image_path.write_bytes(b"fake-image")

    tools = FileSystemTools(allowed_dirs=[root])
    raw = tools.read_image("img://./extracted/paper_x/images/fig02.png")
    result = json.loads(raw)

    assert result["image_ref"] == "img://./extracted/paper_x/images/fig02.png"


def test_read_image_accepts_markdown_image_locator(tmp_path):
    root = tmp_path / "papers_cache"
    image_path = root / "extracted" / "paper_x" / "images" / "fig03.png"
    image_path.parent.mkdir(parents=True, exist_ok=True)
    image_path.write_bytes(b"fake-image")

    tools = FileSystemTools(allowed_dirs=[root])
    raw = tools.read_image("![fig03](img://./extracted/paper_x/images/fig03.png)")
    result = json.loads(raw)

    assert result["image_ref"] == "img://./extracted/paper_x/images/fig03.png"


def test_read_image_accepts_session_file_url(tmp_path):
    root = tmp_path / "papers_cache"
    image_path = root / "extracted" / "paper_x" / "images" / "fig 04.png"
    image_path.parent.mkdir(parents=True, exist_ok=True)
    image_path.write_bytes(b"fake-image")

    tools = FileSystemTools(allowed_dirs=[root])
    raw = tools.read_image(
        "http://localhost:8000/api/sessions/00000000-0000-0000-0000-000000000001/files/"
        "extracted/paper_x/images/fig%2004.png"
    )
    result = json.loads(raw)

    assert result["image_ref"] == "img://./extracted/paper_x/images/fig 04.png"
