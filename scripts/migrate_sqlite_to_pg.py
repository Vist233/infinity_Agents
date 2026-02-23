#!/usr/bin/env python3
"""One-off migration from legacy SQLite session/paper DBs to PostgreSQL."""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import shutil
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Dict, List, Optional

import asyncpg


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def _parse_dt(raw: str | None, default: datetime) -> datetime:
    if not raw:
        return default
    try:
        dt = datetime.fromisoformat(raw)
    except ValueError:
        return default
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


def _as_path(raw: object) -> Optional[Path]:
    if not isinstance(raw, str) or not raw.strip():
        return None
    return Path(raw)


def _canonical_paper_id_from_ref(ref: str) -> Optional[str]:
    if not ref:
        return None
    match = re.search(r"(\d{4}\.\d{4,5})(v\d+)?", ref)
    if match:
        return match.group(0).replace(".", "_")
    if ref.isdigit():
        return ref
    pm_match = re.search(r"/(\d+)/?$", ref)
    if pm_match:
        return pm_match.group(1)
    return None


def _should_replace(dst: Path, src: Path) -> bool:
    """Choose better file by size, then mtime."""
    try:
        dst_stat = dst.stat()
        src_stat = src.stat()
    except OSError:
        return False
    if src_stat.st_size > dst_stat.st_size:
        return True
    if src_stat.st_size == dst_stat.st_size and src_stat.st_mtime > dst_stat.st_mtime:
        return True
    return False


def _merge_file(src: Path, dst: Path, file_stats: Dict[str, int]) -> Optional[Path]:
    if not src.exists() or not src.is_file():
        return None
    dst.parent.mkdir(parents=True, exist_ok=True)

    if not dst.exists():
        shutil.move(str(src), str(dst))
        file_stats["moved_files"] += 1
        return dst

    if _should_replace(dst, src):
        src_tmp = src.with_suffix(src.suffix + ".migrating_tmp")
        shutil.move(str(src), str(src_tmp))
        dst.unlink(missing_ok=True)
        shutil.move(str(src_tmp), str(dst))
        file_stats["replaced_files"] += 1
        return dst

    src.unlink(missing_ok=True)
    file_stats["deduped_files"] += 1
    return dst


def _merge_tree(src_dir: Path, dst_dir: Path, file_stats: Dict[str, int]) -> Optional[Path]:
    if not src_dir.exists() or not src_dir.is_dir():
        return None
    for src_file in src_dir.rglob("*"):
        if not src_file.is_file():
            continue
        rel = src_file.relative_to(src_dir)
        dst_file = dst_dir / rel
        _merge_file(src_file, dst_file, file_stats)
    # cleanup empty directories if possible
    for d in sorted(src_dir.rglob("*"), reverse=True):
        if d.is_dir():
            try:
                d.rmdir()
            except OSError:
                pass
    try:
        src_dir.rmdir()
    except OSError:
        pass
    return dst_dir


