import logging
from contextlib import asynccontextmanager
import uuid
import json
from typing import Any, Dict, List, Optional
import asyncpg

from backend.core.config import settings


async def ensure_table(pool: asyncpg.Pool) -> None:
    async with pool.acquire() as conn:
         await conn.execute(
            """
                CREATE TABLE IF NOT EXISTS sessions (
                    session_id UUID PRIMARY KEY,
                    title VARCHAR(255) DEFAULT 'New chat',
                    storage_mode VARCHAR(20) DEFAULT 'legacy',
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );
                ALTER TABLE sessions ADD COLUMN IF NOT EXISTS storage_mode VARCHAR(20) DEFAULT 'legacy';
                CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions (updated_at DESC);
                
                CREATE TABLE IF NOT EXISTS messages (
                     message_id SERIAL PRIMARY KEY, -- 消息唯一 ID
                    session_id UUID NOT NULL,      -- 关联会话 ID
                    role VARCHAR(20) NOT NULL,     -- 角色：'user', 'assistant', 或 'system'
                    content TEXT NOT NULL,         -- 消息具体内容
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    -- 约束：当 session 被删除时，对应的消息也自动删除
                    CONSTRAINT fk_session
                    FOREIGN KEY(session_id) 
                    REFERENCES sessions(session_id) 
                    ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages (session_id);

                CREATE TABLE IF NOT EXISTS paper_records (
                    session_id UUID NOT NULL,
                    paper_id TEXT NOT NULL,
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
                    status TEXT NOT NULL DEFAULT 'pending',
                    PRIMARY KEY (session_id, paper_id),
                    CONSTRAINT fk_paper_session
                    FOREIGN KEY(session_id)
                    REFERENCES sessions(session_id)
                    ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_paper_records_session_updated
                    ON paper_records (session_id, updated_at DESC);
                CREATE INDEX IF NOT EXISTS idx_paper_records_session_source_url
                    ON paper_records (session_id, source_url);
                CREATE INDEX IF NOT EXISTS idx_paper_records_session_local_path
                    ON paper_records (session_id, local_path);

                CREATE TABLE IF NOT EXISTS authorized_paper_refs (
                    session_id UUID NOT NULL,
                    ref TEXT NOT NULL,
                    source TEXT,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    PRIMARY KEY (session_id, ref),
                    CONSTRAINT fk_auth_paper_session
                    FOREIGN KEY(session_id)
                    REFERENCES sessions(session_id)
                    ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_authorized_paper_refs_session_ref
                    ON authorized_paper_refs (session_id, ref);

                CREATE TABLE IF NOT EXISTS session_paper_links (
                    session_id UUID NOT NULL,
                    paper_id TEXT NOT NULL,
                    source_ref TEXT,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    last_access_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    PRIMARY KEY (session_id, paper_id),
                    CONSTRAINT fk_session_paper_links_session
                    FOREIGN KEY(session_id)
                    REFERENCES sessions(session_id)
                    ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_session_paper_links_session_last_access
                    ON session_paper_links (session_id, last_access_at DESC);
                CREATE INDEX IF NOT EXISTS idx_session_paper_links_paper
                    ON session_paper_links (paper_id);

                -- Deprecated session-scoped cache tables; kept for backward compatibility.
                CREATE TABLE IF NOT EXISTS paper_cache (
                    session_id UUID NOT NULL,
                    cache_key TEXT NOT NULL,
                    func_name TEXT NOT NULL,
                    data TEXT NOT NULL,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    expires_at TIMESTAMPTZ NOT NULL,
                    PRIMARY KEY (session_id, cache_key),
                    CONSTRAINT fk_paper_cache_session
                    FOREIGN KEY(session_id)
                    REFERENCES sessions(session_id)
                    ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_paper_cache_session_expires
                    ON paper_cache (session_id, expires_at);

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
                CREATE INDEX IF NOT EXISTS idx_paper_records_global_updated
                    ON paper_records_global (updated_at DESC);
                CREATE INDEX IF NOT EXISTS idx_paper_records_global_source_url
                    ON paper_records_global (source_url);
                CREATE INDEX IF NOT EXISTS idx_paper_records_global_local_path
                    ON paper_records_global (local_path);

                CREATE TABLE IF NOT EXISTS paper_cache_global (
                    cache_key TEXT PRIMARY KEY,
                    func_name TEXT NOT NULL,
                    data TEXT NOT NULL,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    expires_at TIMESTAMPTZ NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_paper_cache_global_expires
                    ON paper_cache_global (expires_at);

                CREATE TABLE IF NOT EXISTS session_tool_calls (
                    id BIGSERIAL PRIMARY KEY,
                    session_id UUID NOT NULL,
                    tool_call_id TEXT,
                    tool_name TEXT NOT NULL,
                    tool_args JSONB,
                    tool_result TEXT,
                    tool_result_summary TEXT,
                    retrieval_records JSONB NOT NULL DEFAULT '[]'::jsonb,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    CONSTRAINT fk_session_tool_calls_session
                    FOREIGN KEY(session_id)
                    REFERENCES sessions(session_id)
                    ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_session_tool_calls_session_id
                    ON session_tool_calls (session_id, id DESC);

                CREATE TABLE IF NOT EXISTS session_context_compression (
                    session_id UUID PRIMARY KEY,
                    compressed_block JSONB NOT NULL DEFAULT '{}'::jsonb,
                    last_compressed_tool_call_id BIGINT,
                    context_window_tokens INT NOT NULL DEFAULT 128000,
                    threshold_ratio DOUBLE PRECISION NOT NULL DEFAULT 0.93,
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    CONSTRAINT fk_session_context_compression_session
                    FOREIGN KEY(session_id)
                    REFERENCES sessions(session_id)
                    ON DELETE CASCADE
                );
            """
        )



