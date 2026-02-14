import logging
from contextlib import asynccontextmanager
import uuid
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