def _promote_paths_for_paper(
    sessions_root: Path,
    global_cache_root: Path,
    session_id: str,
    paper_id: str,
    row: sqlite3.Row,
    file_stats: Dict[str, int],
) -> Dict[str, Optional[str]]:
    """Move legacy per-session files into global single-copy layout."""
    session_root = sessions_root / session_id
    global_cache_root.mkdir(parents=True, exist_ok=True)

    src_pdf = _as_path(row["pdf_path"])
    if src_pdf is None:
        fallback_pdf = session_root / "downloads" / f"{paper_id}.pdf"
        src_pdf = fallback_pdf if fallback_pdf.exists() else None
    dst_pdf = global_cache_root / "downloads" / f"{paper_id}.pdf"
    moved_pdf = _merge_file(src_pdf, dst_pdf, file_stats) if src_pdf else (dst_pdf if dst_pdf.exists() else None)

    src_md = _as_path(row["canonical_md_path"])
    if src_md is None:
        fallback_md = session_root / "md" / f"{paper_id}.md"
        src_md = fallback_md if fallback_md.exists() else None
    dst_md = global_cache_root / "md" / f"{paper_id}.md"
    moved_md = _merge_file(src_md, dst_md, file_stats) if src_md else (dst_md if dst_md.exists() else None)

    src_report_pdf = _as_path(row["report_pdf_path"])
    dst_report_pdf = global_cache_root / "reports" / f"{paper_id}.pdf"
    moved_report_pdf = None
    if src_report_pdf:
        moved_report_pdf = _merge_file(src_report_pdf, dst_report_pdf, file_stats)
    elif dst_report_pdf.exists():
        moved_report_pdf = dst_report_pdf

    src_images_dir = _as_path(row["images_dir"])
    dst_images_dir = global_cache_root / "extracted" / paper_id / "images"
    moved_images_dir = None
    if src_images_dir:
        if src_images_dir.is_file():
            moved = _merge_file(src_images_dir, dst_images_dir / src_images_dir.name, file_stats)
            moved_images_dir = str(moved.parent) if moved else None
        else:
            moved = _merge_tree(src_images_dir, dst_images_dir, file_stats)
            moved_images_dir = str(moved) if moved else None
    elif dst_images_dir.exists():
        moved_images_dir = str(dst_images_dir)

    local_path = _as_path(row["local_path"])
    if local_path and str(local_path).startswith(str(session_root)) and moved_pdf:
        normalized_local = str(moved_pdf)
    else:
        normalized_local = str(local_path) if local_path else None

    return {
        "pdf_path": str(moved_pdf) if moved_pdf else None,
        "canonical_md_path": str(moved_md) if moved_md else None,
        "report_pdf_path": str(moved_report_pdf) if moved_report_pdf else None,
        "images_dir": moved_images_dir,
        "local_path": normalized_local,
    }


async def _ensure_schema(conn: asyncpg.Connection) -> None:
    await conn.execute(
        """
        CREATE TABLE IF NOT EXISTS sessions (
            session_id UUID PRIMARY KEY,
            title VARCHAR(255) DEFAULT 'New chat',
            storage_mode VARCHAR(20) DEFAULT 'legacy',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS messages (
            message_id SERIAL PRIMARY KEY,
            session_id UUID NOT NULL,
            role VARCHAR(20) NOT NULL,
            content TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CONSTRAINT fk_session FOREIGN KEY(session_id)
                REFERENCES sessions(session_id)
                ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages (session_id);

        CREATE TABLE IF NOT EXISTS paper_records_global (
            paper_id TEXT PRIMARY KEY,
            source_url TEXT,
            local_path TEXT,
            title TEXT,
            authors JSONB,
            pdf_path TEXT,
            images_dir TEXT,
            extracted_text TEXT,
            canonical_md_path TEXT,
            report_md TEXT,
            report_pdf_path TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            status TEXT NOT NULL DEFAULT 'pending'
        );
        CREATE TABLE IF NOT EXISTS authorized_paper_refs (
            session_id UUID NOT NULL,
            ref TEXT NOT NULL,
            source TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (session_id, ref),
            CONSTRAINT fk_auth_paper_session FOREIGN KEY(session_id)
                REFERENCES sessions(session_id)
                ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS session_paper_links (
            session_id UUID NOT NULL,
            paper_id TEXT NOT NULL,
            source_ref TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            last_access_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (session_id, paper_id),
            CONSTRAINT fk_session_paper_links_session FOREIGN KEY(session_id)
                REFERENCES sessions(session_id)
                ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_session_paper_links_session_last_access
            ON session_paper_links (session_id, last_access_at DESC);
        CREATE INDEX IF NOT EXISTS idx_session_paper_links_paper
            ON session_paper_links (paper_id);

        CREATE TABLE IF NOT EXISTS paper_cache_global (
            cache_key TEXT PRIMARY KEY,
            func_name TEXT NOT NULL,
            data TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            expires_at TIMESTAMPTZ NOT NULL
        );
        """
    )