async def init_db(app) -> None:
    app.state.db_pool = await asyncpg.create_pool(
        dsn=settings.database_url,
        min_size=settings.db_pool_min_size,
        max_size=settings.db_pool_max_size,
        timeout=settings.db_pool_timeout,
    )
    await ensure_table(app.state.db_pool)


async def close_db(app) -> None:
    pool = getattr(app.state, "db_pool", None)
    if pool:
        await pool.close()

async def insert_session(
    pool: asyncpg.Pool,
    session_id: str,
    title: str = "新对话",
    storage_mode: str = "sandboxed",
) -> None:
    """
    在 sessions 表中插入新记录
    """
    query = """
        INSERT INTO sessions (session_id, title, storage_mode) 
        VALUES ($1, $2, $3)
    """
    await pool.execute(query, session_id, title, storage_mode)



async def insert_message(pool: asyncpg.Pool, session_id: str, role: str, content: str) -> None:
    """
    插入新消息到 messages 表
    更新 sessions 表的 updated_at 字段，让对话在侧边栏置顶
    """
    insert_msg_query = """
        INSERT INTO messages (session_id, role, content) 
        VALUES ($1, $2, $3)
    """
    update_session_query = """
        UPDATE sessions 
        SET updated_at = NOW() 
        WHERE session_id = $1
    """

    u_id = uuid.UUID(session_id)

    try:
        async with pool.acquire() as conn:
            async with conn.transaction():
                await conn.execute(insert_msg_query, u_id, role, content)
                await conn.execute(update_session_query, u_id)
    except Exception as e:
        logging.error(f"Failed to insert message and update session: {e}")
        raise e
    
    
async def get_all_sessions(pool):
    """
    从数据库获取所有会话列表，按最后更新时间倒序排列
    """
    query = """
        SELECT session_id, title, created_at, updated_at, storage_mode
        FROM sessions 
        ORDER BY updated_at DESC;
    """
    try:
        async with pool.acquire() as conn:
            rows = await conn.fetch(query)
            
            return [
                {
                    "session_id": str(row["session_id"]),
                    "title": row["title"],
                    "created_at": row["created_at"].isoformat(),
                    "updated_at": row["updated_at"].isoformat(),
                    "storage_mode": row["storage_mode"] or "legacy",
                }
                for row in rows
            ]
    except Exception as e:
        logging.error(f"Error fetching sessions: {e}")
        return []
    

async def update_session_title(pool: asyncpg.Pool, session_id: str, title: str) -> bool:
    """
    更新 sessions 标题，并刷新 updated_at。
    """
    query = """
        UPDATE sessions
        SET title = $2, updated_at = NOW()
        WHERE session_id = $1
    """
    u_id = uuid.UUID(session_id)
    try:
        async with pool.acquire() as conn:
            result = await conn.execute(query, u_id, title)
        parts = result.split(" ")
        if len(parts) == 2 and parts[0] == "UPDATE":
            return int(parts[1]) > 0
    except Exception as e:
        logging.error(f"Error updating title for session {session_id}: {e}")
    return False


