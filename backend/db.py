import logging
import uuid
import json
import os
from typing import Any, Dict, List, Optional
import asyncpg

from backend.core.config import settings
from backend.db_rls import rls_enabled_from_env, wrap_runtime_pool


async def ensure_table(pool: asyncpg.Pool) -> None:
    async with pool.acquire() as conn:
         await conn.execute(
            """
                CREATE TABLE IF NOT EXISTS sessions (
                    session_id UUID PRIMARY KEY,
                    user_id TEXT,
                    title VARCHAR(255) DEFAULT 'New chat',
                    storage_mode VARCHAR(20) DEFAULT 'legacy',
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );
                ALTER TABLE sessions ADD COLUMN IF NOT EXISTS storage_mode VARCHAR(20) DEFAULT 'legacy';
                ALTER TABLE sessions ADD COLUMN IF NOT EXISTS user_id TEXT;
                CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions (updated_at DESC);
                CREATE INDEX IF NOT EXISTS idx_sessions_user_updated_at ON sessions (user_id, updated_at DESC);
                
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

                CREATE TABLE IF NOT EXISTS session_uploaded_papers (
                    session_id UUID NOT NULL,
                    paper_id TEXT NOT NULL,
                    original_filename TEXT NOT NULL,
                    stored_pdf_path TEXT NOT NULL,
                    canonical_md_path TEXT NOT NULL,
                    images_dir TEXT,
                    page_count INT NOT NULL DEFAULT 0,
                    image_count INT NOT NULL DEFAULT 0,
                    status TEXT NOT NULL DEFAULT 'completed',
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    PRIMARY KEY (session_id, paper_id),
                    CONSTRAINT fk_session_uploaded_papers_session
                    FOREIGN KEY(session_id)
                    REFERENCES sessions(session_id)
                    ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_session_uploaded_papers_session_created
                    ON session_uploaded_papers (session_id, created_at DESC);
                CREATE INDEX IF NOT EXISTS idx_session_uploaded_papers_paper
                    ON session_uploaded_papers (paper_id);

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

                -- ============================================================================
                -- Task Execution System (Infinity Agent)
                -- ============================================================================

                CREATE TABLE IF NOT EXISTS users (
                    user_id TEXT PRIMARY KEY,
                    issuer TEXT NOT NULL DEFAULT 'local',
                    subject TEXT NOT NULL,
                    email TEXT,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    UNIQUE (issuer, subject)
                );

                CREATE TABLE IF NOT EXISTS auth_sessions (
                    session_id UUID PRIMARY KEY,
                    user_id TEXT NOT NULL,
                    expires_at TIMESTAMPTZ NOT NULL,
                    revoked_at TIMESTAMPTZ,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );
                CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions (user_id, expires_at);

                CREATE TABLE IF NOT EXISTS oauth_states (
                    state_hash CHAR(64) PRIMARY KEY,
                    verifier TEXT NOT NULL,
                    nonce TEXT NOT NULL,
                    return_to TEXT NOT NULL,
                    code_challenge TEXT,
                    expires_at TIMESTAMPTZ NOT NULL,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );
                CREATE INDEX IF NOT EXISTS idx_oauth_states_expires ON oauth_states (expires_at);

                CREATE TABLE IF NOT EXISTS project_members (
                    project_id UUID NOT NULL,
                    user_id TEXT NOT NULL,
                    role VARCHAR(20) NOT NULL DEFAULT 'member',
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    PRIMARY KEY (project_id, user_id)
                );
                CREATE INDEX IF NOT EXISTS idx_project_members_user ON project_members (user_id, project_id);

                CREATE TABLE IF NOT EXISTS projects (
                    project_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                    name TEXT NOT NULL,
                    description TEXT,
                    created_by TEXT,
                    owner_user_id TEXT,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );
                ALTER TABLE projects ADD COLUMN IF NOT EXISTS owner_user_id TEXT;
                CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects (owner_user_id, updated_at DESC);

                CREATE TABLE IF NOT EXISTS task_specs (
                    task_spec_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                    project_id UUID NOT NULL,
                    revision INT NOT NULL DEFAULT 1,
                    title TEXT NOT NULL,
                    domain VARCHAR(50) NOT NULL DEFAULT 'bioinformatics',
                    analysis_type VARCHAR(50) NOT NULL,
                    research_question TEXT NOT NULL,
                    spec_json JSONB NOT NULL DEFAULT '{}'::jsonb,
                    schema_version VARCHAR(10) NOT NULL DEFAULT '1.0',
                    status VARCHAR(20) NOT NULL DEFAULT 'draft',
                    created_by TEXT,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    frozen_at TIMESTAMPTZ
                );
                CREATE INDEX IF NOT EXISTS idx_task_specs_project ON task_specs (project_id, updated_at DESC);
                CREATE INDEX IF NOT EXISTS idx_task_specs_status ON task_specs (status);

                CREATE TABLE IF NOT EXISTS method_sources (
                    method_source_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                    project_id UUID NOT NULL REFERENCES projects(project_id),
                    task_spec_id UUID REFERENCES task_specs(task_spec_id),
                    original_filename TEXT NOT NULL,
                    stored_path TEXT NOT NULL,
                    content_type TEXT,
                    file_size_bytes BIGINT,
                    file_hash_sha256 CHAR(64),
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );
                CREATE INDEX IF NOT EXISTS idx_method_sources_project ON method_sources (project_id, created_at DESC);

                CREATE TABLE IF NOT EXISTS dataset_snapshots (
                    dataset_snapshot_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                    task_spec_id UUID NOT NULL REFERENCES task_specs(task_spec_id),
                    project_id UUID NOT NULL,
                    original_filename TEXT NOT NULL,
                    stored_path TEXT NOT NULL,
                    file_size_bytes BIGINT,
                    file_hash_sha256 CHAR(64),
                    metadata JSONB DEFAULT '{}'::jsonb,
                    validation_result JSONB DEFAULT '{}'::jsonb,
                    validation_passed BOOLEAN NOT NULL DEFAULT FALSE,
                    version INT NOT NULL DEFAULT 1,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );
                CREATE INDEX IF NOT EXISTS idx_dataset_snapshots_task_spec ON dataset_snapshots (task_spec_id);
                CREATE INDEX IF NOT EXISTS idx_dataset_snapshots_project ON dataset_snapshots (project_id);

                CREATE TABLE IF NOT EXISTS tasks (
                    task_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                    task_spec_id UUID NOT NULL REFERENCES task_specs(task_spec_id),
                    dataset_snapshot_id UUID NOT NULL REFERENCES dataset_snapshots(dataset_snapshot_id),
                    project_id UUID NOT NULL,
                    title TEXT NOT NULL,
                    status VARCHAR(20) NOT NULL DEFAULT 'draft',
                    phase VARCHAR(20),
                    priority INT NOT NULL DEFAULT 0,
                    version INT NOT NULL DEFAULT 1,
                    lease_owner TEXT,
                    lease_token CHAR(32),
                    lease_expires_at TIMESTAMPTZ,
                    active_attempt_id BIGINT,
                    attempt_count INT NOT NULL DEFAULT 0,
                    max_attempts INT NOT NULL DEFAULT 3,
                    -- The safe internal default is full trust. The
                    -- authenticated API derives general for ordinary users
                    -- and full for server-recognized superusers.
                    required_trust_level VARCHAR(20) NOT NULL DEFAULT 'full',
                    cancel_requested_at TIMESTAMPTZ,
                    result_artifact_id TEXT,
                    error_message TEXT,
                    created_by TEXT,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    started_at TIMESTAMPTZ,
                    finished_at TIMESTAMPTZ,
                    CONSTRAINT chk_task_status CHECK (status IN (
                        'draft','queued','claimed','running','succeeded','failed','cancelled','timeout'
                    ))
                );
                CREATE INDEX IF NOT EXISTS idx_tasks_project_status ON tasks (project_id, status);
                CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks (created_at DESC);
                CREATE INDEX IF NOT EXISTS idx_tasks_lease ON tasks (lease_expires_at) WHERE lease_owner IS NOT NULL;

                CREATE TABLE IF NOT EXISTS task_attempts (
                    task_attempt_id BIGSERIAL PRIMARY KEY,
                    task_id UUID NOT NULL REFERENCES tasks(task_id),
                    worker_id TEXT NOT NULL,
                    status VARCHAR(20) NOT NULL DEFAULT 'running',
                    attempt_index INT NOT NULL,
                    container_id TEXT,
                    executor_image_digest TEXT,
                    docker_container_id TEXT,
                    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    finished_at TIMESTAMPTZ,
                    exit_code INT,
                    error_message TEXT,
                    failure_code VARCHAR(50),
                    failure_detail TEXT,
                    token_usage JSONB DEFAULT '{}'::jsonb
                );
                ALTER TABLE task_attempts DROP CONSTRAINT IF EXISTS chk_task_attempt_status;
                ALTER TABLE task_attempts ADD CONSTRAINT chk_task_attempt_status CHECK (status IN (
                    'running', 'succeeded', 'failed', 'lost', 'cancelled', 'timeout'
                ));
                CREATE INDEX IF NOT EXISTS idx_task_attempts_task ON task_attempts (task_id, attempt_index DESC);

                CREATE TABLE IF NOT EXISTS task_events (
                    task_event_id BIGSERIAL PRIMARY KEY,
                    task_id UUID NOT NULL REFERENCES tasks(task_id),
                    task_attempt_id BIGINT REFERENCES task_attempts(task_attempt_id),
                    event_type VARCHAR(50) NOT NULL,
                    event_data JSONB DEFAULT '{}'::jsonb,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );
                CREATE INDEX IF NOT EXISTS idx_task_events_task_created ON task_events (task_id, created_at DESC);

                CREATE TABLE IF NOT EXISTS outbox_events (
                    outbox_event_id BIGSERIAL PRIMARY KEY,
                    aggregate_type VARCHAR(50) NOT NULL DEFAULT 'task',
                    aggregate_id UUID NOT NULL,
                    event_type VARCHAR(50) NOT NULL,
                    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
                    status VARCHAR(20) NOT NULL DEFAULT 'pending',
                    published_at TIMESTAMPTZ,
                    retry_count INT NOT NULL DEFAULT 0,
                    last_error TEXT,
                    claim_expires_at TIMESTAMPTZ,
                    claim_token TEXT,
                    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );
                CREATE INDEX IF NOT EXISTS idx_outbox_events_status_created ON outbox_events (status, created_at) WHERE status = 'pending';
                CREATE INDEX IF NOT EXISTS idx_outbox_events_aggregate ON outbox_events (aggregate_type, aggregate_id);

                CREATE TABLE IF NOT EXISTS artifacts (
                    artifact_id TEXT PRIMARY KEY,
                    task_id UUID NOT NULL REFERENCES tasks(task_id),
                    task_attempt_id BIGINT REFERENCES task_attempts(task_attempt_id),
                    name TEXT NOT NULL,
                    kind VARCHAR(20) NOT NULL,
                    storage_backend VARCHAR(20) NOT NULL DEFAULT 'local',
                    storage_path TEXT NOT NULL,
                    file_size_bytes BIGINT,
                    checksum_sha256 CHAR(64),
                    content_type TEXT,
                    metadata JSONB DEFAULT '{}'::jsonb,
                    deleted_at TIMESTAMPTZ,
                    cleanup_completed_at TIMESTAMPTZ,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );
                CREATE INDEX IF NOT EXISTS idx_artifacts_task ON artifacts (task_id, created_at DESC);

                CREATE TABLE IF NOT EXISTS idempotency_keys (
                    idempotency_key VARCHAR(255) NOT NULL,
                    user_id TEXT NOT NULL DEFAULT '__legacy__',
                    resource_type VARCHAR(50) NOT NULL,
                    resource_id UUID,
                    request_hash TEXT,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '24 hours',
                    PRIMARY KEY (idempotency_key, user_id, resource_type)
                );
                CREATE INDEX IF NOT EXISTS idx_idempotency_keys_expires ON idempotency_keys (expires_at);

                -- Migrations: add columns if they don't exist (for existing databases)
                ALTER TABLE tasks ADD COLUMN IF NOT EXISTS phase VARCHAR(20);
                ALTER TABLE tasks ADD COLUMN IF NOT EXISTS priority INT NOT NULL DEFAULT 0;
                ALTER TABLE tasks ADD COLUMN IF NOT EXISTS version INT NOT NULL DEFAULT 1;
                ALTER TABLE tasks ADD COLUMN IF NOT EXISTS cancel_requested_at TIMESTAMPTZ;
                ALTER TABLE tasks ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;
                ALTER TABLE tasks ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ;
                ALTER TABLE tasks ADD COLUMN IF NOT EXISTS method_source_id UUID;
                ALTER TABLE tasks ADD COLUMN IF NOT EXISTS required_trust_level VARCHAR(20) NOT NULL DEFAULT 'full';
                UPDATE tasks
                SET required_trust_level = 'full'
                WHERE required_trust_level IS NULL OR required_trust_level NOT IN ('general', 'full');
                ALTER TABLE tasks DROP CONSTRAINT IF EXISTS chk_tasks_required_trust_level;
                ALTER TABLE tasks ADD CONSTRAINT chk_tasks_required_trust_level
                    CHECK (required_trust_level IN ('general', 'full'));
                ALTER TABLE task_attempts ADD COLUMN IF NOT EXISTS container_id TEXT;
                ALTER TABLE task_attempts ADD COLUMN IF NOT EXISTS executor_image_digest TEXT;
                ALTER TABLE task_attempts ADD COLUMN IF NOT EXISTS failure_code VARCHAR(50);
                ALTER TABLE task_attempts ADD COLUMN IF NOT EXISTS failure_detail TEXT;
                ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
                ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS cleanup_completed_at TIMESTAMPTZ;
                CREATE INDEX IF NOT EXISTS idx_artifacts_cleanup
                    ON artifacts (deleted_at, cleanup_completed_at, created_at)
                    WHERE deleted_at IS NOT NULL;
                ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
                ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS claim_expires_at TIMESTAMPTZ;
                ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS claim_token TEXT;
                UPDATE outbox_events
                SET status = 'pending', claim_expires_at = NULL, claim_token = NULL
                WHERE status = 'publishing' AND claim_expires_at IS NULL;
                ALTER TABLE idempotency_keys ADD COLUMN IF NOT EXISTS user_id TEXT;
                ALTER TABLE idempotency_keys ADD COLUMN IF NOT EXISTS request_hash TEXT;
                -- Authenticated idempotency is user-scoped.  Existing legacy
                -- rows had a nullable owner and a global primary key; map
                -- those rows to an explicit compatibility owner before
                -- replacing the constraint so two users cannot collide.
                UPDATE idempotency_keys SET user_id = '__legacy__' WHERE user_id IS NULL;
                ALTER TABLE idempotency_keys ALTER COLUMN user_id SET DEFAULT '__legacy__';
                ALTER TABLE idempotency_keys ALTER COLUMN user_id SET NOT NULL;
                ALTER TABLE idempotency_keys DROP CONSTRAINT IF EXISTS idempotency_keys_pkey;
                ALTER TABLE idempotency_keys ADD CONSTRAINT idempotency_keys_pkey PRIMARY KEY (idempotency_key, user_id, resource_type);

                CREATE TABLE IF NOT EXISTS project_resources (
                    resource_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                    project_id UUID NOT NULL,
                    owner_user_id TEXT NOT NULL,
                    kind VARCHAR(30) NOT NULL,
                    logical_name TEXT NOT NULL,
                    storage_key TEXT NOT NULL UNIQUE,
                    content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
                    file_size_bytes BIGINT NOT NULL DEFAULT 0,
                    checksum_sha256 CHAR(64),
                    egress_policy VARCHAR(30) NOT NULL DEFAULT 'local_only',
                    status VARCHAR(20) NOT NULL DEFAULT 'ready',
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    revoked_at TIMESTAMPTZ
                );
                CREATE INDEX IF NOT EXISTS idx_project_resources_owner ON project_resources (owner_user_id, project_id, created_at DESC);
                CREATE TABLE IF NOT EXISTS session_resource_links (
                    session_id UUID NOT NULL,
                    resource_id UUID NOT NULL,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    PRIMARY KEY (session_id, resource_id)
                );

                CREATE TABLE IF NOT EXISTS task_drafts (
                    draft_id UUID PRIMARY KEY,
                    session_id UUID NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
                    project_id UUID NOT NULL,
                    owner_user_id TEXT NOT NULL,
                    revision INT NOT NULL DEFAULT 1,
                    title TEXT NOT NULL,
                    goal_summary TEXT NOT NULL DEFAULT '',
                    method_path TEXT,
                    method_filename TEXT,
                    method_preview TEXT,
                    method_size_bytes BIGINT NOT NULL DEFAULT 0,
                    method_hash_sha256 CHAR(64),
                    dataset_resource_id UUID,
                    dataset_filename TEXT,
                    dataset_size_bytes BIGINT,
                    dataset_hash_sha256 CHAR(64),
                    task_spec JSONB NOT NULL DEFAULT '{}'::jsonb,
                    missing_inputs JSONB NOT NULL DEFAULT '[]'::jsonb,
                    status VARCHAR(32) NOT NULL DEFAULT 'awaiting_user_confirmation',
                    confirmed_task_id UUID,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '24 hours',
                    CONSTRAINT chk_task_draft_status CHECK (status IN (
                        'draft', 'awaiting_user_confirmation', 'revising', 'cancelled', 'confirmed', 'expired'
                    ))
                );
                CREATE INDEX IF NOT EXISTS idx_task_drafts_owner_session
                    ON task_drafts (owner_user_id, session_id, updated_at DESC);
                CREATE INDEX IF NOT EXISTS idx_task_drafts_status
                    ON task_drafts (status, expires_at);

                CREATE TABLE IF NOT EXISTS provider_profiles (
                    provider_profile_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                    project_id UUID NOT NULL,
                    owner_user_id TEXT NOT NULL,
                    purpose VARCHAR(20) NOT NULL,
                    protocol VARCHAR(40) NOT NULL,
                    base_url TEXT NOT NULL,
                    model_id TEXT NOT NULL,
                    credential_ref TEXT,
                    capability_json JSONB NOT NULL DEFAULT '{}'::jsonb,
                    probe_revision TEXT,
                    status VARCHAR(20) NOT NULL DEFAULT 'draft',
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    revoked_at TIMESTAMPTZ
                );
                ALTER TABLE provider_profiles ADD COLUMN IF NOT EXISTS credential_fingerprint CHAR(12);
                CREATE INDEX IF NOT EXISTS idx_provider_profiles_owner ON provider_profiles (owner_user_id, project_id, purpose);

                CREATE TABLE IF NOT EXISTS provider_secrets (
                    credential_ref TEXT PRIMARY KEY,
                    project_id UUID NOT NULL,
                    owner_user_id TEXT NOT NULL,
                    ciphertext TEXT NOT NULL,
                    key_version VARCHAR(20) NOT NULL DEFAULT 'v1',
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    revoked_at TIMESTAMPTZ
                );
                CREATE INDEX IF NOT EXISTS idx_provider_secrets_project ON provider_secrets (project_id, owner_user_id);

                CREATE TABLE IF NOT EXISTS worker_enrollments (
                    worker_id TEXT PRIMARY KEY,
                    credential_hash CHAR(64) NOT NULL,
                    namespace TEXT NOT NULL,
                    owner_user_id TEXT,
                    trust_level VARCHAR(20) NOT NULL DEFAULT 'general',
                    status VARCHAR(20) NOT NULL DEFAULT 'active',
                    enrolled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    revoked_at TIMESTAMPTZ,
                    last_seen_at TIMESTAMPTZ
                );
                ALTER TABLE worker_enrollments ADD COLUMN IF NOT EXISTS owner_user_id TEXT;
                ALTER TABLE worker_enrollments ADD COLUMN IF NOT EXISTS trust_level VARCHAR(20) NOT NULL DEFAULT 'general';
                UPDATE worker_enrollments
                SET trust_level = 'general'
                WHERE trust_level IS NULL OR trust_level NOT IN ('general', 'full');
                ALTER TABLE worker_enrollments DROP CONSTRAINT IF EXISTS chk_worker_enrollment_trust_level;
                ALTER TABLE worker_enrollments ADD CONSTRAINT chk_worker_enrollment_trust_level
                    CHECK (trust_level IN ('general', 'full'));
                CREATE INDEX IF NOT EXISTS idx_worker_enrollments_namespace ON worker_enrollments (namespace, status);
                CREATE INDEX IF NOT EXISTS idx_worker_enrollments_owner ON worker_enrollments (owner_user_id, namespace, status);

                CREATE TABLE IF NOT EXISTS worker_enrollment_tokens (
                    token_hash CHAR(64) PRIMARY KEY,
                    worker_id TEXT NOT NULL,
                    namespace TEXT NOT NULL,
                    owner_user_id TEXT,
                    trust_level VARCHAR(20) NOT NULL DEFAULT 'general',
                    expires_at TIMESTAMPTZ NOT NULL,
                    used_at TIMESTAMPTZ,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );
                ALTER TABLE worker_enrollment_tokens ADD COLUMN IF NOT EXISTS owner_user_id TEXT;
                ALTER TABLE worker_enrollment_tokens ADD COLUMN IF NOT EXISTS trust_level VARCHAR(20) NOT NULL DEFAULT 'general';
                ALTER TABLE worker_enrollment_tokens DROP CONSTRAINT IF EXISTS chk_worker_enrollment_token_trust_level;
                ALTER TABLE worker_enrollment_tokens ADD CONSTRAINT chk_worker_enrollment_token_trust_level
                    CHECK (trust_level IN ('general', 'full'));
                CREATE INDEX IF NOT EXISTS idx_worker_enrollment_tokens_worker
                    ON worker_enrollment_tokens (worker_id, namespace, expires_at);
            """
        )