async def migrate_sessions(
    conn: asyncpg.Connection,
    sessions_db: Path,
    errors: List[Dict[str, str]],
) -> Dict[str, int]:
    stats = {"sessions": 0, "messages": 0}
    if not sessions_db.exists():
        return stats

    sconn = sqlite3.connect(str(sessions_db))
    sconn.row_factory = sqlite3.Row
    rows = sconn.execute(
        "SELECT session_id, title, messages, created_at, updated_at FROM sessions"
    ).fetchall()

    for row in rows:
        sid = row["session_id"]
        try:
            created_at = _parse_dt(row["created_at"], _now())
            updated_at = _parse_dt(row["updated_at"], created_at)
            await conn.execute(
                """
                INSERT INTO sessions (session_id, title, storage_mode, created_at, updated_at)
                VALUES ($1::uuid, $2, 'sandboxed', $3, $4)
                ON CONFLICT (session_id) DO UPDATE
                SET title = EXCLUDED.title,
                    updated_at = EXCLUDED.updated_at
                """,
                sid,
                row["title"] or "New chat",
                created_at,
                updated_at,
            )
            stats["sessions"] += 1

            raw_messages = row["messages"] or "[]"
            messages = json.loads(raw_messages)
            for idx, m in enumerate(messages):
                created_msg = created_at + timedelta(milliseconds=idx)
                await conn.execute(
                    """
                    INSERT INTO messages (session_id, role, content, created_at)
                    VALUES ($1::uuid, $2, $3, $4)
                    """,
                    sid,
                    str(m.get("role", "assistant")),
                    str(m.get("content", "")),
                    created_msg,
                )
                stats["messages"] += 1
        except Exception as exc:
            errors.append(
                {
                    "session_id": sid,
                    "table": "sessions/messages",
                    "key": sid,
                    "error": str(exc),
                }
            )

    sconn.close()
    return stats