async def delete_session(pool: asyncpg.Pool, session_id: str) -> bool:
    """
    删除 sessions 记录（messages 会级联删除）。
    """
    query = """
        DELETE FROM sessions
        WHERE session_id = $1
    """
    u_id = uuid.UUID(session_id)
    try:
        async with pool.acquire() as conn:
            result = await conn.execute(query, u_id)
        parts = result.split(" ")
        if len(parts) == 2 and parts[0] == "DELETE":
            return int(parts[1]) > 0
    except Exception as e:
        logging.error(f"Error deleting session {session_id}: {e}")
    return False


async def get_session_messages(pool, session_id: str):
    """
    根据 session_id 获取历史消息记录，按时间正序排列
    """
    query = """
        SELECT role, content, created_at
        FROM messages
        WHERE session_id = $1
        ORDER BY created_at ASC;
    """ 
    u_id = uuid.UUID(session_id)
    try:
        async with pool.acquire() as conn:
            rows = await conn.fetch(query, u_id)
            
            return [
                {
                    "role": row["role"],
                    "content": row["content"],
                    "created_at": row["created_at"].isoformat() if row["created_at"] else None
                }
                for row in rows
            ]
    except Exception as e:
        logging.error(f"Error fetching messages for session {session_id}: {e}")
        return []


async def get_session(pool: asyncpg.Pool, session_id: str):
    """
    获取单个 session 元信息。
    """
    query = """
        SELECT session_id, title, created_at, updated_at, storage_mode
        FROM sessions
        WHERE session_id = $1
        LIMIT 1;
    """
    u_id = uuid.UUID(session_id)
    try:
        async with pool.acquire() as conn:
            row = await conn.fetchrow(query, u_id)
            if not row:
                return None
            return {
                "session_id": str(row["session_id"]),
                "title": row["title"],
                "created_at": row["created_at"].isoformat(),
                "updated_at": row["updated_at"].isoformat(),
                "storage_mode": row["storage_mode"] or "legacy",
            }
    except Exception as e:
        logging.error(f"Error fetching session {session_id}: {e}")
        return None


async def resolve_global_paper_id_by_path(pool: asyncpg.Pool, file_path: str) -> str | None:
    """
    Resolve paper_id from global cache file path.
    Supports exact path matches and images_dir prefix matches.
    """
    query = """
        SELECT paper_id
        FROM paper_records_global
        WHERE pdf_path = $1
           OR canonical_md_path = $1
           OR report_pdf_path = $1
           OR local_path = $1
           OR ($1 LIKE images_dir || '/%')
        ORDER BY updated_at DESC
        LIMIT 1
    """
    try:
        async with pool.acquire() as conn:
            row = await conn.fetchrow(query, file_path)
            return row["paper_id"] if row else None
    except Exception as e:
        logging.error(f"Error resolving paper_id by path: {e}")
        return None


async def session_can_access_paper(pool: asyncpg.Pool, session_id: str, paper_id: str) -> bool:
    """
    Check whether a session is authorized/linked to access a paper.
    Authorization sources:
    - session_paper_links(session_id, paper_id)
    - authorized_paper_refs(session_id, ref) matching paper identifiers
    """
    if not paper_id:
        return False

    refs = {
        paper_id,
        paper_id.replace("_", ".", 1),
        paper_id.replace("_", "."),
    }
    refs_list = list(refs)
    query = """
        SELECT EXISTS (
            SELECT 1
            FROM session_paper_links
            WHERE session_id = $1::uuid AND paper_id = $2
            UNION
            SELECT 1
            FROM authorized_paper_refs
            WHERE session_id = $1::uuid AND ref = ANY($3::text[])
        ) AS allowed
    """
    try:
        async with pool.acquire() as conn:
            row = await conn.fetchrow(query, session_id, paper_id, refs_list)
            return bool(row["allowed"]) if row else False
    except Exception as e:
        logging.error(f"Error checking paper access for session {session_id}: {e}")
        return False