async def init_db(app) -> None:
    if not settings.database_url:
        raise RuntimeError("DATABASE_URL is required to initialize the database")
    from backend.security import validate_runtime_database_url
    validate_runtime_database_url(settings.database_url)
    raw_pool = await asyncpg.create_pool(
        dsn=settings.database_url,
        min_size=settings.db_pool_min_size,
        max_size=settings.db_pool_max_size,
        timeout=settings.db_pool_timeout,
    )
    # Schema creation/migrations need an operator connection. A deployed
    # runtime login must not own the schema, so migrations can be explicitly
    # disabled after the operator has applied them. Fresh local stacks keep
    # the default enabled bootstrap path.
    default_migrations_enabled = os.getenv("APP_ENV", "development").lower() not in {
        "acceptance", "production", "prod"
    }
    migrations_enabled = os.getenv("DB_MIGRATIONS_ENABLED", "1" if default_migrations_enabled else "0").strip().lower() not in {
        "0", "false", "no", "off"
    }
    if migrations_enabled:
        await ensure_table(raw_pool)
    app.state.db_pool = wrap_runtime_pool(raw_pool) if rls_enabled_from_env() else raw_pool


async def close_db(app) -> None:
    pool = getattr(app.state, "db_pool", None)
    if pool:
        await pool.close()

