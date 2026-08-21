"""Checksum-verified PostgreSQL migrations for the pure-local runtime."""

from __future__ import annotations

import asyncio
import hashlib
import os
from pathlib import Path

import asyncpg


MIGRATIONS_DIR = Path(__file__).with_name("sql")
LOCK_KEY = 7_214_202_608_21


async def apply_migrations(database_url: str) -> list[str]:
    connection = await asyncpg.connect(database_url)
    applied: list[str] = []
    try:
        await connection.execute("CREATE SCHEMA IF NOT EXISTS infinity_runtime")
        await connection.execute(
            """
            CREATE TABLE IF NOT EXISTS infinity_runtime.schema_migrations (
                migration_name TEXT PRIMARY KEY,
                checksum_sha256 CHAR(64) NOT NULL,
                applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
            """
        )
        await connection.execute("SELECT pg_advisory_lock($1)", LOCK_KEY)
        try:
            for path in sorted(MIGRATIONS_DIR.glob("*.sql")):
                sql = path.read_text(encoding="utf-8")
                checksum = hashlib.sha256(sql.encode("utf-8")).hexdigest()
                existing = await connection.fetchrow(
                    """
                    SELECT checksum_sha256
                    FROM infinity_runtime.schema_migrations
                    WHERE migration_name = $1
                    """,
                    path.name,
                )
                if existing:
                    if existing["checksum_sha256"] != checksum:
                        raise RuntimeError(f"Migration checksum changed: {path.name}")
                    continue
                async with connection.transaction():
                    await connection.execute(sql)
                    await connection.execute(
                        """
                        INSERT INTO infinity_runtime.schema_migrations
                            (migration_name, checksum_sha256)
                        VALUES ($1, $2)
                        """,
                        path.name,
                        checksum,
                    )
                applied.append(path.name)
        finally:
            await connection.execute("SELECT pg_advisory_unlock($1)", LOCK_KEY)
    finally:
        await connection.close()
    return applied


async def main() -> None:
    database_url = os.getenv("DATABASE_URL", "").strip()
    if not database_url:
        raise SystemExit("DATABASE_URL is required")
    for migration in await apply_migrations(database_url):
        print(f"applied {migration}")


if __name__ == "__main__":
    asyncio.run(main())
