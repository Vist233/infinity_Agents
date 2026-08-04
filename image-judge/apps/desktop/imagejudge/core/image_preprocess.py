"""图片预处理：格式校验、EXIF 方向归一化、缩放、RGB、编码（文档 §10.3）。"""
from __future__ import annotations

import base64
import io
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageOps, UnidentifiedImageError

from .. import config

# 真实图片格式 -> MIME
_FORMAT_MIME = {
    "JPEG": "image/jpeg",
    "PNG": "image/png",
    "WEBP": "image/webp",
}


class ImagePreprocessError(RuntimeError):
    """图片损坏 / 格式不支持 / 超过大小上限。"""

    def __init__(self, message: str, code: str = "FILE_INVALID"):
        super().__init__(message)
        self.code = code


@dataclass
class PreparedImage:
    data_url: str
    mime: str
    width: int
    height: int
    sha256: str


def _encode(img: Image.Image, mime: str) -> bytes:
    buf = io.BytesIO()
    if mime == "image/jpeg":
        img.save(buf, format="JPEG", quality=config.JPEG_QUALITY)
    elif mime == "image/webp":
        img.save(buf, format="WEBP", quality=config.JPEG_QUALITY)
    else:
        img.save(buf, format="PNG")
    return buf.getvalue()


def prepare_image(path: Path | str) -> PreparedImage:
    """读取并归一化一张图片，返回 base64 data URL。

    - 仅接受 JPG/JPEG/PNG/WEBP；拒绝伪造扩展名（按真实格式判断）。
    - 读取 EXIF Orientation 并归一化。
    - 超过上限时按比例缩放，禁止拉伸。
    - 统一转 RGB；保留原始文件哈希。
    """
    from .scanner import compute_sha256

    path = Path(path)
    if not path.is_file():
        raise ImagePreprocessError(f"文件不存在: {path}")
    size = path.stat().st_size
    if size > config.MAX_IMAGE_BYTES:
        raise ImagePreprocessError(f"图片超过大小上限: {size} bytes")

    try:
        with Image.open(path) as raw:
            real_format = raw.format
            if real_format not in _FORMAT_MIME:
                raise ImagePreprocessError(
                    f"不支持的图片格式: {real_format}", code="FILE_INVALID"
                )
            mime = _FORMAT_MIME[real_format]
            img = raw.convert("RGB")
            img = ImageOps.exif_transpose(img)
    except UnidentifiedImageError as exc:
        raise ImagePreprocessError("无法识别的图片文件", code="FILE_INVALID") from exc

    # 按比例缩放（禁止拉伸）
    w, h = img.size
    long_side = max(w, h)
    if long_side > config.MAX_IMAGE_LONG_SIDE:
        scale = config.MAX_IMAGE_LONG_SIDE / long_side
        img = img.resize(
            (max(1, round(w * scale)), max(1, round(h * scale))),
            Image.Resampling.LANCZOS,
        )

    data = _encode(img, mime)
    b64 = base64.b64encode(data).decode("ascii")
    return PreparedImage(
        data_url=f"data:{mime};base64,{b64}",
        mime=mime,
        width=img.width,
        height=img.height,
        sha256=compute_sha256(path),
    )