async def insert_session(
    pool: asyncpg.Pool,
    session_id: str,
    user_id: str,
    title: str = "New chat",
    storage_mode: str = "sandboxed",
) -> None:
    """
    在 sessions 表中插入新记录
    """
    query = """
        INSERT INTO sessions (session_id, user_id, title, storage_mode)
        VALUES ($1, $2, $3, $4)
    """
    await pool.execute(query, session_id, user_id, title, storage_mode)



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
    
    
async def get_all_sessions(pool, user_id: str):
    """
    从数据库获取所有会话列表，按最后更新时间倒序排列
    """
    query = """
        SELECT session_id, title, created_at, updated_at, storage_mode
        FROM sessions
        WHERE user_id = $1
        ORDER BY updated_at DESC;
    """
    try:
        async with pool.acquire() as conn:
            rows = await conn.fetch(query, user_id)
            
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
    

async def update_session_title(pool: asyncpg.Pool, session_id: str, title: str, user_id: str) -> bool:
    """
    更新 sessions 标题，并刷新 updated_at。
    """
    query = """
        UPDATE sessions
        SET title = $2, updated_at = NOW()
        WHERE session_id = $1 AND user_id = $3
    """
    u_id = uuid.UUID(session_id)
    try:
        async with pool.acquire() as conn:
            result = await conn.execute(query, u_id, title, user_id)
        parts = result.split(" ")
        if len(parts) == 2 and parts[0] == "UPDATE":
            return int(parts[1]) > 0
    except Exception as e:
        logging.error(f"Error updating title for session {session_id}: {e}")
    return False


