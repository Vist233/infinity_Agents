"""Request-scoped PostgreSQL RLS context for the application and Workers.

The database policies in ``scripts/rls_roles.sql`` deliberately deny access
when no actor context is present.  This module keeps that context on the
asyncio task and applies it to every connection acquired from the runtime
pool.  The values are reset before a connection is returned to asyncpg so a
subsequent request can never inherit the previous request's identity.
"""

from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar, Token
from dataclasses import dataclass
import hashlib
import hmac
import os
from typing import Any, Iterator, Optional


@dataclass(frozen=True)
class RlsActor:
    kind: str
    identity: str
    # Worker contexts carry the raw persistent credential only in the
    # request-local context.  The RLS pool passes it to PostgreSQL so the
    # database can bind app.worker_id to an enrollment row instead of trusting
    # a Worker-supplied ID by itself.
    credential: Optional[str] = None
    namespace: Optional[str] = None
    instance_id: Optional[str] = None
    protocol_version: Optional[str] = None
    runtime_capability: Optional[str] = None
    image_digest: Optional[str] = None
    session_epoch: Optional[int] = None


_current_actor: ContextVar[Optional[RlsActor]] = ContextVar(
    "infinity_rls_actor", default=None
)


class RlsContextError(RuntimeError):
    """Raised when a protected database operation has no actor context."""


def current_rls_actor() -> Optional[RlsActor]:
    return _current_actor.get()


def set_rls_user(user_id: str) -> Token[Optional[RlsActor]]:
    value = str(user_id or "").strip()
    if not value:
        raise ValueError("RLS user ID cannot be empty")
    return _current_actor.set(RlsActor("user", value))


@contextmanager
def rls_user_context(user_id: str) -> Iterator[None]:
    value = str(user_id or "").strip()
    if not value:
        raise ValueError("RLS user ID cannot be empty")
    token = _current_actor.set(RlsActor("user", value))
    try:
        yield
    finally:
        _current_actor.reset(token)


def set_rls_worker(
    worker_id: str,
    credential: str | None = None,
    namespace: str | None = None,
    *,
    instance_id: str | None = None,
    protocol_version: str | None = None,
    runtime_capability: str | None = None,
    image_digest: str | None = None,
    session_epoch: int | None = None,
) -> Token[Optional[RlsActor]]:
    value = str(worker_id or "").strip()
    if not value:
        raise ValueError("RLS worker ID cannot be empty")
    secret = str(credential or "")
    cluster = str(namespace or "").strip() or None
    return _current_actor.set(
        RlsActor(
            "worker",
            value,
            secret or None,
            cluster,
            str(instance_id or "").strip() or None,
            str(protocol_version or "").strip() or None,
            str(runtime_capability or "").strip() or None,
            str(image_digest or "").strip() or None,
            session_epoch,
        )
    )


@contextmanager
def rls_worker_context(
    worker_id: str,
    credential: str | None = None,
    namespace: str | None = None,
    *,
    instance_id: str | None = None,
    protocol_version: str | None = None,
    runtime_capability: str | None = None,
    image_digest: str | None = None,
    session_epoch: int | None = None,
) -> Iterator[None]:
    value = str(worker_id or "").strip()
    if not value:
        raise ValueError("RLS worker ID cannot be empty")
    secret = str(credential or "")
    cluster = str(namespace or "").strip() or None
    token = _current_actor.set(
        RlsActor(
            "worker",
            value,
            secret or None,
            cluster,
            str(instance_id or "").strip() or None,
            str(protocol_version or "").strip() or None,
            str(runtime_capability or "").strip() or None,
            str(image_digest or "").strip() or None,
            session_epoch,
        )
    )
    try:
        yield
    finally:
        _current_actor.reset(token)


@contextmanager
def rls_service_context(name: str = "outbox") -> Iterator[None]:
    """Bind a narrowly named internal service actor for background work."""

    value = str(name or "").strip()
    if not value:
        raise ValueError("RLS service name cannot be empty")
    token = _current_actor.set(RlsActor("service", value))
    try:
        yield
    finally:
        _current_actor.reset(token)


