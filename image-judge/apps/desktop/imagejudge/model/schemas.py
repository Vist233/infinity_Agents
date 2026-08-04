"""可审计的视觉分类输出 Schema。

模型只负责输出类别与可见的 ``spotting_features``。不再要求模型填写
没有校准依据的数字 confidence/score；是否进入人工复核由本地规则归一化。
"""
from __future__ import annotations

import json
from typing import Literal

from pydantic import BaseModel, Field

TaskType = Literal["CLASSIFICATION"]
ClassificationStatus = Literal["CLASSIFIED", "UNKNOWN", "REVIEW"]
FeatureState = Literal["PRESENT", "ABSENT", "UNCLEAR"]
MatchStrength = Literal["STRONG", "MODERATE", "WEAK"]
ImageQuality = Literal["GOOD", "LIMITED", "UNUSABLE"]


class SpottingFeature(BaseModel, extra="forbid"):
    """一个可见特征的核对结果，而不是自由发挥的长篇思维过程。"""

    feature_id: str = Field(min_length=1, max_length=100)
    state: FeatureState
    evidence: str = Field(max_length=500)
    supports: list[str] = Field(default_factory=list, max_length=20)
    contradicts: list[str] = Field(default_factory=list, max_length=20)


class CategoryCandidate(BaseModel, extra="forbid"):
    """可选的候选类别；用离散强度，不伪装成概率。"""

    category_id: str = Field(min_length=1, max_length=100)
    rank: int = Field(ge=1, le=20)
    match_strength: MatchStrength
    evidence: list[str] = Field(default_factory=list, max_length=10)


class ImageQualityInfo(BaseModel, extra="forbid"):
    reference: ImageQuality
    target: ImageQuality


class ReviewInfo(BaseModel, extra="forbid"):
    required: bool
    reasons: list[str] = Field(default_factory=list, max_length=20)


class EvaluationOutput(BaseModel, extra="forbid"):
    """模型必须输出的结构化视觉分类结果。"""

    schema_version: Literal["2.0"]
    task_type: TaskType
    predicted_category: str = Field(min_length=1, max_length=100)
    status: ClassificationStatus
    spotting_features: list[SpottingFeature] = Field(default_factory=list, max_length=50)
    candidate_categories: list[CategoryCandidate] = Field(default_factory=list, max_length=20)
    image_quality: ImageQualityInfo
    reasoning_summary: str = Field(max_length=500)
    review: ReviewInfo


def json_schema_dict() -> dict:
    """生成严格 response_format 使用的 JSON Schema。"""
    return EvaluationOutput.model_json_schema()


def json_schema_str() -> str:
    return json.dumps(json_schema_dict(), ensure_ascii=False)


def parse_evaluation_output(raw_text: str) -> EvaluationOutput:
    """解析并校验当前 2.0 分类输出。"""
    text = raw_text.strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.startswith("json"):
            text = text[4:]
    data = json.loads(text)
    if not isinstance(data, dict):
        raise ValueError("模型输出必须是 JSON 对象")
    return EvaluationOutput.model_validate(data)


class GatewayError(RuntimeError):
    """模型调用错误；携带错误码、是否可重试与 Retry-After。"""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        retryable: bool = False,
        retry_after: float | None = None,
        request_id: str = "",
        status_code: int | None = None,
    ):
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable
        self.retry_after = retry_after
        self.request_id = request_id
        self.status_code = status_code
