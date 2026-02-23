"""PostgreSQL-backed session repository for PaperAgent CLI/runtime."""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from agent.pg_sync import exec_sync, fetch_sync, fetchrow_sync, get_database_url


@dataclass
class SessionRecord:
    user_id: str
    session_id: str
    title: Optional[str] = None
    messages: List[Dict[str, Any]] = field(default_factory=list)
    paper_ids: List[str] = field(default_factory=list)
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


class SessionRepoPG:
    """Session repository over PostgreSQL sessions/messages tables."""

    def __init__(self, database_url: Optional[str] = None):
        self.database_url = get_database_url(database_url)
        self._ensure_schema()

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
            CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions (updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages (session_id);
            """,
        )

    def create_session(
        self,
        user_id: str,
        title: Optional[str] = None,
        session_id: Optional[str] = None,
        storage_mode: str = "sandboxed",
    ) -> str:
        sid = session_id or str(uuid.uuid4())
        exec_sync(
            self.database_url,
            """
            INSERT INTO sessions (session_id, title, storage_mode)
            VALUES ($1::uuid, $2, $3)
            ON CONFLICT (session_id) DO UPDATE
            SET title = EXCLUDED.title,
                storage_mode = EXCLUDED.storage_mode,
                updated_at = NOW()
            """,
            sid,
            title or "新对话",
            storage_mode,
        )
        return sid

    def get_session(self, user_id: str, session_id: str) -> Optional[SessionRecord]:
        row = fetchrow_sync(
            self.database_url,
            """
            SELECT session_id, title, created_at, updated_at
            FROM sessions
            WHERE session_id = $1::uuid
            LIMIT 1
            """,
            session_id,
        )
        if row is None:
            return None

        msg_rows = fetch_sync(
            self.database_url,
            """
            SELECT role, content, created_at
            FROM messages
            WHERE session_id = $1::uuid
            ORDER BY created_at ASC, message_id ASC
            """,
            session_id,
        )
        messages = [
            {
                "role": r["role"],
                "content": r["content"],
                "created_at": r["created_at"].isoformat() if r["created_at"] else None,
            }
            for r in msg_rows
        ]
        return SessionRecord(
            user_id=user_id,
            session_id=str(row["session_id"]),
            title=row["title"],
            messages=messages,
            paper_ids=[],
            created_at=row["created_at"].isoformat() if row["created_at"] else None,
            updated_at=row["updated_at"].isoformat() if row["updated_at"] else None,
        )

    def save_messages(
        self,
        user_id: str,
        session_id: str,
        messages: List[Dict[str, Any]],
        title: Optional[str] = None,
    ) -> None:
        # Rewrite session transcript deterministically (CLI path).
        exec_sync(self.database_url, "DELETE FROM messages WHERE session_id = $1::uuid", session_id)

        base_time = datetime.now(tz=timezone.utc)
        for idx, m in enumerate(messages):
            created_at = base_time + timedelta(milliseconds=idx)
            exec_sync(
                self.database_url,
                """
                INSERT INTO messages (session_id, role, content, created_at)
                VALUES ($1::uuid, $2, $3, $4)
                """,
                session_id,
                str(m.get("role", "assistant")),
                str(m.get("content", "")),
                created_at,
            )

        if title:
            exec_sync(
                self.database_url,
                """
                UPDATE sessions SET title = $2, updated_at = NOW()
                WHERE session_id = $1::uuid
                """,
                session_id,
                title,
            )
        else:
            exec_sync(
                self.database_url,
                "UPDATE sessions SET updated_at = NOW() WHERE session_id = $1::uuid",
                session_id,
            )

    def add_paper_id(self, user_id: str, session_id: str, paper_id: str) -> None:
        # Maintained for API compatibility; paper linkage is tracked in
        # session_paper_links via PapersRepoPG.
        return None

    def list_sessions(self, user_id: str, limit: int = 20) -> List[SessionRecord]:
        rows = fetch_sync(
            self.database_url,
            """
            SELECT session_id, title, created_at, updated_at
            FROM sessions
            ORDER BY updated_at DESC
            LIMIT $1
            """,
            limit,
        )
        results: List[SessionRecord] = []
        for row in rows:
            session_id = str(row["session_id"])
            msg_rows = fetch_sync(
                self.database_url,
                """
                SELECT role, content, created_at
                FROM messages
                WHERE session_id = $1::uuid
                ORDER BY created_at ASC, message_id ASC
                """,
                session_id,
            )
            messages = [
                {
                    "role": r["role"],
                    "content": r["content"],
                    "created_at": r["created_at"].isoformat() if r["created_at"] else None,
                }
                for r in msg_rows
            ]
            results.append(
                SessionRecord(
                    user_id=user_id,
                    session_id=session_id,
                    title=row["title"],
                    messages=messages,
                    paper_ids=[],
                    created_at=row["created_at"].isoformat() if row["created_at"] else None,
                    updated_at=row["updated_at"].isoformat() if row["updated_at"] else None,
                )
            )
        return results

    def delete_session(self, user_id: str, session_id: str) -> bool:
        result = exec_sync(
            self.database_url,
            "DELETE FROM sessions WHERE session_id = $1::uuid",
            session_id,
        )
        parts = result.split(" ")
        return len(parts) == 2 and parts[0] == "DELETE" and int(parts[1]) > 0

    def get_recent_messages(
        self,
        user_id: str,
        session_id: str,
        max_messages: int = 20,
    ) -> List[Dict[str, Any]]:
        rows = fetch_sync(
            self.database_url,
            """
            SELECT role, content, created_at
            FROM messages
            WHERE session_id = $1::uuid
            ORDER BY created_at DESC, message_id DESC
            LIMIT $2
            """,
            session_id,
            max_messages,
        )
        ordered = list(reversed(rows))
        return [
            {
                "role": r["role"],
                "content": r["content"],
                "created_at": r["created_at"].isoformat() if r["created_at"] else None,
            }
            for r in ordered
        ]