async def delete_session(pool: asyncpg.Pool, session_id: str, user_id: str) -> bool:
    """
    删除 sessions 记录（messages 会级联删除）。
    """
    query = """
        DELETE FROM sessions
        WHERE session_id = $1 AND user_id = $2
    """
    u_id = uuid.UUID(session_id)
    try:
        async with pool.acquire() as conn:
            result = await conn.execute(query, u_id, user_id)
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


async def get_session(pool: asyncpg.Pool, session_id: str, user_id: Optional[str] = None):
    """
    获取单个 session 元信息。
    """
    query = """
        SELECT session_id, title, created_at, updated_at, storage_mode
        FROM sessions
        WHERE session_id = $1
          AND ($2::text IS NULL OR user_id = $2)
        LIMIT 1;
    """
    u_id = uuid.UUID(session_id)
    try:
        async with pool.acquire() as conn:
            row = await conn.fetchrow(query, u_id, user_id)
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


async def upsert_session_paper_link(
    pool: asyncpg.Pool,
    session_id: str,
    paper_id: str,
    source_ref: Optional[str] = None,
) -> bool:
    if not session_id or not paper_id:
        return False
    query = """
        INSERT INTO session_paper_links (session_id, paper_id, source_ref, created_at, last_access_at)
        VALUES ($1::uuid, $2, $3, NOW(), NOW())
        ON CONFLICT (session_id, paper_id)
        DO UPDATE SET
            source_ref = COALESCE(EXCLUDED.source_ref, session_paper_links.source_ref),
            last_access_at = NOW()
    """
    try:
        async with pool.acquire() as conn:
            await conn.execute(query, session_id, paper_id, source_ref)
        return True
    except Exception as e:
        logging.error(f"Error linking paper {paper_id} to session {session_id}: {e}")
        return False