async def migrate_papers(
    conn: asyncpg.Connection,
    sessions_root: Path,
    global_cache_root: Path,
    errors: List[Dict[str, str]],
) -> Dict[str, object]:
    stats: Dict[str, object] = {
        "paper_records": 0,
        "authorized_refs": 0,
        "paper_cache": 0,
        "linked_papers_total": 0,
        "linked_papers_by_session": {},
        "file_stats": {
            "moved_files": 0,
            "replaced_files": 0,
            "deduped_files": 0,
        },
    }
    if not sessions_root.exists():
        return stats

    linked_by_session: Dict[str, int] = {}

    for db_path in sessions_root.glob("*/papers.db"):
        sid = db_path.parent.name
        try:
            await conn.execute(
                """
                INSERT INTO sessions (session_id, title, storage_mode)
                VALUES ($1::uuid, 'Migrated session', 'sandboxed')
                ON CONFLICT (session_id) DO NOTHING
                """,
                sid,
            )
        except Exception as exc:
            errors.append(
                {
                    "session_id": sid,
                    "table": "sessions",
                    "key": sid,
                    "error": str(exc),
                }
            )
            continue

        sconn = sqlite3.connect(str(db_path))
        sconn.row_factory = sqlite3.Row

        try:
            paper_rows = sconn.execute("SELECT * FROM papers").fetchall()
            for row in paper_rows:
                paper_id = row["paper_id"]
                promoted = _promote_paths_for_paper(
                    sessions_root=sessions_root,
                    global_cache_root=global_cache_root,
                    session_id=sid,
                    paper_id=paper_id,
                    row=row,
                    file_stats=stats["file_stats"],
                )

                authors = row["authors"]
                try:
                    authors_json = json.loads(authors) if authors else None
                except json.JSONDecodeError:
                    authors_json = [authors]

                await conn.execute(
                    """
                    INSERT INTO paper_records_global (
                        paper_id, source_url, local_path, title, authors,
                        pdf_path, images_dir, extracted_text, canonical_md_path,
                        report_md, report_pdf_path, created_at, updated_at, status
                    ) VALUES (
                        $1, $2, $3, $4, $5::jsonb,
                        $6, $7, $8, $9,
                        $10, $11, $12::timestamptz, $13::timestamptz, $14
                    )
                    ON CONFLICT (paper_id) DO UPDATE SET
                        source_url = EXCLUDED.source_url,
                        local_path = EXCLUDED.local_path,
                        title = EXCLUDED.title,
                        authors = EXCLUDED.authors,
                        pdf_path = COALESCE(EXCLUDED.pdf_path, paper_records_global.pdf_path),
                        images_dir = COALESCE(EXCLUDED.images_dir, paper_records_global.images_dir),
                        extracted_text = EXCLUDED.extracted_text,
                        canonical_md_path = COALESCE(EXCLUDED.canonical_md_path, paper_records_global.canonical_md_path),
                        report_md = EXCLUDED.report_md,
                        report_pdf_path = COALESCE(EXCLUDED.report_pdf_path, paper_records_global.report_pdf_path),
                        updated_at = EXCLUDED.updated_at,
                        status = EXCLUDED.status
                    """,
                    paper_id,
                    row["source_url"],
                    promoted["local_path"],
                    row["title"],
                    json.dumps(authors_json, ensure_ascii=False) if authors_json is not None else None,
                    promoted["pdf_path"],
                    promoted["images_dir"],
                    row["extracted_text"],
                    promoted["canonical_md_path"],
                    row["report_md"],
                    promoted["report_pdf_path"],
                    _parse_dt(row["created_at"], _now()),
                    _parse_dt(row["updated_at"], _now()),
                    row["status"] or "pending",
                )
                stats["paper_records"] += 1

                source_ref = row["source_url"] or row["local_path"]
                await conn.execute(
                    """
                    INSERT INTO session_paper_links (session_id, paper_id, source_ref, created_at, last_access_at)
                    VALUES ($1::uuid, $2, $3, NOW(), NOW())
                    ON CONFLICT (session_id, paper_id)
                    DO UPDATE SET
                        source_ref = COALESCE(EXCLUDED.source_ref, session_paper_links.source_ref),
                        last_access_at = NOW()
                    """,
                    sid,
                    paper_id,
                    source_ref,
                )
                linked_by_session[sid] = linked_by_session.get(sid, 0) + 1
                stats["linked_papers_total"] += 1
        except Exception as exc:
            errors.append(
                {
                    "session_id": sid,
                    "table": "paper_records_global/session_paper_links",
                    "key": str(db_path),
                    "error": str(exc),
                }
            )

        try:
            auth_rows = sconn.execute("SELECT ref, source, created_at FROM authorized_papers").fetchall()
            for row in auth_rows:
                ref = row["ref"]
                await conn.execute(
                    """
                    INSERT INTO authorized_paper_refs (session_id, ref, source, created_at)
                    VALUES ($1::uuid, $2, $3, $4)
                    ON CONFLICT (session_id, ref)
                    DO UPDATE SET source = EXCLUDED.source, created_at = EXCLUDED.created_at
                    """,
                    sid,
                    ref,
                    row["source"],
                    _parse_dt(row["created_at"], _now()),
                )
                stats["authorized_refs"] += 1

                pid = _canonical_paper_id_from_ref(ref)
                if pid:
                    await conn.execute(
                        """
                        INSERT INTO session_paper_links (session_id, paper_id, source_ref, created_at, last_access_at)
                        VALUES ($1::uuid, $2, $3, NOW(), NOW())
                        ON CONFLICT (session_id, paper_id)
                        DO UPDATE SET
                            source_ref = COALESCE(EXCLUDED.source_ref, session_paper_links.source_ref),
                            last_access_at = NOW()
                        """,
                        sid,
                        pid,
                        ref,
                    )
                    linked_by_session[sid] = linked_by_session.get(sid, 0) + 1
                    stats["linked_papers_total"] += 1
        except Exception as exc:
            errors.append(
                {
                    "session_id": sid,
                    "table": "authorized_paper_refs",
                    "key": str(db_path),
                    "error": str(exc),
                }
            )

        try:
            cache_rows = sconn.execute(
                "SELECT cache_key, func_name, data, created_at, expires_at FROM cache"
            ).fetchall()
            for row in cache_rows:
                await conn.execute(
                    """
                    INSERT INTO paper_cache_global (cache_key, func_name, data, created_at, expires_at)
                    VALUES ($1, $2, $3, $4, $5)
                    ON CONFLICT (cache_key)
                    DO UPDATE SET
                        func_name = EXCLUDED.func_name,
                        data = EXCLUDED.data,
                        created_at = EXCLUDED.created_at,
                        expires_at = EXCLUDED.expires_at
                    """,
                    row["cache_key"],
                    row["func_name"] or "unknown",
                    row["data"] or "",
                    _parse_dt(row["created_at"], _now()),
                    _parse_dt(row["expires_at"], _now()),
                )
                stats["paper_cache"] += 1
        except Exception as exc:
            errors.append(
                {
                    "session_id": sid,
                    "table": "paper_cache_global",
                    "key": str(db_path),
                    "error": str(exc),
                }
            )

        sconn.close()

    stats["linked_papers_by_session"] = linked_by_session
    return stats