async def insert_session_tool_call(
    pool: asyncpg.Pool,
    session_id: str,
    tool_name: str,
    tool_call_id: Optional[str] = None,
    tool_args: Optional[Dict[str, Any]] = None,
    tool_result: Optional[str] = None,
    tool_result_summary: Optional[str] = None,
    retrieval_records: Optional[List[Dict[str, Any]]] = None,
) -> Optional[int]:
    """Persist a completed tool execution for context management."""
    query = """
        INSERT INTO session_tool_calls (
            session_id, tool_call_id, tool_name, tool_args,
            tool_result, tool_result_summary, retrieval_records
        )
        VALUES (
            $1::uuid, $2, $3, $4::jsonb,
            $5, $6, $7::jsonb
        )
        RETURNING id
    """
    try:
        tool_args_json = json.dumps(tool_args or {}, ensure_ascii=False)
        retrieval_json = json.dumps(retrieval_records or [], ensure_ascii=False)
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                query,
                session_id,
                tool_call_id,
                tool_name,
                tool_args_json,
                tool_result,
                tool_result_summary,
                retrieval_json,
            )
            return int(row["id"]) if row else None
    except Exception as e:
        logging.error(f"Error inserting session tool call for session {session_id}: {e}")
        return None


async def get_recent_session_tool_calls(
    pool: asyncpg.Pool,
    session_id: str,
    limit: int = 3,
) -> List[Dict[str, Any]]:
    """Return most recent tool calls for prompt injection."""
    query = """
        SELECT id, tool_call_id, tool_name, tool_args, tool_result_summary, created_at
        FROM session_tool_calls
        WHERE session_id = $1::uuid
        ORDER BY id DESC
        LIMIT $2
    """
    try:
        async with pool.acquire() as conn:
            rows = await conn.fetch(query, session_id, max(1, limit))
        records = []
        for row in rows:
            tool_args = row["tool_args"]
            if isinstance(tool_args, str):
                try:
                    tool_args = json.loads(tool_args)
                except json.JSONDecodeError:
                    tool_args = {}
            records.append(
                {
                    "id": int(row["id"]),
                    "tool_call_id": row["tool_call_id"],
                    "tool_name": row["tool_name"],
                    "tool_args": tool_args or {},
                    "tool_result_summary": row["tool_result_summary"] or "",
                    "created_at": row["created_at"].isoformat() if row["created_at"] else None,
                }
            )
        return records
    except Exception as e:
        logging.error(f"Error fetching recent tool calls for session {session_id}: {e}")
        return []


async def get_recent_tool_calls_keep_from_id(
    pool: asyncpg.Pool,
    session_id: str,
    keep_recent: int,
) -> Optional[int]:
    """
    Return the minimum ID among the most recent N tool calls.
    Tool calls with ID >= keep_from_id should be kept as raw recent calls.
    """
    query = """
        SELECT MIN(id) AS keep_from_id
        FROM (
            SELECT id
            FROM session_tool_calls
            WHERE session_id = $1::uuid
            ORDER BY id DESC
            LIMIT $2
        ) recent
    """
    try:
        async with pool.acquire() as conn:
            row = await conn.fetchrow(query, session_id, max(1, keep_recent))
            if not row or row["keep_from_id"] is None:
                return None
            return int(row["keep_from_id"])
    except Exception as e:
        logging.error(f"Error fetching keep_from_id for session {session_id}: {e}")
        return None


async def get_tool_calls_for_compression(
    pool: asyncpg.Pool,
    session_id: str,
    after_id: int,
    before_id: int,
) -> List[Dict[str, Any]]:
    """Return tool calls in (after_id, before_id) for incremental compression."""
    query = """
        SELECT id, tool_call_id, tool_name, tool_args, tool_result, tool_result_summary, retrieval_records, created_at
        FROM session_tool_calls
        WHERE session_id = $1::uuid
          AND id > $2
          AND id < $3
        ORDER BY id ASC
    """
    try:
        async with pool.acquire() as conn:
            rows = await conn.fetch(query, session_id, max(0, after_id), before_id)
        records = []
        for row in rows:
            tool_args = row["tool_args"]
            if isinstance(tool_args, str):
                try:
                    tool_args = json.loads(tool_args)
                except json.JSONDecodeError:
                    tool_args = {}
            retrieval_records = row["retrieval_records"]
            if isinstance(retrieval_records, str):
                try:
                    retrieval_records = json.loads(retrieval_records)
                except json.JSONDecodeError:
                    retrieval_records = []
            records.append(
                {
                    "id": int(row["id"]),
                    "tool_call_id": row["tool_call_id"],
                    "tool_name": row["tool_name"],
                    "tool_args": tool_args or {},
                    "tool_result": row["tool_result"] or "",
                    "tool_result_summary": row["tool_result_summary"] or "",
                    "retrieval_records": retrieval_records or [],
                    "created_at": row["created_at"].isoformat() if row["created_at"] else None,
                }
            )
        return records
    except Exception as e:
        logging.error(f"Error fetching compression candidates for session {session_id}: {e}")
        return []


