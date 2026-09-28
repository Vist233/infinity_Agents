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
    for migration in await apply_migrations(database_url):
        print(f"applied {migration}")


if __name__ == "__main__":
    asyncio.run(main())
