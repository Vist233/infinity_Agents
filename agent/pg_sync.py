"""Synchronous helpers for asyncpg access from tool/runtime code."""

from __future__ import annotations

import asyncio
import os
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Awaitable, Optional

import asyncpg


def get_database_url(explicit: Optional[str] = None) -> str:
    database_url = explicit or os.getenv("DATABASE_URL")
    if not database_url:
        raise RuntimeError("DATABASE_URL is not set")
    return database_url


def run_async(coro: Awaitable[Any]) -> Any:
    """
    Run an async coroutine from sync code.

    If we're already inside a running event loop, execute in a dedicated
    background thread so we can still block for result safely.
    """
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coro)

    with ThreadPoolExecutor(max_workers=1) as executor:
        return executor.submit(lambda: asyncio.run(coro)).result()


async def _exec(database_url: str, query: str, *args: Any) -> str:
    conn = await asyncpg.connect(dsn=database_url)
    try:
        return await conn.execute(query, *args)
    finally:
        await conn.close()


async def _fetchrow(database_url: str, query: str, *args: Any):
    conn = await asyncpg.connect(dsn=database_url)
    try:
        return await conn.fetchrow(query, *args)
    finally:
        await conn.close()


async def _fetch(database_url: str, query: str, *args: Any):
    conn = await asyncpg.connect(dsn=database_url)
    try:
        return await conn.fetch(query, *args)
    finally:
        await conn.close()


def exec_sync(database_url: str, query: str, *args: Any) -> str:
    return run_async(_exec(database_url, query, *args))


def fetchrow_sync(database_url: str, query: str, *args: Any):
    return run_async(_fetchrow(database_url, query, *args))


def fetch_sync(database_url: str, query: str, *args: Any):
    return run_async(_fetch(database_url, query, *args))
