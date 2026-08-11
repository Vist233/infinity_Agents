"""Run schema creation with an operator/bootstrap database login."""

from __future__ import annotations

import asyncio
import os

import asyncpg

from backend.db import ensure_table


async def main() -> None:
    database_url = os.getenv("DATABASE_URL", "").strip()
    if not database_url:
        raise SystemExit("DATABASE_URL is required")
    pool = await asyncpg.create_pool(database_url, min_size=1, max_size=2)
    try:
        await ensure_table(pool)
    finally:
        await pool.close()


if __name__ == "__main__":
    asyncio.run(main())
