"""Deprecated compatibility layer. Use agent.session_repo_pg instead."""

from agent.session_repo_pg import SessionRepoPG, SessionRecord


class SessionDatabase(SessionRepoPG):
    """Backward-compatible alias for the PostgreSQL session repository."""

    pass


__all__ = ["SessionDatabase", "SessionRecord"]