async def validate_counts(conn: asyncpg.Connection) -> Dict[str, int]:
    sessions = await conn.fetchval("SELECT COUNT(*) FROM sessions")
    messages = await conn.fetchval("SELECT COUNT(*) FROM messages")
    papers = await conn.fetchval("SELECT COUNT(*) FROM paper_records_global")
    auth = await conn.fetchval("SELECT COUNT(*) FROM authorized_paper_refs")
    links = await conn.fetchval("SELECT COUNT(*) FROM session_paper_links")
    cache = await conn.fetchval("SELECT COUNT(*) FROM paper_cache_global")
    return {
        "sessions": int(sessions),
        "messages": int(messages),
        "paper_records": int(papers),
        "authorized_paper_refs": int(auth),
        "session_paper_links": int(links),
        "paper_cache": int(cache),
    }


async def main() -> None:
    parser = argparse.ArgumentParser(description="Migrate legacy SQLite data to PostgreSQL")
    parser.add_argument("--database-url", default=os.getenv("DATABASE_URL"))
    parser.add_argument("--sessions-db", default="papers/sessions.db")
    parser.add_argument("--sessions-root", default="papers/sessions")
    parser.add_argument("--global-cache-root", default="papers/cache")
    parser.add_argument("--error-csv", default="migration_errors.csv")
    args = parser.parse_args()

    if not args.database_url:
        raise RuntimeError("DATABASE_URL is required")

    errors: List[Dict[str, str]] = []
    conn = await asyncpg.connect(dsn=args.database_url)
    try:
        await _ensure_schema(conn)
        session_stats = await migrate_sessions(conn, Path(args.sessions_db), errors)
        paper_stats = await migrate_papers(
            conn,
            sessions_root=Path(args.sessions_root),
            global_cache_root=Path(args.global_cache_root),
            errors=errors,
        )
        counts = await validate_counts(conn)
    finally:
        await conn.close()

    print("[migrate] sessions:", session_stats)
    print("[migrate] papers:", paper_stats)
    print("[migrate] linked_papers_by_session:", paper_stats.get("linked_papers_by_session", {}))
    print("[pg-counts]:", counts)

    if errors:
        with open(args.error_csv, "w", encoding="utf-8", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=["session_id", "table", "key", "error"])
            writer.writeheader()
            writer.writerows(errors)
        print(f"[migrate] errors written to {args.error_csv}: {len(errors)}")


if __name__ == "__main__":
    import asyncio

    asyncio.run(main())