async def insert_session_uploaded_paper(
    pool: asyncpg.Pool,
    session_id: str,
    paper_id: str,
    original_filename: str,
    stored_pdf_path: str,
    canonical_md_path: str,
    images_dir: Optional[str] = None,
    page_count: int = 0,
    image_count: int = 0,
    status: str = "completed",
) -> Optional[Dict[str, Any]]:
    query = """
        INSERT INTO session_uploaded_papers (
            session_id, paper_id, original_filename, stored_pdf_path,
            canonical_md_path, images_dir, page_count, image_count, status, created_at
        )
        VALUES (
            $1::uuid, $2, $3, $4,
            $5, $6, $7, $8, $9, NOW()
        )
        ON CONFLICT (session_id, paper_id)
        DO UPDATE SET
            original_filename = EXCLUDED.original_filename,
            stored_pdf_path = EXCLUDED.stored_pdf_path,
            canonical_md_path = EXCLUDED.canonical_md_path,
            images_dir = EXCLUDED.images_dir,
            page_count = EXCLUDED.page_count,
            image_count = EXCLUDED.image_count,
            status = EXCLUDED.status
        RETURNING session_id, paper_id, original_filename, stored_pdf_path,
                  canonical_md_path, images_dir, page_count, image_count, status, created_at
    """
    try:
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                query,
                session_id,
                paper_id,
                original_filename,
                stored_pdf_path,
                canonical_md_path,
                images_dir,
                max(0, int(page_count)),
                max(0, int(image_count)),
                status or "completed",
            )
        if not row:
            return None
        return {
            "session_id": str(row["session_id"]),
            "paper_id": row["paper_id"],
            "original_filename": row["original_filename"],
            "stored_pdf_path": row["stored_pdf_path"],
            "canonical_md_path": row["canonical_md_path"],
            "images_dir": row["images_dir"],
            "page_count": int(row["page_count"] or 0),
            "image_count": int(row["image_count"] or 0),
            "status": row["status"] or "completed",
            "created_at": row["created_at"].isoformat() if row["created_at"] else None,
        }
    except Exception as e:
        logging.error(f"Error inserting uploaded paper {paper_id} for session {session_id}: {e}")
        return None


