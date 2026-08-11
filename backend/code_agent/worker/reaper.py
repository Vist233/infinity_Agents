"""Dedicated lease-recovery process.

Lease recovery is intentionally separate from the data-plane Worker.  The
process uses a login that can SET ROLE only to ``infinity_reaper``; Workers
therefore cannot turn their normal execution connection into a lease-recovery
connection.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
import logging
import os
from pathlib import Path

import asyncpg

from backend.code_agent.task_service import reap_expired_lease
from backend.db_rls import rls_enabled_from_env, rls_reaper_context, wrap_runtime_pool

logger = logging.getLogger(__name__)


def _artifact_path_in_configured_root(raw_path: str) -> Path | None:
    """Resolve a local artifact path only when it is inside a configured root."""
    configured_roots = {
        value
        for value in (
            os.getenv("ARTIFACT_DOWNLOAD_ROOT"),
            os.getenv("ARTIFACT_STORAGE_ROOT"),
        )
        if value
    }
    roots = [Path(value).resolve() for value in configured_roots]
    if not raw_path:
        return None
    storage_path = Path(raw_path)
    try:
        if storage_path.is_symlink():
            logger.warning("Skipping symlinked recovered artifact %s", storage_path)
            return None
        resolved = storage_path.resolve(strict=False)
        if any(resolved != root and resolved.is_relative_to(root) for root in roots):
            return resolved
    except (OSError, ValueError) as exc:
        logger.warning("Could not validate recovered artifact %s: %s", raw_path, exc)
    return None


async def _cleanup_artifact_tombstones(pool, *, limit: int = 50) -> int:
    """Retry committed artifact cleanup until the physical file is gone."""
    cleaned = 0
    async with pool.acquire() as conn:
        async with conn.transaction():
            rows = await conn.fetch(
                """
                SELECT artifact_id, storage_backend, storage_path
                FROM artifacts
                WHERE deleted_at IS NOT NULL
                  AND cleanup_completed_at IS NULL
                ORDER BY deleted_at ASC
                LIMIT $1
                FOR UPDATE SKIP LOCKED
                """,
                max(1, min(int(limit), 200)),
            )
            for row in rows:
                if str(row["storage_backend"] or "local") != "local":
                    logger.warning(
                        "No local cleanup adapter for artifact %s backend %s",
                        row["artifact_id"], row["storage_backend"],
                    )
                    continue
                resolved = _artifact_path_in_configured_root(str(row["storage_path"] or ""))
                if resolved is None:
                    continue
                try:
                    if resolved.exists() and not resolved.is_dir():
                        resolved.unlink()
                    await conn.execute(
                        """
                        UPDATE artifacts
                        SET cleanup_completed_at = NOW()
                        WHERE artifact_id = $1
                          AND deleted_at IS NOT NULL
                          AND cleanup_completed_at IS NULL
                        """,
                        row["artifact_id"],
                    )
                    cleaned += 1
                except OSError as exc:
                    logger.warning("Could not remove recovered artifact %s: %s", row["storage_path"], exc)
    return cleaned


async def reap_once(pool, *, limit: int = 10) -> int:
    """Recover a bounded batch of expired leases under the reaper context."""

    recovered_count = 0
    observed_at = datetime.now(timezone.utc)
    with rls_reaper_context():
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT task_id, lease_token
                FROM tasks
                WHERE status IN ('claimed', 'running')
                  AND lease_expires_at < NOW()
                ORDER BY lease_expires_at ASC
                LIMIT $1
                FOR UPDATE SKIP LOCKED
                """,
                max(1, min(int(limit), 100)),
            )
        for row in rows:
            recovered = await reap_expired_lease(
                pool,
                str(row["task_id"]),
                row["lease_token"],
                now=observed_at,
            )
            if recovered:
                recovered_count += 1
                logger.info("Reaper reclaimed task %s -> %s", row["task_id"], recovered["status"])
        cleaned = await _cleanup_artifact_tombstones(pool, limit=max(limit, 50))
        if cleaned:
            logger.info("Reaper removed %d expired artifact file(s)", cleaned)
    return recovered_count


async def run_reaper(pool, *, interval: float = 10.0, limit: int = 10) -> None:
    """Run lease recovery until the process is cancelled."""

    while True:
        try:
            await reap_once(pool, limit=limit)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning("Lease reaper error: %s", exc)
        await asyncio.sleep(max(1.0, float(interval)))


async def main() -> None:
    logging.basicConfig(level=logging.INFO)
    database_url = os.getenv("DATABASE_URL")
    if not database_url:
        raise SystemExit("DATABASE_URL is required")
    from backend.security import validate_runtime_database_url
    validate_runtime_database_url(database_url)
    raw_pool = await asyncpg.create_pool(database_url, min_size=1, max_size=2)
    pool = wrap_runtime_pool(raw_pool) if rls_enabled_from_env() else raw_pool
    try:
        await run_reaper(
            pool,
            interval=float(os.getenv("REAPER_INTERVAL_SECONDS", "10")),
            limit=int(os.getenv("REAPER_SCAN_LIMIT", "10")),
        )
    finally:
        await pool.close()


if __name__ == "__main__":
    asyncio.run(main())