async def upsert_session_context_compression_state(
    pool: asyncpg.Pool,
    session_id: str,
    context_window_tokens: int,
    threshold_ratio: float,
) -> Dict[str, Any]:
    """Ensure and return context compression state for a session."""
    query = """
        INSERT INTO session_context_compression (
            session_id, compressed_block, last_compressed_tool_call_id,
            context_window_tokens, threshold_ratio, updated_at
        )
        VALUES (
            $1::uuid, '{}'::jsonb, NULL,
            $2, $3, NOW()
        )
        ON CONFLICT (session_id)
        DO UPDATE SET
            context_window_tokens = EXCLUDED.context_window_tokens,
            threshold_ratio = EXCLUDED.threshold_ratio
        RETURNING session_id, compressed_block, last_compressed_tool_call_id,
                  context_window_tokens, threshold_ratio, updated_at
    """
    try:
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                query,
                session_id,
                max(1, int(context_window_tokens)),
                float(threshold_ratio),
            )
        compressed_block = row["compressed_block"] if row and row["compressed_block"] is not None else {}
        if isinstance(compressed_block, str):
            try:
                compressed_block = json.loads(compressed_block)
            except json.JSONDecodeError:
                compressed_block = {}
        return {
            "session_id": str(row["session_id"]),
            "compressed_block": compressed_block if isinstance(compressed_block, dict) else {},
            "last_compressed_tool_call_id": row["last_compressed_tool_call_id"],
            "context_window_tokens": int(row["context_window_tokens"]),
            "threshold_ratio": float(row["threshold_ratio"]),
            "updated_at": row["updated_at"].isoformat() if row["updated_at"] else None,
        } if row else {
            "session_id": session_id,
            "compressed_block": {},
            "last_compressed_tool_call_id": None,
            "context_window_tokens": max(1, int(context_window_tokens)),
            "threshold_ratio": float(threshold_ratio),
            "updated_at": None,
        }
    except Exception as e:
        logging.error(f"Error upserting compression state for session {session_id}: {e}")
        return {
            "session_id": session_id,
            "compressed_block": {},
            "last_compressed_tool_call_id": None,
            "context_window_tokens": max(1, int(context_window_tokens)),
            "threshold_ratio": float(threshold_ratio),
            "updated_at": None,
        }


async def update_session_context_compression_state(
    pool: asyncpg.Pool,
    session_id: str,
    compressed_block: Dict[str, Any],
    last_compressed_tool_call_id: Optional[int],
    context_window_tokens: int,
    threshold_ratio: float,
) -> bool:
    """Persist compressed context block and pointer to the last compressed tool call."""
    query = """
        INSERT INTO session_context_compression (
            session_id, compressed_block, last_compressed_tool_call_id,
            context_window_tokens, threshold_ratio, updated_at
        )
        VALUES (
            $1::uuid, $2::jsonb, $3,
            $4, $5, NOW()
        )
        ON CONFLICT (session_id)
        DO UPDATE SET
            compressed_block = EXCLUDED.compressed_block,
            last_compressed_tool_call_id = EXCLUDED.last_compressed_tool_call_id,
            context_window_tokens = EXCLUDED.context_window_tokens,
            threshold_ratio = EXCLUDED.threshold_ratio,
            updated_at = NOW()
    """
    try:
        async with pool.acquire() as conn:
            await conn.execute(
                query,
                session_id,
                json.dumps(compressed_block or {}, ensure_ascii=False),
                last_compressed_tool_call_id,
                max(1, int(context_window_tokens)),
                float(threshold_ratio),
            )
        return True
    except Exception as e:
        logging.error(f"Error updating compression state for session {session_id}: {e}")
        return False