@contextmanager
def rls_reaper_context(name: str = "reaper") -> Iterator[None]:
    """Bind the narrowly scoped lease-recovery service actor."""

    value = str(name or "").strip()
    if not value:
        raise ValueError("RLS reaper name cannot be empty")
    token = _current_actor.set(RlsActor("reaper", value))
    try:
        yield
    finally:
        _current_actor.reset(token)


def reset_rls_context(token: Token[Optional[RlsActor]]) -> None:
    _current_actor.reset(token)


def clear_rls_context() -> None:
    """Clear the current task's actor without relying on a cross-task Token."""
    _current_actor.set(None)


def rls_enabled_from_env() -> bool:
    app_env = os.getenv("APP_ENV", "development").lower()
    return os.getenv(
        "DB_RLS_ENABLED",
        "1" if app_env in {"acceptance", "production", "prod"} else "0",
    ).strip().lower() not in {"0", "false", "no", "off"}


def wrap_runtime_pool(pool: Any) -> "RlsPool":
    return RlsPool(
        pool,
        require_context=os.getenv("DB_RLS_REQUIRE_CONTEXT", "1").strip().lower()
        not in {"0", "false", "no", "off"},
        api_role=os.getenv("DB_RLS_API_ROLE", "infinity_api"),
        worker_role=os.getenv("DB_RLS_WORKER_ROLE", "infinity_worker"),
        service_role=os.getenv("DB_RLS_SERVICE_ROLE", "infinity_outbox"),
        reaper_role=os.getenv("DB_RLS_REAPER_ROLE", "infinity_reaper"),
        user_context_secret=os.getenv("DB_RLS_USER_CONTEXT_SECRET", "").strip(),
    )


def user_context_proof(user_id: str, secret: Optional[str] = None) -> str:
    """Create the database-verifiable proof for an API user context."""
    key = (secret if secret is not None else os.getenv("DB_RLS_USER_CONTEXT_SECRET", "")).encode("utf-8")
    if not key:
        raise RlsContextError("DB_RLS_USER_CONTEXT_SECRET is required for user RLS")
    return hmac.new(key, str(user_id).encode("utf-8"), hashlib.sha256).hexdigest()


class _RlsAcquire:
    def __init__(self, pool: "RlsPool", timeout: Optional[float]) -> None:
        self._pool = pool
        self._timeout = timeout
        self._connection: Any = None
        self._configured = False

    async def __aenter__(self) -> Any:
        if self._timeout is None:
            connection = await self._pool._pool.acquire()
        else:
            connection = await self._pool._pool.acquire(timeout=self._timeout)
        self._connection = connection
        actor = current_rls_actor()
        if actor is None and self._pool.require_context:
            await self._pool._pool.release(connection)
            self._connection = None
            raise RlsContextError(
                "protected database access requires a user, Worker, or service context"
            )

        try:
            if actor is not None:
                role = self._pool.role_for(actor.kind)
                # role_for only returns configured, operator-controlled role
                # names; quoting it still keeps this statement safe if an
                # operator changes an environment value.
                quoted_role = '"' + role.replace('"', '""') + '"'
                await connection.execute(f"SET ROLE {quoted_role}")
                await connection.execute(
                    "SELECT set_config('app.user_id', $1, false)",
                    actor.identity if actor.kind == "user" else "",
                )
                if actor.kind == "user" and self._pool.user_context_secret:
                    await connection.execute(
                        "SELECT set_config('app.user_proof', $1, false)",
                        user_context_proof(actor.identity, self._pool.user_context_secret),
                    )
                await connection.execute(
                    "SELECT set_config('app.worker_id', $1, false)",
                    actor.identity if actor.kind == "worker" else "",
                )
                if actor.kind == "worker":
                    await connection.execute(
                        "SELECT set_config('app.worker_credential', $1, false)",
                        actor.credential or "",
                    )
                    await connection.execute(
                        "SELECT set_config('app.worker_namespace', $1, false)",
                        actor.namespace or "",
                    )
                    await connection.execute(
                        "SELECT set_config('app.worker_instance_id', $1, false)",
                        actor.instance_id or "",
                    )
                    await connection.execute(
                        "SELECT set_config('app.worker_protocol_version', $1, false)",
                        actor.protocol_version or "",
                    )
                    await connection.execute(
                        "SELECT set_config('app.worker_runtime_capability', $1, false)",
                        actor.runtime_capability or "",
                    )
                    await connection.execute(
                        "SELECT set_config('app.worker_image_digest', $1, false)",
                        actor.image_digest or "",
                    )
                    await connection.execute(
                        "SELECT set_config('app.worker_session_epoch', $1, false)",
                        str(actor.session_epoch) if actor.session_epoch is not None else "",
                    )
            self._configured = True
            return connection
        except BaseException:
            try:
                await self._pool._pool.release(connection)
            finally:
                self._connection = None
            raise

    async def __aexit__(self, exc_type, exc_value, traceback) -> None:
        connection = self._connection
        self._connection = None
        if connection is None:
            return
        try:
            if self._configured:
                # These are session settings, not transaction-local settings,
                # because one acquisition may contain several statements and
                # nested transactions. Always clear them before release.
                await connection.execute("RESET app.user_id")
                if self._pool.user_context_secret:
                    await connection.execute("RESET app.user_proof")
                await connection.execute("RESET app.worker_id")
                await connection.execute("RESET app.worker_credential")
                await connection.execute("RESET app.worker_namespace")
                await connection.execute("RESET app.worker_instance_id")
                await connection.execute("RESET app.worker_protocol_version")
                await connection.execute("RESET app.worker_runtime_capability")
                await connection.execute("RESET app.worker_image_digest")
                await connection.execute("RESET app.worker_session_epoch")
                await connection.execute("RESET ROLE")
        finally:
            await self._pool._pool.release(connection)