async def reserve_session_upload_slot(
    pool: asyncpg.Pool,
    session_id: str,
    paper_id: str,
    original_filename: str,
    stored_pdf_path: str,
    canonical_md_path: str,
    images_dir: Optional[str],
    max_papers: int,
) -> bool:
    """Reserve one upload slot atomically for a session.

    The reservation row closes the count-then-insert race without holding a
    database lock during PDF extraction.  A crashed upload can be reclaimed
    on the next reservation after the stale timeout.
    """
    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute(
                """
                SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))
                """,
                session_id,
            )
            await conn.execute(
                """
                DELETE FROM session_uploaded_papers
                WHERE session_id = $1::uuid
                  AND status = 'uploading'
                  AND created_at < NOW() - INTERVAL '1 hour'
                """,
                session_id,
            )
            count = await conn.fetchval(
                "SELECT COUNT(*) FROM session_uploaded_papers WHERE session_id = $1::uuid",
                session_id,
            )
            if int(count or 0) >= max(1, int(max_papers)):
                return False
            await conn.execute(
                """
                INSERT INTO session_uploaded_papers (
                    session_id, paper_id, original_filename, stored_pdf_path,
                    canonical_md_path, images_dir, page_count, image_count,
                    status, created_at
                )
                VALUES ($1::uuid, $2, $3, $4, $5, $6, 0, 0, 'uploading', NOW())
                """,
                session_id,
                paper_id,
                original_filename,
                stored_pdf_path,
                canonical_md_path,
                images_dir,
            )
    return True


async def list_session_uploaded_papers(pool: asyncpg.Pool, session_id: str) -> List[Dict[str, Any]]:
    query = """
        SELECT paper_id, original_filename, stored_pdf_path, canonical_md_path,
               images_dir, page_count, image_count, status, created_at
        FROM session_uploaded_papers
        WHERE session_id = $1::uuid
        ORDER BY created_at DESC
    """
    try:
        async with pool.acquire() as conn:
            rows = await conn.fetch(query, session_id)
        return [
            {
                "paper_id": row["paper_id"],
                "original_filename": row["original_filename"],
                "stored_pdf_path": row["stored_pdf_path"],
                "canonical_md_path": row["canonical_md_path"],
                "images_dir": row["images_dir"],
                "page_count": int(row["page_count"] or 0),
                "image_count": int(row["image_count"] or 0),
                "status": row["status"] or "completed",
                "created_at": row["created_at"].isoformat() if row["created_at"] else None,
            }
            for row in rows
        ]
    except Exception as e:
        logging.error(f"Error listing uploaded papers for session {session_id}: {e}")
        return []


