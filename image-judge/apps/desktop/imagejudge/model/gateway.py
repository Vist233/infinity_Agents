"""模型网关统一接口：封装平台代理与 BYOK 两种调用路径（文档 §7）。"""
from __future__ import annotations

import abc
from dataclasses import dataclass, field


@dataclass
class EvaluateRequest:
    """一次两图判断请求。"""

    reference_data_url: str
    target_data_url: str
    reference_path: str = ""  # 平台代理 multipart 上传用
    target_path: str = ""
    system_prompt: str = ""
    user_prompt: str = ""
    task_rules: str = ""
    prompt_version: str = "2.0"
    output_schema_version: str = "2.0"
    client_request_id: str = ""
    timeout_seconds: float = 120.0
    repair: bool = False  # 修复重试：追加强化 JSON 约束


@dataclass
class GatewayRawResult:
    """网关原始返回；Pydantic 校验由任务引擎负责。"""

    raw_text: str
    request_id: str = ""
    latency_ms: int = 0
    diagnostics: dict = field(default_factory=dict)


class ModelGateway(abc.ABC):
    """统一 evaluate 接口；所有错误转为 GatewayError。"""

    name: str = "base"

    @abc.abstractmethod
    async def evaluate(self, req: EvaluateRequest) -> GatewayRawResult:
        ...

    async def aclose(self) -> None:  # pragma: no cover - 默认无资源
        return None