class RlsPool:
    """Small asyncpg pool facade that injects and clears RLS context."""

    def __init__(
        self,
        pool: Any,
        *,
        require_context: bool = True,
        api_role: str = "infinity_api",
        worker_role: str = "infinity_worker",
        service_role: str = "infinity_outbox",
        reaper_role: str = "infinity_reaper",
        user_context_secret: str = "",
    ) -> None:
        self._pool = pool
        self.require_context = require_context
        self.user_context_secret = str(user_context_secret or "").strip()
        self._roles = {
            "user": str(api_role).strip() or "infinity_api",
            "worker": str(worker_role).strip() or "infinity_worker",
            "service": str(service_role).strip() or "infinity_outbox",
            "reaper": str(reaper_role).strip() or "infinity_reaper",
        }

    def role_for(self, kind: str) -> str:
        try:
            return self._roles[kind]
        except KeyError as exc:
            raise RlsContextError(f"unsupported RLS actor kind: {kind}") from exc

    def acquire(self, *, timeout: Optional[float] = None) -> _RlsAcquire:
        return _RlsAcquire(self, timeout)

    async def execute(self, query: str, *args: Any, timeout: Optional[float] = None) -> str:
        async with self.acquire(timeout=timeout) as connection:
            return await connection.execute(query, *args, timeout=timeout)

    async def fetch(self, query: str, *args: Any, timeout: Optional[float] = None, record_class=None):
        async with self.acquire(timeout=timeout) as connection:
            return await connection.fetch(query, *args, timeout=timeout, record_class=record_class)

    async def fetchrow(self, query: str, *args: Any, timeout: Optional[float] = None, record_class=None):
        async with self.acquire(timeout=timeout) as connection:
            return await connection.fetchrow(query, *args, timeout=timeout, record_class=record_class)

    async def fetchval(self, query: str, *args: Any, column: int = 0, timeout: Optional[float] = None):
        async with self.acquire(timeout=timeout) as connection:
            return await connection.fetchval(query, *args, column=column, timeout=timeout)

    async def executemany(self, query: str, args, *, timeout: Optional[float] = None):
        async with self.acquire(timeout=timeout) as connection:
            return await connection.executemany(query, args, timeout=timeout)

    async def close(self) -> None:
        await self._pool.close()

    def __getattr__(self, name: str) -> Any:
        return getattr(self._pool, name)