async def get_session_uploaded_paper(pool: asyncpg.Pool, session_id: str, paper_id: str) -> Optional[Dict[str, Any]]:
    query = """
        SELECT paper_id, original_filename, stored_pdf_path, canonical_md_path,
               images_dir, page_count, image_count, status, created_at
        FROM session_uploaded_papers
        WHERE session_id = $1::uuid AND paper_id = $2
        LIMIT 1
    """
    try:
        async with pool.acquire() as conn:
            row = await conn.fetchrow(query, session_id, paper_id)
        if not row:
            return None
        return {
            "paper_id": row["paper_id"],
            "original_filename": row["original_filename"],
            "stored_pdf_path": row["stored_pdf_path"],
            "canonical_md_path": row["canonical_md_path"],
            "images_dir": row["images_dir"],
            "page_count": int(row["page_count"] or 0),
            "image_count": int(row["image_count"] or 0),
            "status": row["status"] or "completed",
            "created_at": row["created_at"].isoformat() if row["created_at"] else None,
        }
    except Exception as e:
        logging.error(f"Error fetching uploaded paper {paper_id} for session {session_id}: {e}")
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


async def upsert_task_draft(pool, payload: Dict[str, Any], *, owner_user_id: str, project_id: str) -> Dict[str, Any]:
    """Persist a session-scoped Agent task draft returned by a real tool call."""
    method = payload.get("method") if isinstance(payload.get("method"), dict) else {}
    dataset = payload.get("dataset") if isinstance(payload.get("dataset"), dict) else {}
    missing_inputs = payload.get("missing_inputs") if isinstance(payload.get("missing_inputs"), list) else []
    task_spec = payload.get("task_spec") if isinstance(payload.get("task_spec"), dict) else {}
    draft_status = "revising" if payload.get("type") == "task_draft_updated" else "awaiting_user_confirmation"
    query = """
        INSERT INTO task_drafts (
            draft_id, session_id, project_id, owner_user_id, revision, title,
            goal_summary, method_path, method_filename, method_preview,
            method_size_bytes, method_hash_sha256, dataset_resource_id,
            dataset_filename, dataset_size_bytes, dataset_hash_sha256,
            task_spec, missing_inputs, status, updated_at
        ) VALUES (
            $1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, $10,
            $11, $12, NULLIF($13, '')::uuid, NULLIF($14, ''), $15, $16,
            $17::jsonb, $18::jsonb, $19, NOW()
        )
        ON CONFLICT (draft_id) DO UPDATE SET
            revision = GREATEST(task_drafts.revision + 1, EXCLUDED.revision),
            title = EXCLUDED.title,
            goal_summary = EXCLUDED.goal_summary,
            method_path = EXCLUDED.method_path,
            method_filename = EXCLUDED.method_filename,
            method_preview = EXCLUDED.method_preview,
            method_size_bytes = EXCLUDED.method_size_bytes,
            method_hash_sha256 = EXCLUDED.method_hash_sha256,
            dataset_resource_id = EXCLUDED.dataset_resource_id,
            dataset_filename = EXCLUDED.dataset_filename,
            dataset_size_bytes = EXCLUDED.dataset_size_bytes,
            dataset_hash_sha256 = EXCLUDED.dataset_hash_sha256,
            task_spec = EXCLUDED.task_spec,
            missing_inputs = EXCLUDED.missing_inputs,
            status = CASE WHEN task_drafts.status = 'confirmed' THEN task_drafts.status ELSE EXCLUDED.status END,
            updated_at = NOW()
        RETURNING draft_id, session_id, project_id, owner_user_id, revision, title,
                  goal_summary, method_path, method_filename, method_preview,
                  method_size_bytes, method_hash_sha256, dataset_resource_id,
                  dataset_filename, dataset_size_bytes, dataset_hash_sha256,
                  task_spec, missing_inputs, status, confirmed_task_id,
                  created_at, updated_at, expires_at
    """
    args = (
        str(payload["draft_id"]),
        str(payload["session_id"]),
        project_id,
        owner_user_id,
        int(payload.get("revision") or 1),
        str(payload.get("title") or "execution-document")[:255],
        str(payload.get("goal_summary") or "")[:4000],
        str(method.get("relative_path") or "") or None,
        str(method.get("filename") or "")[:255] or None,
        str(method.get("preview") or "")[:12000],
        int(method.get("size_bytes") or 0),
        str(method.get("sha256") or "")[:64],
        str(dataset.get("resource_id") or ""),
        str(dataset.get("filename") or "")[:255],
        int(dataset.get("size_bytes") or 0) or None,
        str(dataset.get("sha256") or "")[:64] or None,
        json.dumps(task_spec, ensure_ascii=False),
        json.dumps([str(item) for item in missing_inputs][:20], ensure_ascii=False),
        draft_status,
    )
    async with pool.acquire() as conn:
        # A follow-up conversation may produce a revised draft with a new
        # draft id. Keep only the newest active draft for this session so the
        # browser never presents an obsolete confirmation card.
        await conn.execute(
            """
            UPDATE task_drafts
            SET status = 'revising', updated_at = NOW()
            WHERE session_id = $1::uuid AND owner_user_id = $2
              AND draft_id <> $3::uuid
              AND status IN ('draft', 'awaiting_user_confirmation', 'revising')
            """,
            str(payload["session_id"]), owner_user_id, str(payload["draft_id"]),
        )
        row = await conn.fetchrow(query, *args)
    return _task_draft_row(row)


