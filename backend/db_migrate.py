"""Run schema creation with an operator/bootstrap database login."""

from __future__ import annotations

import asyncio
import os

import asyncpg

from backend.db import ensure_table
from backend.local_runtime.migrations import apply_migrations


async def main() -> None:
    database_url = os.getenv("DATABASE_URL", "").strip()
    if not database_url:
        raise SystemExit("DATABASE_URL is required")
    pool = await asyncpg.create_pool(database_url, min_size=1, max_size=2)
    try:
        await ensure_table(pool)
    finally:
        await pool.close()
    # The Worker v2 control plane owns a small, isolated schema in the same
    # local PostgreSQL instance.  Keeping this here makes a fresh local
    # bootstrap complete: the API's legacy product tables and the v2 worker
    # state machine are migrated together.  The Cloudflare deployment does
    # not invoke this command and remains on its own D1 migration path.
    await apply_migrations(database_url)


if __name__ == "__main__":
    asyncio.run(main())
