"""
Image analysis tools for PaperAgent.

Provides a vision-capable tool to inspect local images inside allowed directories.
"""

import base64
import json
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from agno.tools import Toolkit
from agno.utils.log import logger
from openai import OpenAI
from PIL import Image

from agent.tools.file_tools import PAPERS_DIR, PLOT_OUTPUTS_DIR, PLOTLY_OUTPUTS_DIR


class ImageAnalysisTools(Toolkit):
    """Toolkit that analyzes local images with a vision model."""

    _SUPPORTED_IMAGE_TYPES = {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".webp": "image/webp",
        ".bmp": "image/bmp",
    }

    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: str = "https://api.moonshot.cn/v1",
        model_id: str = "kimi-k2.5",
        allowed_dirs: Optional[List[Path]] = None,
        max_image_mb: int = 20,
        max_output_chars: int = 8000,
        **kwargs: Any,
    ) -> None:
        self.api_key = api_key
        self.base_url = base_url
        self.model_id = model_id
        self.max_image_bytes = max_image_mb * 1024 * 1024
        self.max_output_chars = max_output_chars
        self.allowed_dirs = allowed_dirs or [PAPERS_DIR, PLOT_OUTPUTS_DIR, PLOTLY_OUTPUTS_DIR]

        for d in self.allowed_dirs:
            d.mkdir(parents=True, exist_ok=True)

        tools: List[Any] = [self.analyze_image]
        super().__init__(name="image_analysis_tools", tools=tools, **kwargs)

    def _is_path_allowed(self, path: Path) -> bool:
        resolved = path.resolve()
        return any(
            resolved == allowed.resolve()
            or str(resolved).startswith(str(allowed.resolve()) + "/")
            for allowed in self.allowed_dirs
        )

    def _resolve_path(self, path_str: str) -> Optional[Path]:
        normalized = str(path_str or "").replace("\\", "/")
        candidate = Path(normalized)
        if candidate.is_absolute():
            if candidate.exists() and self._is_path_allowed(candidate):
                return candidate
            return None

        for allowed in self.allowed_dirs:
            p = allowed / normalized
            if p.exists() and self._is_path_allowed(p):
                return p

        if "/" not in normalized:
            for allowed in self.allowed_dirs:
                for p in allowed.rglob(normalized):
                    if p.is_file() and self._is_path_allowed(p):
                        return p
        return None

    def _to_relative_ref_path(self, image_path: Path) -> str:
        resolved = image_path.resolve()
        for allowed in self.allowed_dirs:
            try:
                return resolved.relative_to(allowed.resolve()).as_posix()
            except ValueError:
                continue
        return image_path.name

    def _load_image(self, image_path: Path) -> Tuple[bytes, Dict[str, Any]]:
        ext = image_path.suffix.lower()
        mime_type = self._SUPPORTED_IMAGE_TYPES.get(ext)
        if not mime_type:
            raise ValueError(f"unsupported_image_format:{ext}")

        size_bytes = image_path.stat().st_size
        if size_bytes > self.max_image_bytes:
            raise ValueError(
                f"image_too_large:{size_bytes}_bytes_limit_{self.max_image_bytes}_bytes"
            )

        with Image.open(image_path) as img:
            width, height = img.size
            mode = img.mode

        raw = image_path.read_bytes()
        meta = {
            "file_path": str(image_path),
            "file_name": image_path.name,
            "size_bytes": size_bytes,
            "mime_type": mime_type,
            "width": width,
            "height": height,
            "mode": mode,
        }
        return raw, meta

    def _build_data_url(self, content: bytes, mime_type: str) -> str:
        b64 = base64.b64encode(content).decode("ascii")
        return f"data:{mime_type};base64,{b64}"

    def analyze_image(
        self,
        image_path: str,
        prompt: str = "请分析这张图像的主要内容、关键趋势、异常点，并给出简洁结论。",
        detail: str = "high",
    ) -> str:
        """Analyze a local image with a vision model.

        Args:
            image_path (str): Absolute/relative path or plain filename inside allowed directories.
            prompt (str): Analysis instruction in natural language.
            detail (str): Vision detail level, one of low/high/auto.

        Returns:
            str: JSON with structured analysis or error details.
        """
        resolved = self._resolve_path(image_path)
        if resolved is None:
            return json.dumps(
                {
                    "error": f"Image '{image_path}' not found or outside allowed directories.",
                    "allowed_directories": [str(d) for d in self.allowed_dirs],
                },
                ensure_ascii=False,
            )

        if detail not in {"low", "high", "auto"}:
            detail = "high"

        try:
            image_bytes, image_meta = self._load_image(resolved)
        except Exception as e:
            return json.dumps({"error": str(e)}, ensure_ascii=False)

        if not self.api_key:
            return json.dumps(
                {
                    "error": "vision_api_key_missing",
                    "message": "未配置 API key，无法执行视觉分析。",
                    "image": image_meta,
                },
                ensure_ascii=False,
            )

        image_url = self._build_data_url(image_bytes, image_meta["mime_type"])
        client = OpenAI(api_key=self.api_key, base_url=self.base_url)

        system_prompt = (
            "你是论文图表分析助手。请输出结构化中文结论："
            "图像类型、核心信息、可能风险、简短建议。"
        )
        try:
            completion = client.chat.completions.create(
                model=self.model_id,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": prompt},
                            {
                                "type": "image_url",
                                "image_url": {"url": image_url, "detail": detail},
                            },
                        ],
                    },
                ],
                temperature=0.1,
            )
            analysis_text = completion.choices[0].message.content or ""
            if len(analysis_text) > self.max_output_chars:
                analysis_text = analysis_text[: self.max_output_chars] + "\n... [analysis truncated]"

            raw_input = str(image_path or "")
            input_path = Path(raw_input)
            if input_path.is_absolute():
                ref_path = self._to_relative_ref_path(resolved)
            elif "/" in raw_input or "\\" in raw_input:
                ref_path = Path(raw_input.replace("\\", "/")).as_posix().lstrip("/")
            else:
                ref_path = resolved.name
            img_ref = f"img://{ref_path}"
            return json.dumps(
                {
                    "success": True,
                    "model": self.model_id,
                    "prompt": prompt,
                    "detail": detail,
                    "image": image_meta,
                    "image_ref": img_ref,
                    "markdown": f"![{resolved.stem}]({img_ref})",
                    "analysis": analysis_text,
                },
                ensure_ascii=False,
            )
        except Exception as e:
            logger.warning(f"Image analysis failed for {resolved}: {e}")
            return json.dumps(
                {
                    "error": "vision_analysis_failed",
                    "message": str(e),
                    "hint": (
                        "请确认模型支持图像输入。可通过 PAPER_AGENT_VISION_MODEL 指定视觉模型；"
                        "若继续使用 kimi-k2.5，请确认网关已开启多模态。"
                    ),
                    "image": image_meta,
                },
                ensure_ascii=False,
            )