def _task_draft_row(row: Any) -> Dict[str, Any]:
    def iso(name: str) -> Optional[str]:
        value = _row_value(row, name)
        return value.isoformat() if value else None

    def json_value(name: str, default: Any) -> Any:
        value = _row_value(row, name, default)
        if isinstance(value, str):
            try:
                return json.loads(value)
            except json.JSONDecodeError:
                return default
        return value if value is not None else default

    return {
        "draft_id": str(_row_value(row, "draft_id")),
        "session_id": str(_row_value(row, "session_id")),
        "project_id": str(_row_value(row, "project_id")),
        "owner_user_id": str(_row_value(row, "owner_user_id") or ""),
        "revision": int(_row_value(row, "revision", 1)),
        "title": _row_value(row, "title", ""),
        "goal_summary": _row_value(row, "goal_summary", ""),
        "method_path": _row_value(row, "method_path"),
        "method_filename": _row_value(row, "method_filename"),
        "method_preview": _row_value(row, "method_preview", ""),
        "method_size_bytes": int(_row_value(row, "method_size_bytes", 0) or 0),
        "method_hash_sha256": _row_value(row, "method_hash_sha256"),
        "dataset_resource_id": str(_row_value(row, "dataset_resource_id")) if _row_value(row, "dataset_resource_id") else None,
        "dataset_filename": _row_value(row, "dataset_filename"),
        "dataset_size_bytes": _row_value(row, "dataset_size_bytes"),
        "dataset_hash_sha256": _row_value(row, "dataset_hash_sha256"),
        "task_spec": json_value("task_spec", {}),
        "missing_inputs": json_value("missing_inputs", []),
        "status": _row_value(row, "status", "awaiting_user_confirmation"),
        "confirmed_task_id": str(_row_value(row, "confirmed_task_id")) if _row_value(row, "confirmed_task_id") else None,
        "created_at": iso("created_at"),
        "updated_at": iso("updated_at"),
        "expires_at": iso("expires_at"),
    }


async def get_task_draft(pool, draft_id: str, owner_user_id: str) -> Optional[Dict[str, Any]]:
    query = """
        SELECT draft_id, session_id, project_id, owner_user_id, revision, title,
               goal_summary, method_path, method_filename, method_preview,
               method_size_bytes, method_hash_sha256, dataset_resource_id,
               dataset_filename, dataset_size_bytes, dataset_hash_sha256,
               task_spec, missing_inputs, status, confirmed_task_id,
               created_at, updated_at, expires_at
        FROM task_drafts
        WHERE draft_id = $1::uuid AND owner_user_id = $2 AND expires_at > NOW()
    """
    async with pool.acquire() as conn:
        row = await conn.fetchrow(query, draft_id, owner_user_id)
    return _task_draft_row(row) if row else None


async def update_task_draft_inputs(
    pool,
    draft_id: str,
    owner_user_id: str,
    *,
    method_path: Optional[str] = None,
    method_filename: Optional[str] = None,
    method_preview: Optional[str] = None,
    method_size_bytes: Optional[int] = None,
    method_hash_sha256: Optional[str] = None,
    dataset_resource_id: Optional[str] = None,
    dataset_filename: Optional[str] = None,
    dataset_size_bytes: Optional[int] = None,
    dataset_hash_sha256: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    query = """
        UPDATE task_drafts
        SET revision = revision + 1,
            method_path = COALESCE($3, method_path),
            method_filename = COALESCE($4, method_filename),
            method_preview = COALESCE($5, method_preview),
            method_size_bytes = COALESCE($6, method_size_bytes),
            method_hash_sha256 = COALESCE($7, method_hash_sha256),
            dataset_resource_id = COALESCE(NULLIF($8, '')::uuid, dataset_resource_id),
            dataset_filename = COALESCE($9, dataset_filename),
            dataset_size_bytes = COALESCE($10, dataset_size_bytes),
            dataset_hash_sha256 = COALESCE($11, dataset_hash_sha256),
            status = 'awaiting_user_confirmation',
            updated_at = NOW()
        WHERE draft_id = $1::uuid AND owner_user_id = $2
          AND status IN ('draft', 'awaiting_user_confirmation', 'revising')
          AND expires_at > NOW()
        RETURNING draft_id, session_id, project_id, owner_user_id, revision, title,
                  goal_summary, method_path, method_filename, method_preview,
                  method_size_bytes, method_hash_sha256, dataset_resource_id,
                  dataset_filename, dataset_size_bytes, dataset_hash_sha256,
                  task_spec, missing_inputs, status, confirmed_task_id,
                  created_at, updated_at, expires_at
    """
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            query, draft_id, owner_user_id, method_path, method_filename,
            method_preview, method_size_bytes, method_hash_sha256,
            dataset_resource_id or "", dataset_filename, dataset_size_bytes,
            dataset_hash_sha256,
        )
    return _task_draft_row(row) if row else None


async def cancel_task_draft(pool, draft_id: str, owner_user_id: str) -> bool:
    query = """
        UPDATE task_drafts
        SET status = 'cancelled', updated_at = NOW()
        WHERE draft_id = $1::uuid AND owner_user_id = $2
          AND status IN ('draft', 'awaiting_user_confirmation', 'revising')
    """
    async with pool.acquire() as conn:
        result = await conn.execute(query, draft_id, owner_user_id)
    return result.endswith("1")
