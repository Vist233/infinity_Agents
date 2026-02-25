"""PostgreSQL-backed paper repository with global cache + session authorization mapping."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from typing import Any, Dict, List, Optional

from agent.pg_sync import exec_sync, fetch_sync, fetchrow_sync, get_database_url


@dataclass
class PaperRecord:
    paper_id: str
    source_url: Optional[str] = None
    local_path: Optional[str] = None
    title: Optional[str] = None
    authors: Optional[str] = None
    pdf_path: Optional[str] = None
    images_dir: Optional[str] = None
    extracted_text: Optional[str] = None
    canonical_md_path: Optional[str] = None
    report_md: Optional[str] = None
    report_pdf_path: Optional[str] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None
    status: str = "pending"


class PapersRepoPG:
    """
    Repository strategy:
    - Global cache tables: paper_records_global, paper_cache_global
    - Session isolation tables:
      - authorized_paper_refs(session_id, ref)
      - session_paper_links(session_id, paper_id)
    """

    def __init__(self, session_id: str, database_url: Optional[str] = None):
        if not session_id:
            raise ValueError("session_id is required for PapersRepoPG")
        self.session_id = session_id
        self.database_url = get_database_url(database_url)
        self._ensure_schema()
        self._ensure_session_row()

    def _ensure_schema(self) -> None:
        exec_sync(
            self.database_url,
            """
            CREATE TABLE IF NOT EXISTS sessions (
                session_id UUID PRIMARY KEY,
                title VARCHAR(255) DEFAULT 'New chat',
                storage_mode VARCHAR(20) DEFAULT 'legacy',
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
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
            CREATE TABLE IF NOT EXISTS paper_cache_global (
                cache_key TEXT PRIMARY KEY,
                func_name TEXT NOT NULL,
                data TEXT NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                expires_at TIMESTAMPTZ NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_paper_records_global_updated
                ON paper_records_global (updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_paper_records_global_source_url
                ON paper_records_global (source_url);
            CREATE INDEX IF NOT EXISTS idx_paper_records_global_local_path
                ON paper_records_global (local_path);
            CREATE INDEX IF NOT EXISTS idx_authorized_paper_refs_session_ref
                ON authorized_paper_refs (session_id, ref);
            CREATE INDEX IF NOT EXISTS idx_session_paper_links_session_last_access
                ON session_paper_links (session_id, last_access_at DESC);
            CREATE INDEX IF NOT EXISTS idx_session_paper_links_paper
                ON session_paper_links (paper_id);
            CREATE INDEX IF NOT EXISTS idx_paper_cache_global_expires
                ON paper_cache_global (expires_at);
            """,
        )

    def _ensure_session_row(self) -> None:
        exec_sync(
            self.database_url,
            """
            INSERT INTO sessions (session_id, title, storage_mode)
            VALUES ($1::uuid, $2, $3)
            ON CONFLICT (session_id) DO NOTHING
            """,
            self.session_id,
            "Agent Session",
            "sandboxed",
        )

    def _to_record(self, row: Any) -> Optional[PaperRecord]:
        if row is None:
            return None
        authors = row["authors"]
        if isinstance(authors, (dict, list)):
            authors = json.dumps(authors, ensure_ascii=False)
        return PaperRecord(
            paper_id=row["paper_id"],
            source_url=row["source_url"],
            local_path=row["local_path"],
            title=row["title"],
            authors=authors,
            pdf_path=row["pdf_path"],
            images_dir=row["images_dir"],
            extracted_text=row["extracted_text"],
            canonical_md_path=row["canonical_md_path"],
            report_md=row["report_md"],
            report_pdf_path=row["report_pdf_path"],
            created_at=row["created_at"].isoformat() if row["created_at"] else None,
            updated_at=row["updated_at"].isoformat() if row["updated_at"] else None,
            status=row["status"],
        )

    def _authors_json(self, authors: Optional[str]) -> Any:
        if not authors:
            return None
        try:
            return json.loads(authors)
        except json.JSONDecodeError:
            return [authors]

    def _coerce_timestamptz(self, value: Any, fallback: datetime) -> datetime:
        """Convert flexible timestamp inputs to timezone-aware datetime for asyncpg."""
        if value is None:
            return fallback
        if isinstance(value, datetime):
            return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)
        if isinstance(value, date):
            return datetime(value.year, value.month, value.day, tzinfo=timezone.utc)
        if isinstance(value, (int, float)):
            try:
                return datetime.fromtimestamp(float(value), tz=timezone.utc)
            except (OverflowError, OSError, ValueError):
                return fallback
        if isinstance(value, str):
            raw = value.strip()
            if not raw:
                return fallback
            # Numeric timestamp string.
            try:
                if raw.isdigit() or re.match(r"^-?\d+(\.\d+)?$", raw):
                    return datetime.fromtimestamp(float(raw), tz=timezone.utc)
            except Exception:
                pass
            # fromisoformat does not accept trailing 'Z' directly.
            if raw.endswith("Z"):
                raw = raw[:-1] + "+00:00"
            # Normalize timezone offset like +0800 -> +08:00 for broader ISO compatibility.
            if re.match(r".*[+-]\d{4}$", raw):
                raw = raw[:-5] + raw[-5:-2] + ":" + raw[-2:]
            try:
                dt = datetime.fromisoformat(raw)
                return dt if dt.tzinfo is not None else dt.replace(tzinfo=timezone.utc)
            except ValueError:
                pass
            try:
                dt = parsedate_to_datetime(raw)
                if dt is not None:
                    return dt if dt.tzinfo is not None else dt.replace(tzinfo=timezone.utc)
            except (TypeError, ValueError):
                pass
            for fmt in (
                "%Y-%m-%d %H:%M:%S.%f",
                "%Y-%m-%d %H:%M:%S",
                "%Y/%m/%d %H:%M:%S",
                "%Y-%m-%dT%H:%M:%S.%f",
                "%Y-%m-%dT%H:%M:%S",
                "%Y%m%dT%H%M%SZ",
                "%Y-%m-%d",
                "%Y/%m/%d",
                "%Y%m%d",
                "%Y-%b",
                "%Y-%B",
            ):
                try:
                    dt = datetime.strptime(raw, fmt)
                    return dt.replace(tzinfo=timezone.utc)
                except ValueError:
                    continue
            return fallback
        return fallback

    def get_by_id(self, paper_id: str) -> Optional[PaperRecord]:
        row = fetchrow_sync(
            self.database_url,
            "SELECT * FROM paper_records_global WHERE paper_id = $1",
            paper_id,
        )
        return self._to_record(row)

    def get_by_url(self, url: str) -> Optional[PaperRecord]:
        row = fetchrow_sync(
            self.database_url,
            "SELECT * FROM paper_records_global WHERE source_url = $1 LIMIT 1",
            url,
        )
        return self._to_record(row)

    def get_by_local_path(self, path: str) -> Optional[PaperRecord]:
        row = fetchrow_sync(
            self.database_url,
            "SELECT * FROM paper_records_global WHERE local_path = $1 LIMIT 1",
            path,
        )
        return self._to_record(row)

    def get_completed(self, paper_id: str) -> Optional[PaperRecord]:
        record = self.get_by_id(paper_id)
        if record and record.status == "completed" and record.report_md:
            return record
        return None

    def upsert(self, record: PaperRecord) -> None:
        now = datetime.now(tz=timezone.utc)
        created_at = self._coerce_timestamptz(record.created_at, fallback=now)
        updated_at = self._coerce_timestamptz(record.updated_at, fallback=now)
        exec_sync(
            self.database_url,
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
            ON CONFLICT (paper_id)
            DO UPDATE SET
                source_url = EXCLUDED.source_url,
                local_path = EXCLUDED.local_path,
                title = EXCLUDED.title,
                authors = EXCLUDED.authors,
                pdf_path = EXCLUDED.pdf_path,
                images_dir = EXCLUDED.images_dir,
                extracted_text = EXCLUDED.extracted_text,
                canonical_md_path = EXCLUDED.canonical_md_path,
                report_md = EXCLUDED.report_md,
                report_pdf_path = EXCLUDED.report_pdf_path,
                updated_at = EXCLUDED.updated_at,
                status = EXCLUDED.status
            """,
            record.paper_id,
            record.source_url,
            record.local_path,
            record.title,
            json.dumps(self._authors_json(record.authors), ensure_ascii=False) if record.authors else None,
            record.pdf_path,
            record.images_dir,
            record.extracted_text,
            record.canonical_md_path,
            record.report_md,
            record.report_pdf_path,
            created_at,
            updated_at,
            record.status,
        )
        self.link_paper_to_session(
            self.session_id,
            record.paper_id,
            source_ref=record.source_url or record.local_path,
        )

    def update_status(self, paper_id: str, status: str) -> None:
        exec_sync(
            self.database_url,
            """
            UPDATE paper_records_global
            SET status = $2, updated_at = NOW()
            WHERE paper_id = $1
            """,
            paper_id,
            status,
        )

    def save_extracted_content(
        self,
        paper_id: str,
        text: str,
        images_dir: str,
        canonical_md_path: Optional[str] = None,
    ) -> None:
        exec_sync(
            self.database_url,
            """
            UPDATE paper_records_global
            SET extracted_text = $2,
                images_dir = $3,
                canonical_md_path = $4,
                updated_at = NOW()
            WHERE paper_id = $1
            """,
            paper_id,
            text,
            images_dir,
            canonical_md_path,
        )

    def register_authorized_refs(self, refs: List[str], source: str = "search_paper") -> None:
        now = datetime.now(tz=timezone.utc)
        normalized = [r.strip() for r in refs if isinstance(r, str) and r.strip()]
        for ref in normalized:
            exec_sync(
                self.database_url,
                """
                INSERT INTO authorized_paper_refs (session_id, ref, source, created_at)
                VALUES ($1::uuid, $2, $3, $4)
                ON CONFLICT (session_id, ref)
                DO UPDATE SET source = EXCLUDED.source, created_at = EXCLUDED.created_at
                """,
                self.session_id,
                ref,
                source,
                now,
            )

    def link_paper_to_session(
        self,
        session_id: str,
        paper_id: str,
        source_ref: Optional[str] = None,
    ) -> None:
        if not session_id or not paper_id:
            return
        exec_sync(
            self.database_url,
            """
            INSERT INTO session_paper_links (session_id, paper_id, source_ref, created_at, last_access_at)
            VALUES ($1::uuid, $2, $3, NOW(), NOW())
            ON CONFLICT (session_id, paper_id)
            DO UPDATE SET
                source_ref = COALESCE(EXCLUDED.source_ref, session_paper_links.source_ref),
                last_access_at = NOW()
            """,
            session_id,
            paper_id,
            source_ref,
        )

    def is_paper_linked_to_session(self, session_id: str, paper_id: str) -> bool:
        if not session_id or not paper_id:
            return False
        row = fetchrow_sync(
            self.database_url,
            """
            SELECT 1
            FROM session_paper_links
            WHERE session_id = $1::uuid AND paper_id = $2
            LIMIT 1
            """,
            session_id,
            paper_id,
        )
        return row is not None

    def list_session_papers(self, session_id: str) -> List[str]:
        if not session_id:
            return []
        rows = fetch_sync(
            self.database_url,
            """
            SELECT paper_id
            FROM session_paper_links
            WHERE session_id = $1::uuid
            ORDER BY last_access_at DESC
            """,
            session_id,
        )
        return [str(r["paper_id"]) for r in rows]

    def _paper_id_ref_candidates(self, paper_id: str) -> List[str]:
        return list({
            paper_id,
            paper_id.replace("_", ".", 1),
            paper_id.replace("_", "."),
        })

    def is_authorized_ref(self, ref: str, paper_id: Optional[str] = None) -> bool:
        if not ref:
            if not paper_id:
                return False
        if paper_id and self.is_paper_linked_to_session(self.session_id, paper_id):
            self.link_paper_to_session(self.session_id, paper_id, source_ref=ref or None)
            return True

        refs = []
        if isinstance(ref, str) and ref.strip():
            refs.append(ref.strip())
        if paper_id:
            refs.extend(self._paper_id_ref_candidates(paper_id))
        if not refs:
            return False

        row = fetchrow_sync(
            self.database_url,
            """
            SELECT ref
            FROM authorized_paper_refs
            WHERE session_id = $1::uuid AND ref = ANY($2::text[])
            LIMIT 1
            """,
            self.session_id,
            refs,
        )
        if row is not None and paper_id:
            self.link_paper_to_session(self.session_id, paper_id, source_ref=ref or row["ref"])
        return row is not None

    def save_report(self, paper_id: str, report_md: str, report_pdf_path: Optional[str] = None) -> None:
        exec_sync(
            self.database_url,
            """
            UPDATE paper_records_global
            SET report_md = $2,
                report_pdf_path = $3,
                status = 'completed',
                updated_at = NOW()
            WHERE paper_id = $1
            """,
            paper_id,
            report_md,
            report_pdf_path,
        )

    def list_papers(self, status: Optional[str] = None, limit: int = 100) -> List[PaperRecord]:
        if status:
            rows = fetch_sync(
                self.database_url,
                """
                SELECT * FROM paper_records_global
                WHERE status = $1
                ORDER BY updated_at DESC
                LIMIT $2
                """,
                status,
                limit,
            )
        else:
            rows = fetch_sync(
                self.database_url,
                """
                SELECT * FROM paper_records_global
                ORDER BY updated_at DESC
                LIMIT $1
                """,
                limit,
            )
        return [r for r in (self._to_record(row) for row in rows) if r is not None]

    def delete(self, paper_id: str) -> bool:
        result = exec_sync(
            self.database_url,
            "DELETE FROM paper_records_global WHERE paper_id = $1",
            paper_id,
        )
        parts = result.split(" ")
        return len(parts) == 2 and parts[0] == "DELETE" and int(parts[1]) > 0

    def get_cache(self, cache_key: str) -> Optional[Dict[str, Any]]:
        row = fetchrow_sync(
            self.database_url,
            """
            SELECT data, expires_at
            FROM paper_cache_global
            WHERE cache_key = $1
            LIMIT 1
            """,
            cache_key,
        )
        if row is None:
            return None
        return {
            "data": row["data"],
            "expires_at": row["expires_at"],
        }

    def set_cache(self, cache_key: str, func_name: str, data: str, ttl_seconds: int) -> None:
        now = datetime.now(tz=timezone.utc)
        expires_at = now + timedelta(seconds=ttl_seconds)
        exec_sync(
            self.database_url,
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
            cache_key,
            func_name,
            data,
            now,
            expires_at,
        )

    def delete_cache(self, cache_key: str) -> None:
        exec_sync(
            self.database_url,
            "DELETE FROM paper_cache_global WHERE cache_key = $1",
            cache_key,
        )
