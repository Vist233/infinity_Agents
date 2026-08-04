"""SQLAlchemy 引擎与会话工厂。

SQLite 是唯一内部事实源：启用 WAL、busy_timeout，
并通过单一 Repository 层控制事务与状态迁移。
"""
from __future__ import annotations

from pathlib import Path

from sqlalchemy import create_engine, event
from sqlalchemy.engine import Engine
from sqlalchemy.orm import sessionmaker

from .. import config
from .models import Base

_engine: Engine | None = None
_SessionLocal = None


def _configure_sqlite(dbapi_conn, connection_record):  # pragma: no cover - 事件钩子
    """为每个 SQLite 连接设置 WAL 与 busy_timeout。"""
    cursor = dbapi_conn.cursor()
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.execute("PRAGMA synchronous=NORMAL")
    cursor.execute("PRAGMA busy_timeout=5000")
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.close()


def get_engine(db_path: Path | None = None) -> Engine:
    """返回全局引擎（惰性创建）。测试可传入独立 db_path。"""
    global _engine, _SessionLocal
    if db_path is not None:
        # 测试或显式路径：创建独立引擎，不覆盖全局
        return _build_engine(db_path)
    if _engine is None:
        config.ensure_app_dirs()
        _engine = _build_engine(config.database_path())
        _SessionLocal = sessionmaker(bind=_engine, expire_on_commit=False, future=True)
    return _engine


def _build_engine(db_path: Path) -> Engine:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    engine = create_engine(
        f"sqlite:///{db_path}",
        future=True,
        connect_args={"check_same_thread": False},
    )
    event.listen(engine, "connect", _configure_sqlite)
    return engine


def get_session_factory(db_path: Path | None = None):
    """返回会话工厂。测试可针对独立数据库。"""
    if db_path is not None:
        engine = get_engine(db_path)
        return sessionmaker(bind=engine, expire_on_commit=False, future=True)
    get_engine()
    return _SessionLocal


def init_db(db_path: Path | None = None) -> None:
    """创建当前 2.0 分类 schema 的全部表。

    本版本不读取或转换旧的 1.0 结果；如果本机仍有旧数据库，应在设置中
    删除旧数据后重新创建数据库。这样可以避免把旧输出字段混入新事实源。
    """
    engine = get_engine(db_path)
    Base.metadata.create_all(engine)


def dispose_engine() -> None:
    global _engine, _SessionLocal
    if _engine is not None:
        _engine.dispose()
    _engine = None
    _SessionLocal = None
