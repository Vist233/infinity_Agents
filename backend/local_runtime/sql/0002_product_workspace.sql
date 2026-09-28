-- Product parity layer for the pure-local runtime.
--
-- This is the PostgreSQL translation of the final Paper Workspace and
-- Discovery contracts.  D1/R2 identifiers are retained only as API concepts:
-- PostgreSQL owns metadata and LocalObjectStore owns bytes under validated
-- object keys.  All timestamps are database timestamps so recovery is not
-- dependent on a browser or processor clock.

ALTER TABLE infinity_runtime.tasks
    ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE infinity_runtime.tasks
    ADD COLUMN IF NOT EXISTS retry_override_used BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE infinity_runtime.tasks
    ADD COLUMN IF NOT EXISTS retry_reason TEXT;
ALTER TABLE infinity_runtime.tasks
    ADD COLUMN IF NOT EXISTS retry_requested_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS tasks_retry_queue
    ON infinity_runtime.tasks(next_attempt_at, priority DESC, created_at)
    WHERE status = 'queued';

CREATE TABLE IF NOT EXISTS infinity_runtime.chat_sessions (
    session_id UUID PRIMARY KEY,
    user_id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT 'New chat',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS chat_sessions_user_updated
    ON infinity_runtime.chat_sessions(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS infinity_runtime.chat_events (
    event_id BIGSERIAL PRIMARY KEY,
    session_id UUID NOT NULL REFERENCES infinity_runtime.chat_sessions(session_id) ON DELETE CASCADE,
    turn_id TEXT NOT NULL CHECK (length(turn_id) BETWEEN 1 AND 255),
    event_type TEXT NOT NULL CHECK (event_type IN (
        'user_message', 'assistant_message', 'tool_call', 'tool_result',
        'system_status', 'error'
    )),
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool', 'system')),
    content TEXT CHECK (content IS NULL OR octet_length(content) <= 32768),
    tool_call_id TEXT CHECK (tool_call_id IS NULL OR octet_length(tool_call_id) <= 255),
    tool_name TEXT CHECK (tool_name IS NULL OR octet_length(tool_name) <= 128),
    tool_arguments_json TEXT CHECK (tool_arguments_json IS NULL OR octet_length(tool_arguments_json) <= 16384),
    result_summary TEXT CHECK (result_summary IS NULL OR octet_length(result_summary) <= 4096),
    result_object_key TEXT CHECK (result_object_key IS NULL OR octet_length(result_object_key) <= 512),
    result_sha256 CHAR(64) CHECK (result_sha256 IS NULL OR result_sha256 ~ '^[0-9a-f]{64}$'),
    result_bytes BIGINT CHECK (result_bytes IS NULL OR (result_bytes >= 0 AND result_bytes <= 2147483648)),
    status TEXT CHECK (status IS NULL OR length(status) <= 32),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (
        (event_type = 'user_message' AND role = 'user') OR
        (event_type = 'assistant_message' AND role = 'assistant') OR
        (event_type = 'tool_call' AND role = 'assistant') OR
        (event_type = 'tool_result' AND role = 'tool') OR
        (event_type = 'system_status' AND role = 'system') OR
        (event_type = 'error' AND role = 'system')
    ),
    CHECK (event_type NOT IN ('tool_call', 'tool_result') OR tool_call_id IS NOT NULL),
    CHECK (event_type <> 'tool_call' OR tool_name IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS chat_events_session_event
    ON infinity_runtime.chat_events(session_id, event_id);
CREATE INDEX IF NOT EXISTS chat_events_session_turn
    ON infinity_runtime.chat_events(session_id, turn_id, event_id);
CREATE UNIQUE INDEX IF NOT EXISTS chat_events_tool_call
    ON infinity_runtime.chat_events(session_id, tool_call_id)
    WHERE event_type = 'tool_call' AND tool_call_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS infinity_runtime.chat_task_confirmations (
    confirmation_id UUID PRIMARY KEY,
    session_id UUID NOT NULL REFERENCES infinity_runtime.chat_sessions(session_id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    tool_call_id TEXT NOT NULL,
    tool_args_json JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'completed', 'expired', 'cancelled')),
    task_id UUID REFERENCES infinity_runtime.tasks(task_id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS chat_confirmations_user_status
    ON infinity_runtime.chat_task_confirmations(user_id, status, expires_at);

CREATE TABLE IF NOT EXISTS infinity_runtime.chat_request_idempotency (
    user_id TEXT NOT NULL,
    session_id UUID NOT NULL REFERENCES infinity_runtime.chat_sessions(session_id) ON DELETE CASCADE,
    client_request_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('processing', 'confirmation', 'completed')),
    confirmation_id UUID REFERENCES infinity_runtime.chat_task_confirmations(confirmation_id) ON DELETE SET NULL,
    response_text TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, session_id, client_request_id)
);

CREATE TABLE IF NOT EXISTS infinity_runtime.paper_resources (
    resource_id UUID PRIMARY KEY,
    session_id UUID NOT NULL REFERENCES infinity_runtime.chat_sessions(session_id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    source_kind TEXT NOT NULL CHECK (source_kind IN ('arxiv', 'pubmed_pmc', 'user_upload', 'approved_url')),
    source_ref TEXT NOT NULL CHECK (length(source_ref) BETWEEN 1 AND 512),
    canonical_ref TEXT CHECK (canonical_ref IS NULL OR length(canonical_ref) BETWEEN 1 AND 512),
    title TEXT CHECK (title IS NULL OR length(title) <= 512),
    status TEXT NOT NULL DEFAULT 'requested'
        CHECK (status IN ('requested', 'downloading', 'extracting', 'uploading', 'ready', 'failed', 'deleted', 'cancelled')),
    source_sha256 CHAR(64) CHECK (source_sha256 IS NULL OR source_sha256 ~ '^[0-9a-f]{64}$'),
    pdf_object_key TEXT CHECK (pdf_object_key IS NULL OR length(pdf_object_key) <= 512),
    pdf_size_bytes BIGINT CHECK (pdf_size_bytes IS NULL OR (pdf_size_bytes >= 0 AND pdf_size_bytes <= 2147483648)),
    pdf_sha256 CHAR(64) CHECK (pdf_sha256 IS NULL OR pdf_sha256 ~ '^[0-9a-f]{64}$'),
    text_manifest_key TEXT CHECK (text_manifest_key IS NULL OR length(text_manifest_key) <= 512),
    image_manifest_key TEXT CHECK (image_manifest_key IS NULL OR length(image_manifest_key) <= 512),
    page_count INTEGER CHECK (page_count IS NULL OR (page_count >= 0 AND page_count <= 10000)),
    image_count INTEGER CHECK (image_count IS NULL OR (image_count >= 0 AND image_count <= 100000)),
    error_code TEXT CHECK (error_code IS NULL OR length(error_code) <= 128),
    error_message_safe TEXT CHECK (error_message_safe IS NULL OR length(error_message_safe) <= 1024),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ready_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS paper_resources_user_status
    ON infinity_runtime.paper_resources(user_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS paper_resources_session_updated
    ON infinity_runtime.paper_resources(session_id, updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS paper_resources_user_source_sha
    ON infinity_runtime.paper_resources(user_id, source_sha256)
    WHERE source_sha256 IS NOT NULL AND status <> 'deleted';

CREATE TABLE IF NOT EXISTS infinity_runtime.paper_processing_attempts (
    attempt_id UUID PRIMARY KEY,
    resource_id UUID NOT NULL REFERENCES infinity_runtime.paper_resources(resource_id) ON DELETE CASCADE,
    processor_id TEXT NOT NULL CHECK (length(processor_id) BETWEEN 1 AND 255),
    lease_token_hash CHAR(64) NOT NULL CHECK (lease_token_hash ~ '^[0-9a-f]{64}$'),
    fencing_epoch BIGINT NOT NULL CHECK (fencing_epoch > 0),
    status TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'claimed', 'downloading', 'extracting', 'uploading', 'succeeded', 'failed', 'expired', 'cancelled')),
    started_at TIMESTAMPTZ,
    lease_expires_at TIMESTAMPTZ NOT NULL,
    finished_at TIMESTAMPTZ,
    error_code TEXT,
    error_message_safe TEXT,
    UNIQUE (resource_id, fencing_epoch)
);
CREATE UNIQUE INDEX IF NOT EXISTS paper_attempt_one_active
    ON infinity_runtime.paper_processing_attempts(resource_id)
    WHERE status IN ('claimed', 'downloading', 'extracting', 'uploading');
CREATE UNIQUE INDEX IF NOT EXISTS paper_processor_one_active
    ON infinity_runtime.paper_processing_attempts(processor_id)
    WHERE status IN ('claimed', 'downloading', 'extracting', 'uploading');
CREATE INDEX IF NOT EXISTS paper_attempts_resource_status
    ON infinity_runtime.paper_processing_attempts(resource_id, status, fencing_epoch DESC);

CREATE TABLE IF NOT EXISTS infinity_runtime.paper_resource_links (
    session_id UUID NOT NULL REFERENCES infinity_runtime.chat_sessions(session_id) ON DELETE CASCADE,
    resource_id UUID NOT NULL REFERENCES infinity_runtime.paper_resources(resource_id) ON DELETE CASCADE,
    purpose TEXT NOT NULL CHECK (purpose IN ('search_result', 'read', 'upload')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (session_id, resource_id, purpose)
);

CREATE TABLE IF NOT EXISTS infinity_runtime.paper_processor_sessions (
    processor_session_id UUID PRIMARY KEY,
    processor_id TEXT NOT NULL,
    instance_id TEXT NOT NULL,
    session_token_hash CHAR(64) NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS paper_processor_sessions_active
    ON infinity_runtime.paper_processor_sessions(processor_id, expires_at)
    WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS infinity_runtime.paper_processor_objects (
    resource_id UUID NOT NULL REFERENCES infinity_runtime.paper_resources(resource_id) ON DELETE CASCADE,
    attempt_id UUID NOT NULL REFERENCES infinity_runtime.paper_processing_attempts(attempt_id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('text_pages', 'image')),
    object_id TEXT NOT NULL CHECK (length(object_id) BETWEEN 1 AND 255),
    object_key TEXT NOT NULL,
    size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0 AND size_bytes <= 2147483648),
    sha256 CHAR(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    content_type TEXT NOT NULL CHECK (length(content_type) <= 128),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (resource_id, kind, object_id)
);
CREATE INDEX IF NOT EXISTS paper_processor_objects_attempt
    ON infinity_runtime.paper_processor_objects(attempt_id, kind);

CREATE TABLE IF NOT EXISTS infinity_runtime.paper_resource_audit_events (
    event_id UUID PRIMARY KEY,
    resource_id UUID NOT NULL REFERENCES infinity_runtime.paper_resources(resource_id) ON DELETE CASCADE,
    attempt_id UUID REFERENCES infinity_runtime.paper_processing_attempts(attempt_id) ON DELETE SET NULL,
    stage TEXT NOT NULL CHECK (stage IN ('materialize', 'download', 'extraction', 'upload', 'image_analysis', 'cancel', 'delete', 'cleanup')),
    outcome TEXT NOT NULL CHECK (outcome IN ('started', 'succeeded', 'failed', 'denied', 'cancelled')),
    error_code TEXT,
    metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS paper_audit_resource_created
    ON infinity_runtime.paper_resource_audit_events(resource_id, created_at DESC);

CREATE TABLE IF NOT EXISTS infinity_runtime.paper_cleanup_jobs (
    cleanup_id UUID PRIMARY KEY,
    resource_id UUID NOT NULL UNIQUE REFERENCES infinity_runtime.paper_resources(resource_id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0 AND attempts <= 100),
    next_attempt_at TIMESTAMPTZ NOT NULL,
    last_error_code TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS infinity_runtime.paper_request_continuations (
    continuation_id UUID PRIMARY KEY,
    session_id UUID NOT NULL REFERENCES infinity_runtime.chat_sessions(session_id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    turn_id TEXT NOT NULL CHECK (length(turn_id) BETWEEN 1 AND 255),
    client_request_id TEXT,
    resource_id UUID NOT NULL REFERENCES infinity_runtime.paper_resources(resource_id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'waiting'
        CHECK (status IN ('waiting', 'ready', 'running', 'completed', 'failed', 'cancelled', 'expired')),
    active_turn_id TEXT,
    lease_expires_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ NOT NULL,
    last_error_code TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    UNIQUE (session_id, turn_id, resource_id)
);
CREATE INDEX IF NOT EXISTS paper_continuations_owner_status
    ON infinity_runtime.paper_request_continuations(user_id, session_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS paper_continuations_resource_status
    ON infinity_runtime.paper_request_continuations(resource_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS infinity_runtime.paper_catalog (
    paper_id UUID PRIMARY KEY,
    owner_user_id TEXT NOT NULL,
    source_resource_id UUID NOT NULL UNIQUE REFERENCES infinity_runtime.paper_resources(resource_id) ON DELETE RESTRICT,
    visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'public')),
    title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 512),
    authors_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    year INTEGER CHECK (year IS NULL OR (year >= 1800 AND year <= 2200)),
    venue TEXT,
    status TEXT NOT NULL DEFAULT 'requested'
        CHECK (status IN ('requested', 'processing', 'profiled', 'failed', 'deleted')),
    spam_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (spam_status IN ('pending', 'scientific_paper', 'non_paper', 'spam', 'invalid', 'review')),
    profile_version TEXT,
    profile_json JSONB,
    profile_sha256 CHAR(64),
    profile_object_key TEXT,
    overview_object_key TEXT,
    discovery_lease_owner TEXT,
    discovery_lease_expires_at TIMESTAMPTZ,
    discovery_lease_token_hash CHAR(64),
    discovery_fencing_epoch BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS paper_catalog_owner_status
    ON infinity_runtime.paper_catalog(owner_user_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS infinity_runtime.paper_capabilities (
    paper_id UUID NOT NULL REFERENCES infinity_runtime.paper_catalog(paper_id) ON DELETE CASCADE,
    analysis_id TEXT NOT NULL,
    capability_key TEXT NOT NULL,
    requirement TEXT NOT NULL DEFAULT 'required' CHECK (requirement IN ('required', 'optional')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (paper_id, analysis_id, capability_key, requirement)
);

CREATE TABLE IF NOT EXISTS infinity_runtime.data_collections (
    collection_id UUID PRIMARY KEY,
    owner_user_id TEXT NOT NULL,
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 255),
    source_object_key TEXT NOT NULL UNIQUE,
    source_filename TEXT NOT NULL CHECK (length(source_filename) BETWEEN 1 AND 255),
    source_content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
    source_sha256 CHAR(64) NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
    source_size_bytes BIGINT NOT NULL CHECK (source_size_bytes > 0 AND source_size_bytes <= 26214400),
    status TEXT NOT NULL DEFAULT 'uploaded' CHECK (status IN ('uploaded', 'inspecting', 'ready', 'failed', 'deleted')),
    profile_version TEXT,
    profile_json JSONB,
    profile_sha256 CHAR(64),
    profile_object_key TEXT,
    error_code TEXT,
    error_message_safe TEXT,
    discovery_lease_owner TEXT,
    discovery_lease_expires_at TIMESTAMPTZ,
    discovery_lease_token_hash CHAR(64),
    discovery_fencing_epoch BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS data_collections_owner_status
    ON infinity_runtime.data_collections(owner_user_id, status, updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS data_collections_owner_sha_active
    ON infinity_runtime.data_collections(owner_user_id, source_sha256)
    WHERE status <> 'deleted';

CREATE TABLE IF NOT EXISTS infinity_runtime.dataset_capabilities (
    collection_id UUID NOT NULL REFERENCES infinity_runtime.data_collections(collection_id) ON DELETE CASCADE,
    capability_key TEXT NOT NULL,
    capability_value TEXT NOT NULL DEFAULT 'true',
    confidence INTEGER NOT NULL DEFAULT 100 CHECK (confidence BETWEEN 0 AND 100),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (collection_id, capability_key)
);

CREATE TABLE IF NOT EXISTS infinity_runtime.research_matches (
    match_id UUID PRIMARY KEY,
    paper_id UUID NOT NULL REFERENCES infinity_runtime.paper_catalog(paper_id) ON DELETE CASCADE,
    collection_id UUID NOT NULL REFERENCES infinity_runtime.data_collections(collection_id) ON DELETE CASCADE,
    paper_profile_version TEXT NOT NULL,
    dataset_profile_version TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'candidate'
        CHECK (status IN ('candidate', 'evaluating', 'evaluated', 'review', 'rejected', 'task_created', 'failed')),
    hard_gate TEXT NOT NULL DEFAULT 'pending' CHECK (hard_gate IN ('pending', 'pass', 'fail', 'review')),
    coverage_ratio DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (coverage_ratio >= 0 AND coverage_ratio <= 1),
    execution_confidence INTEGER CHECK (execution_confidence IS NULL OR execution_confidence BETWEEN 0 AND 100),
    scientific_fit INTEGER CHECK (scientific_fit IS NULL OR scientific_fit BETWEEN 0 AND 100),
    evaluator_version TEXT,
    evaluation_json JSONB,
    evaluation_object_key TEXT,
    created_task_id UUID REFERENCES infinity_runtime.tasks(task_id) ON DELETE SET NULL,
    candidate_reason TEXT,
    discovery_lease_owner TEXT,
    discovery_lease_expires_at TIMESTAMPTZ,
    discovery_lease_token_hash CHAR(64),
    discovery_fencing_epoch BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (paper_id, collection_id, paper_profile_version, dataset_profile_version)
);
CREATE INDEX IF NOT EXISTS research_matches_paper
    ON infinity_runtime.research_matches(paper_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS research_matches_collection
    ON infinity_runtime.research_matches(collection_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS infinity_runtime.discovery_processor_sessions (
    processor_session_id UUID PRIMARY KEY,
    processor_id TEXT NOT NULL,
    instance_id TEXT NOT NULL,
    session_token_hash CHAR(64) NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS infinity_runtime.literature_watch_state (
    source TEXT NOT NULL,
    query TEXT NOT NULL,
    last_cursor TEXT,
    last_checked_at TIMESTAMPTZ,
    lease_owner TEXT,
    lease_expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (source, query)
);
CREATE TABLE IF NOT EXISTS infinity_runtime.literature_watch_failures (
    failure_id UUID PRIMARY KEY,
    source TEXT NOT NULL,
    query TEXT NOT NULL,
    source_ref TEXT NOT NULL,
    record_json JSONB NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0 AND attempts <= 20),
    next_retry_at TIMESTAMPTZ NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'dead')),
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (source, query, source_ref)
);
CREATE TABLE IF NOT EXISTS infinity_runtime.literature_watch_daily_quota (
    owner_user_id TEXT NOT NULL,
    day_start DATE NOT NULL,
    limit_count INTEGER NOT NULL CHECK (limit_count > 0 AND limit_count <= 500),
    reserved_count INTEGER NOT NULL DEFAULT 0 CHECK (reserved_count >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (owner_user_id, day_start)
);
