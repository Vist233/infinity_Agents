"""SQLAlchemy ORM 模型（文档 §12.2 表设计）。"""
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import (
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


def utcnow() -> datetime:
    """统一使用 naive UTC 时间，避免 SQLite 驱动丢失 tzinfo 导致比较异常。"""
    return datetime.now(timezone.utc).replace(tzinfo=None)


class Base(DeclarativeBase):
    pass


class Project(Base):
    """保存参考图、规则和运行配置。"""

    __tablename__ = "projects"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(200), default="")
    reference_path: Mapped[str] = mapped_column(Text, default="")
    reference_sha256: Mapped[str] = mapped_column(String(64), default="", index=True)
    prompt_text: Mapped[str] = mapped_column(Text, default="")
    prompt_version: Mapped[str] = mapped_column(String(20), default="2.0")
    model_id: Mapped[str] = mapped_column(String(100), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class TaskRun(Base):
    """一次批量运行。"""

    __tablename__ = "task_runs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), index=True)
    input_type: Mapped[str] = mapped_column(String(20), default="folder")  # file | folder
    input_path: Mapped[str] = mapped_column(Text, default="")
    recursive: Mapped[int] = mapped_column(Integer, default=0)
    output_dir: Mapped[str] = mapped_column(Text, default="")
    csv_name: Mapped[str] = mapped_column(String(200), default="results_live.csv")
    status: Mapped[str] = mapped_column(String(30), default="DRAFT", index=True)
    total: Mapped[int] = mapped_column(Integer, default=0)
    succeeded: Mapped[int] = mapped_column(Integer, default=0)
    failed: Mapped[int] = mapped_column(Integer, default=0)
    review: Mapped[int] = mapped_column(Integer, default=0)
    timeout_seconds: Mapped[Float] = mapped_column(Float, default=120.0)
    max_retries: Mapped[int] = mapped_column(Integer, default=2)
    started_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class TaskItem(Base):
    """每个待判断图片。"""

    __tablename__ = "task_items"
    __table_args__ = (UniqueConstraint("run_id", "path", name="uq_item_run_path"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    run_id: Mapped[int] = mapped_column(ForeignKey("task_runs.id"), index=True)
    path: Mapped[str] = mapped_column(Text)
    relative_path: Mapped[str] = mapped_column(Text, default="")
    sha256: Mapped[str] = mapped_column(String(64), default="", index=True)
    status: Mapped[str] = mapped_column(String(30), default="PENDING", index=True)
    attempt_count: Mapped[int] = mapped_column(Integer, default=0)
    next_retry_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    error_code: Mapped[str] = mapped_column(String(50), default="")
    error_message: Mapped[str] = mapped_column(Text, default="")
    client_request_id: Mapped[str] = mapped_column(String(64), default="", index=True)
    duration_ms: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class EvaluationResult(Base):
    """模型结构化分类结果；item_id 唯一，避免重复插入。"""

    __tablename__ = "evaluation_results"
    __table_args__ = (UniqueConstraint("item_id", name="uq_result_item"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    item_id: Mapped[int] = mapped_column(ForeignKey("task_items.id"), index=True)
    task_type: Mapped[str] = mapped_column(String(30), default="CLASSIFICATION")
    predicted_category: Mapped[str] = mapped_column(String(100), default="")
    result_status: Mapped[str] = mapped_column(String(30), default="")
    reasoning_summary: Mapped[str] = mapped_column(Text, default="")
    review_reasons_json: Mapped[str] = mapped_column(Text, default="[]")
    detail_json: Mapped[str] = mapped_column(Text, default="{}")
    needs_human_review: Mapped[int] = mapped_column(Integer, default=0)
    model_id: Mapped[str] = mapped_column(String(100), default="")
    request_id: Mapped[str] = mapped_column(String(128), default="")
    prompt_version: Mapped[str] = mapped_column(String(20), default="2.0")
    schema_version: Mapped[str] = mapped_column(String(20), default="2.0")
    latency_ms: Mapped[int] = mapped_column(Integer, default=0)
    diagnostics: Mapped[str] = mapped_column(Text, default="")  # 原始响应截断摘要
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class EvaluationSpottingFeature(Base):
    """逐项可见特征；SQLite 中一条特征一条记录，便于检索和审计。"""

    __tablename__ = "evaluation_spotting_features"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    evaluation_result_id: Mapped[int] = mapped_column(
        ForeignKey("evaluation_results.id"), index=True
    )
    feature_id: Mapped[str] = mapped_column(String(100), default="")
    state: Mapped[str] = mapped_column(String(20), default="UNCLEAR")
    evidence: Mapped[str] = mapped_column(Text, default="")
    supports_json: Mapped[str] = mapped_column(Text, default="[]")
    contradicts_json: Mapped[str] = mapped_column(Text, default="[]")
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class ExportOutbox(Base):
    """CSV 待同步事件。"""

    __tablename__ = "export_outbox"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    run_id: Mapped[int] = mapped_column(ForeignKey("task_runs.id"), index=True)
    item_id: Mapped[int] = mapped_column(ForeignKey("task_items.id"), index=True)
    event_type: Mapped[str] = mapped_column(String(30), default="UPSERT_CSV_ROW")
    status: Mapped[str] = mapped_column(String(20), default="PENDING", index=True)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    last_error: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=utcnow, onupdate=utcnow
    )


class ExportState(Base):
    """CSV 文件位置与最后同步信息。"""

    __tablename__ = "export_state"

    run_id: Mapped[int] = mapped_column(ForeignKey("task_runs.id"), primary_key=True)
    csv_path: Mapped[str] = mapped_column(Text, default="")
    last_synced_outbox_id: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[str] = mapped_column(String(20), default="IDLE")
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=utcnow, onupdate=utcnow
    )


class AppSetting(Base):
    """非敏感设置。"""

    __tablename__ = "app_settings"

    key: Mapped[str] = mapped_column(String(100), primary_key=True)
    value_json: Mapped[str] = mapped_column(Text, default="{}")
