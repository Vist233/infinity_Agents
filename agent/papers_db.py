"""Deprecated compatibility layer. Use agent.papers_repo_pg instead."""

from typing import Optional

from agent.papers_repo_pg import PaperRecord, PapersRepoPG


DEFAULT_SESSION_ID = "00000000-0000-0000-0000-000000000000"


class PapersDatabase(PapersRepoPG):
    """
    Backward-compatible alias for PostgreSQL repository.

    Legacy constructor accepted db_path; now ignored in favor of DATABASE_URL.
    """

    def __init__(self, db_path: Optional[object] = None, session_id: Optional[str] = None):
        del db_path
        super().__init__(session_id=session_id or DEFAULT_SESSION_ID)


__all__ = ["PapersDatabase", "PaperRecord", "DEFAULT_SESSION_ID"]
