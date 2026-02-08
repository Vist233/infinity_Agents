"""
Session Database - SQLite storage for chatbot conversation history.

Stores user sessions and message history for context management.
"""

import json
import sqlite3
import uuid
from pathlib import Path
from datetime import datetime
from typing import Optional, List, Dict, Any
from dataclasses import dataclass, asdict, field


# Default database path
DEFAULT_DB_PATH = Path(__file__).parent.parent / "papers" / "sessions.db"


@dataclass
class SessionRecord:
    """Record of a user session."""
    user_id: str
    session_id: str
    title: Optional[str] = None
    messages: List[Dict] = field(default_factory=list)  # Stored as JSON
    paper_ids: List[str] = field(default_factory=list)  # Papers analyzed in this session
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


class SessionDatabase:
    """SQLite database for managing chat sessions and conversation history."""
    
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
            # Conversations table
            conn.execute("""
                CREATE TABLE IF NOT EXISTS sessions (
                    session_id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL,
                    title TEXT,
                    messages TEXT,
                    paper_ids TEXT,
                    created_at TEXT,
                    updated_at TEXT
                )
            """)
            conn.execute("""
                CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)
            """)
            conn.execute("""
                CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at)
            """)
            conn.commit()
    
    def create_session(self, user_id: str, title: Optional[str] = None) -> str:
        """Create a new session and return its ID."""
        session_id = uuid.uuid4().hex
        now = datetime.utcnow().isoformat()
        
        record = SessionRecord(
            user_id=user_id,
            session_id=session_id,
            title=title,
            messages=[],
            paper_ids=[],
            created_at=now,
            updated_at=now,
        )
        
        with self._get_connection() as conn:
            conn.execute("""
                INSERT INTO sessions (session_id, user_id, title, messages, paper_ids, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            """, (
                record.session_id,
                record.user_id,
                record.title,
                json.dumps(record.messages),
                json.dumps(record.paper_ids),
                record.created_at,
                record.updated_at,
            ))
            conn.commit()
        
        return session_id
    
    def get_session(self, user_id: str, session_id: str) -> Optional[SessionRecord]:
        """Get a session by user_id and session_id."""
        with self._get_connection() as conn:
            row = conn.execute(
                "SELECT * FROM sessions WHERE user_id = ? AND session_id = ?",
                (user_id, session_id)
            ).fetchone()
            
            if row:
                return SessionRecord(
                    user_id=row["user_id"],
                    session_id=row["session_id"],
                    title=row["title"],
                    messages=json.loads(row["messages"] or "[]"),
                    paper_ids=json.loads(row["paper_ids"] or "[]"),
                    created_at=row["created_at"],
                    updated_at=row["updated_at"],
                )
        return None
    
    def save_messages(
        self,
        user_id: str,
        session_id: str,
        messages: List[Dict],
        title: Optional[str] = None,
    ) -> None:
        """Save messages to a session."""
        now = datetime.utcnow().isoformat()
        
        with self._get_connection() as conn:
            if title:
                conn.execute("""
                    UPDATE sessions 
                    SET messages = ?, title = ?, updated_at = ?
                    WHERE user_id = ? AND session_id = ?
                """, (json.dumps(messages), title, now, user_id, session_id))
            else:
                conn.execute("""
                    UPDATE sessions 
                    SET messages = ?, updated_at = ?
                    WHERE user_id = ? AND session_id = ?
                """, (json.dumps(messages), now, user_id, session_id))
            conn.commit()
    
    def add_paper_id(self, user_id: str, session_id: str, paper_id: str) -> None:
        """Add a paper ID to the session's paper list."""
        session = self.get_session(user_id, session_id)
        if session:
            if paper_id not in session.paper_ids:
                session.paper_ids.append(paper_id)
            
            with self._get_connection() as conn:
                conn.execute("""
                    UPDATE sessions 
                    SET paper_ids = ?, updated_at = ?
                    WHERE user_id = ? AND session_id = ?
                """, (
                    json.dumps(session.paper_ids),
                    datetime.utcnow().isoformat(),
                    user_id,
                    session_id,
                ))
                conn.commit()
    
    def list_sessions(self, user_id: str, limit: int = 20) -> List[SessionRecord]:
        """List sessions for a user, ordered by last update."""
        with self._get_connection() as conn:
            rows = conn.execute("""
                SELECT * FROM sessions 
                WHERE user_id = ?
                ORDER BY updated_at DESC
                LIMIT ?
            """, (user_id, limit)).fetchall()
            
            return [
                SessionRecord(
                    user_id=row["user_id"],
                    session_id=row["session_id"],
                    title=row["title"],
                    messages=json.loads(row["messages"] or "[]"),
                    paper_ids=json.loads(row["paper_ids"] or "[]"),
                    created_at=row["created_at"],
                    updated_at=row["updated_at"],
                )
                for row in rows
            ]
    
    def delete_session(self, user_id: str, session_id: str) -> bool:
        """Delete a session."""
        with self._get_connection() as conn:
            cursor = conn.execute(
                "DELETE FROM sessions WHERE user_id = ? AND session_id = ?",
                (user_id, session_id)
            )
            conn.commit()
            return cursor.rowcount > 0
    
    def get_recent_messages(
        self,
        user_id: str,
        session_id: str,
        max_messages: int = 20,
    ) -> List[Dict]:
        """Get the most recent messages from a session for context building."""
        session = self.get_session(user_id, session_id)
        if session:
            return session.messages[-max_messages:]
        return []
