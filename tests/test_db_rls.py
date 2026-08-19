from __future__ import annotations

import pytest

from backend.db_rls import (
    RlsContextError,
    RlsPool,
    rls_reaper_context,
    rls_service_context,
    rls_user_context,
    rls_worker_context,
)


class _Connection:
    def __init__(self) -> None:
        self.commands: list[tuple[str, tuple[object, ...]]] = []

    async def execute(self, query: str, *args, **kwargs) -> str:
        self.commands.append((query, args))
        return "SELECT 1"

    async def fetch(self, query: str, *args, **kwargs):
        self.commands.append((query, args))
        return [{"ok": True}]


class _Pool:
    def __init__(self) -> None:
        self.connection = _Connection()
        self.released: list[_Connection] = []

    async def acquire(self, **kwargs):
        return self.connection

    async def release(self, connection) -> None:
        self.released.append(connection)


@pytest.mark.asyncio
async def test_rls_pool_binds_and_clears_user_context() -> None:
    raw = _Pool()
    pool = RlsPool(raw)

    with rls_user_context("alice"):
        async with pool.acquire() as connection:
            assert connection is raw.connection
            await connection.fetch("SELECT 1")

    commands = [query for query, _args in raw.connection.commands]
    assert commands[:3] == [
        'SET ROLE "infinity_api"',
        "SELECT set_config('app.user_id', $1, false)",
        "SELECT set_config('app.worker_id', $1, false)",
    ]
    assert commands[-10:] == [
        "RESET app.user_id",
        "RESET app.worker_id",
        "RESET app.worker_credential",
        "RESET app.worker_namespace",
        "RESET app.worker_instance_id",
        "RESET app.worker_protocol_version",
        "RESET app.worker_runtime_capability",
        "RESET app.worker_image_digest",
        "RESET app.worker_session_epoch",
        "RESET ROLE",
    ]
    assert raw.released == [raw.connection]


@pytest.mark.asyncio
async def test_rls_pool_selects_worker_and_service_roles() -> None:
    raw = _Pool()
    pool = RlsPool(raw)

    with rls_worker_context("worker-a"):
        await pool.fetch("SELECT 1")
    with rls_service_context("outbox"):
        await pool.fetch("SELECT 1")
    with rls_reaper_context():
        await pool.fetch("SELECT 1")

    role_commands = [query for query, _args in raw.connection.commands if query.startswith("SET ROLE")]
    assert role_commands == [
        'SET ROLE "infinity_worker"',
        'SET ROLE "infinity_outbox"',
        'SET ROLE "infinity_reaper"',
    ]


@pytest.mark.asyncio
async def test_rls_pool_binds_worker_credential_proof() -> None:
    raw = _Pool()
    pool = RlsPool(raw)

    with rls_worker_context("worker-a", "persistent-secret", "cluster-a"):
        await pool.fetch("SELECT 1")

    configured = [
        (query, args)
        for query, args in raw.connection.commands
        if "app.worker_credential" in query
    ]
    assert configured == [
        ("SELECT set_config('app.worker_credential', $1, false)", ("persistent-secret",)),
        ("RESET app.worker_credential", ()),
    ]
    namespace = [
        (query, args)
        for query, args in raw.connection.commands
        if "app.worker_namespace" in query
    ]
    assert namespace == [
        ("SELECT set_config('app.worker_namespace', $1, false)", ("cluster-a",)),
        ("RESET app.worker_namespace", ()),
    ]


@pytest.mark.asyncio
async def test_rls_pool_rejects_unbound_access() -> None:
    raw = _Pool()
    pool = RlsPool(raw)

    with pytest.raises(RlsContextError):
        async with pool.acquire():
            pass
    assert raw.released == [raw.connection]
