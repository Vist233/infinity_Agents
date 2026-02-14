"""
Papers Database - SQLite cache for paper processing results.

Stores paper metadata, extracted content, and generated reports.
Designed for future migration to PostgreSQL.
"""

import sqlite3
import json
from pathlib import Path
from datetime import datetime
from typing import Optional, Dict, Any, List
from dataclasses import dataclass, asdict


# Default database path
DEFAULT_DB_PATH = Path(__file__).parent.parent / "papers" / "papers.db"


@dataclass
class PaperRecord:
    """Record of a processed paper."""
    paper_id: str  # Unique identifier (arXiv ID or hash of URL/path)
    source_url: Optional[str] = None
    local_path: Optional[str] = None
    title: Optional[str] = None
    authors: Optional[str] = None  # JSON list
    pdf_path: Optional[str] = None
    images_dir: Optional[str] = None
    extracted_text: Optional[str] = None
    canonical_md_path: Optional[str] = None
    report_md: Optional[str] = None
    report_pdf_path: Optional[str] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None
    status: str = "pending"  # pending, processing, completed, failed


class PapersDatabase:
    """SQLite database for caching paper processing results."""
    
    def __init__(self, db_path: Optional[Path] = None):
        self.db_path = db_path or DEFAULT_DB_PATH
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_db()
    
    def _get_connection(self) -> sqlite3.Connection:
        """Get a database connection."""
        conn = sqlite3.connect(str(self.db_path))
        conn.row_factory = sqlite3.Row
        return conn
    
    def _init_db(self) -> None:
        """Initialize database tables."""
        with self._get_connection() as conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS papers (
                    paper_id TEXT PRIMARY KEY,
                    source_url TEXT,
                    local_path TEXT,
                    title TEXT,
                    authors TEXT,
                    pdf_path TEXT,
                    images_dir TEXT,
                    extracted_text TEXT,
                    canonical_md_path TEXT,
                    report_md TEXT,
                    report_pdf_path TEXT,
                    created_at TEXT,
                    updated_at TEXT,
                    status TEXT DEFAULT 'pending'
                )
            """)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS authorized_papers (
                    ref TEXT PRIMARY KEY,
                    source TEXT,
                    created_at TEXT
                )
            """)
            conn.execute("""
                CREATE INDEX IF NOT EXISTS idx_papers_url ON papers(source_url)
            """)
            conn.execute("""
                CREATE INDEX IF NOT EXISTS idx_papers_path ON papers(local_path)
            """)
            conn.commit()
    
    def get_by_id(self, paper_id: str) -> Optional[PaperRecord]:
        """Get paper by ID."""
        with self._get_connection() as conn:
            row = conn.execute(
                "SELECT * FROM papers WHERE paper_id = ?",
                (paper_id,)
            ).fetchone()
            if row:
                return PaperRecord(**dict(row))
        return None
    
    def get_by_url(self, url: str) -> Optional[PaperRecord]:
        """Get paper by source URL."""
        with self._get_connection() as conn:
            row = conn.execute(
                "SELECT * FROM papers WHERE source_url = ?",
                (url,)
            ).fetchone()
            if row:
                return PaperRecord(**dict(row))
        return None
    
    def get_by_local_path(self, path: str) -> Optional[PaperRecord]:
        """Get paper by local path."""
        with self._get_connection() as conn:
            row = conn.execute(
                "SELECT * FROM papers WHERE local_path = ?",
                (path,)
            ).fetchone()
            if row:
                return PaperRecord(**dict(row))
        return None
    
    def get_completed(self, paper_id: str) -> Optional[PaperRecord]:
        """Get completed paper with report."""
        record = self.get_by_id(paper_id)
        if record and record.status == "completed" and record.report_md:
            return record
        return None
    
    def upsert(self, record: PaperRecord) -> None:
        """Insert or update a paper record."""
        now = datetime.utcnow().isoformat()
        record.updated_at = now
        if not record.created_at:
            record.created_at = now
        
        data = asdict(record)
        columns = ", ".join(data.keys())
        placeholders = ", ".join(["?" for _ in data])
        updates = ", ".join([f"{k} = excluded.{k}" for k in data.keys() if k != "paper_id"])
        
        with self._get_connection() as conn:
            conn.execute(f"""
                INSERT INTO papers ({columns})
                VALUES ({placeholders})
                ON CONFLICT(paper_id) DO UPDATE SET {updates}
            """, list(data.values()))
            conn.commit()
    
    def update_status(self, paper_id: str, status: str) -> None:
        """Update paper processing status."""
        with self._get_connection() as conn:
            conn.execute(
                "UPDATE papers SET status = ?, updated_at = ? WHERE paper_id = ?",
                (status, datetime.utcnow().isoformat(), paper_id)
            )
            conn.commit()
    
    def save_extracted_content(
        self,
        paper_id: str,
        text: str,
        images_dir: str,
        canonical_md_path: Optional[str] = None,
    ) -> None:
        """Save extracted PDF content."""
        with self._get_connection() as conn:
            conn.execute("""
                UPDATE papers 
                SET extracted_text = ?, images_dir = ?, canonical_md_path = ?, updated_at = ?
                WHERE paper_id = ?
            """, (text, images_dir, canonical_md_path, datetime.utcnow().isoformat(), paper_id))
            conn.commit()

    def register_authorized_refs(self, refs: List[str], source: str = "search_paper") -> None:
        """Persist paper references that are authorized for this session."""
        now = datetime.utcnow().isoformat()
        normalized = [r.strip() for r in refs if isinstance(r, str) and r.strip()]
        if not normalized:
            return
        with self._get_connection() as conn:
            conn.executemany(
                """
                INSERT OR REPLACE INTO authorized_papers (ref, source, created_at)
                VALUES (?, ?, ?)
                """,
                [(r, source, now) for r in normalized],
            )
            conn.commit()

    def is_authorized_ref(self, ref: str) -> bool:
        """Check if a paper reference is authorized in this session."""
        if not ref:
            return False
        with self._get_connection() as conn:
            row = conn.execute(
                "SELECT ref FROM authorized_papers WHERE ref = ?",
                (ref.strip(),),
            ).fetchone()
            return row is not None
    
    def save_report(
        self,
        paper_id: str,
        report_md: str,
        report_pdf_path: Optional[str] = None,
    ) -> None:
        """Save generated report."""
        with self._get_connection() as conn:
            conn.execute("""
                UPDATE papers 
                SET report_md = ?, report_pdf_path = ?, status = 'completed', updated_at = ?
                WHERE paper_id = ?
            """, (report_md, report_pdf_path, datetime.utcnow().isoformat(), paper_id))
            conn.commit()
    
    def list_papers(self, status: Optional[str] = None, limit: int = 100) -> List[PaperRecord]:
        """List papers, optionally filtered by status."""
        with self._get_connection() as conn:
            if status:
                rows = conn.execute(
                    "SELECT * FROM papers WHERE status = ? ORDER BY updated_at DESC LIMIT ?",
                    (status, limit)
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT * FROM papers ORDER BY updated_at DESC LIMIT ?",
                    (limit,)
                ).fetchall()
            return [PaperRecord(**dict(row)) for row in rows]
    
    def delete(self, paper_id: str) -> bool:
        """Delete a paper record."""
        with self._get_connection() as conn:
            cursor = conn.execute(
                "DELETE FROM papers WHERE paper_id = ?",
                (paper_id,)
            )
            conn.commit()
            return cursor.rowcount > 0
