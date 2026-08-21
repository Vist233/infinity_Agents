CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE infinity_runtime.resources (
    resource_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_user_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('method', 'dataset')),
    logical_name TEXT NOT NULL,
    object_key TEXT NOT NULL UNIQUE,
    content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
    file_size_bytes BIGINT NOT NULL CHECK (file_size_bytes BETWEEN 0 AND 26214400),
    checksum_sha256 CHAR(64) NOT NULL CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$'),
    state TEXT NOT NULL DEFAULT 'ready' CHECK (state IN ('staging', 'ready', 'revoked')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE infinity_runtime.task_specs (
    task_spec_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_by TEXT NOT NULL,
    title TEXT NOT NULL,
    goal TEXT NOT NULL,
    execution_document JSONB NOT NULL,
    method_resource_id UUID REFERENCES infinity_runtime.resources(resource_id),
    dataset_resource_id UUID NOT NULL REFERENCES infinity_runtime.resources(resource_id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE infinity_runtime.workers (
    worker_id TEXT PRIMARY KEY,
    created_by TEXT NOT NULL,
    pool_id TEXT NOT NULL DEFAULT 'public-default' CHECK (pool_id = 'public-default'),
    namespace TEXT NOT NULL DEFAULT 'infinity-public' CHECK (namespace = 'infinity-public'),
    credential_hash CHAR(64) NOT NULL CHECK (credential_hash ~ '^[0-9a-f]{64}$'),
    credential_ciphertext TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
    protocol_version TEXT NOT NULL DEFAULT '2' CHECK (protocol_version = '2'),
    runtime_capability TEXT NOT NULL DEFAULT 'goal-driven-claude-code'
        CHECK (runtime_capability = 'goal-driven-claude-code'),
    image_digest TEXT,
    last_seen_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE infinity_runtime.worker_sessions (
    session_id TEXT PRIMARY KEY,
    worker_id TEXT NOT NULL REFERENCES infinity_runtime.workers(worker_id),
    pool_id TEXT NOT NULL CHECK (pool_id = 'public-default'),
    namespace TEXT NOT NULL CHECK (namespace = 'infinity-public'),
    instance_id TEXT NOT NULL,
    protocol_version TEXT NOT NULL CHECK (protocol_version = '2'),
    runtime_capability TEXT NOT NULL CHECK (runtime_capability = 'goal-driven-claude-code'),
    image_digest TEXT,
    session_secret_hash CHAR(64) NOT NULL,
    session_epoch BIGINT NOT NULL CHECK (session_epoch > 0),
    connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    lease_expires_at TIMESTAMPTZ NOT NULL,
    disconnected_at TIMESTAMPTZ,
    UNIQUE (worker_id, session_epoch)
);
CREATE UNIQUE INDEX worker_sessions_one_active
    ON infinity_runtime.worker_sessions(worker_id)
    WHERE disconnected_at IS NULL;
CREATE INDEX worker_sessions_worker_epoch
    ON infinity_runtime.worker_sessions(worker_id, session_epoch DESC);

CREATE TABLE infinity_runtime.tasks (
    task_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_spec_id UUID NOT NULL REFERENCES infinity_runtime.task_specs(task_spec_id),
    created_by TEXT NOT NULL,
    title TEXT NOT NULL,
    execution_pool_id TEXT NOT NULL DEFAULT 'public-default' CHECK (execution_pool_id = 'public-default'),
    status TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'claimed', 'running', 'succeeded', 'failed', 'cancelled', 'timeout')),
    priority INTEGER NOT NULL DEFAULT 0,
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 25),
    active_attempt_id UUID,
    lease_worker_id TEXT REFERENCES infinity_runtime.workers(worker_id),
    lease_epoch BIGINT NOT NULL DEFAULT 0 CHECK (lease_epoch >= 0),
    lease_token_hash CHAR(64),
    lease_expires_at TIMESTAMPTZ,
    cancel_requested_at TIMESTAMPTZ,
    result_artifact_id UUID,
    error_code TEXT,
    error_detail TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ
);
CREATE INDEX tasks_queue
    ON infinity_runtime.tasks(execution_pool_id, priority DESC, created_at)
    WHERE status = 'queued';
CREATE INDEX tasks_owner_created
    ON infinity_runtime.tasks(created_by, created_at DESC);

CREATE TABLE infinity_runtime.task_attempts (
    attempt_id UUID PRIMARY KEY,
    task_id UUID NOT NULL REFERENCES infinity_runtime.tasks(task_id),
    worker_id TEXT NOT NULL REFERENCES infinity_runtime.workers(worker_id),
    session_id TEXT NOT NULL REFERENCES infinity_runtime.worker_sessions(session_id),
    attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
    fencing_epoch BIGINT NOT NULL CHECK (fencing_epoch > 0),
    lease_token_hash CHAR(64) NOT NULL,
    lease_expires_at TIMESTAMPTZ NOT NULL,
    status TEXT NOT NULL DEFAULT 'claimed'
        CHECK (status IN ('claimed', 'running', 'succeeded', 'failed', 'cancelled', 'timeout', 'lost')),
    failure_code TEXT,
    failure_detail TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at TIMESTAMPTZ,
    UNIQUE (task_id, attempt_number)
);
ALTER TABLE infinity_runtime.tasks
    ADD CONSTRAINT tasks_active_attempt_fk
    FOREIGN KEY (active_attempt_id) REFERENCES infinity_runtime.task_attempts(attempt_id);
CREATE INDEX task_attempts_task
    ON infinity_runtime.task_attempts(task_id, attempt_number DESC);

CREATE TABLE infinity_runtime.task_events (
    task_event_id UUID PRIMARY KEY,
    task_id UUID NOT NULL REFERENCES infinity_runtime.tasks(task_id),
    attempt_id UUID REFERENCES infinity_runtime.task_attempts(attempt_id),
    event_type TEXT NOT NULL,
    event_data JSONB NOT NULL DEFAULT '{}'::jsonb,
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX task_events_task_created
    ON infinity_runtime.task_events(task_id, created_at);

CREATE TABLE infinity_runtime.outbox_events (
    event_id UUID PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE,
    aggregate_type TEXT NOT NULL DEFAULT 'task',
    aggregate_id UUID NOT NULL,
    event_type TEXT NOT NULL,
    payload_json JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'publishing', 'published', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    publishing_owner TEXT,
    publishing_expires_at TIMESTAMPTZ,
    published_at TIMESTAMPTZ,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX outbox_pending
    ON infinity_runtime.outbox_events(next_attempt_at, created_at)
    WHERE status IN ('pending', 'publishing');

CREATE TABLE infinity_runtime.artifact_uploads (
    upload_id UUID PRIMARY KEY,
    artifact_id UUID NOT NULL UNIQUE,
    task_id UUID NOT NULL REFERENCES infinity_runtime.tasks(task_id),
    attempt_id UUID NOT NULL REFERENCES infinity_runtime.task_attempts(attempt_id),
    worker_id TEXT NOT NULL REFERENCES infinity_runtime.workers(worker_id),
    object_key TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'result',
    content_type TEXT NOT NULL DEFAULT 'application/zip',
    expected_size_bytes BIGINT NOT NULL CHECK (expected_size_bytes > 0),
    expected_sha256 CHAR(64) NOT NULL CHECK (expected_sha256 ~ '^[0-9a-f]{64}$'),
    part_size_bytes INTEGER NOT NULL CHECK (part_size_bytes > 0),
    part_count INTEGER NOT NULL CHECK (part_count > 0),
    manifest_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'finalizing', 'completed', 'aborted')),
    finalize_owner TEXT,
    finalize_started_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX one_open_upload_per_attempt
    ON infinity_runtime.artifact_uploads(attempt_id)
    WHERE status IN ('open', 'finalizing');

CREATE TABLE infinity_runtime.artifact_upload_parts (
    upload_id UUID NOT NULL REFERENCES infinity_runtime.artifact_uploads(upload_id) ON DELETE CASCADE,
    part_number INTEGER NOT NULL CHECK (part_number > 0),
    object_key TEXT NOT NULL,
    file_size_bytes BIGINT NOT NULL CHECK (file_size_bytes > 0),
    checksum_sha256 CHAR(64) NOT NULL CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (upload_id, part_number)
);

CREATE TABLE infinity_runtime.artifacts (
    artifact_id UUID PRIMARY KEY,
    upload_id UUID NOT NULL UNIQUE REFERENCES infinity_runtime.artifact_uploads(upload_id),
    task_id UUID NOT NULL REFERENCES infinity_runtime.tasks(task_id),
    attempt_id UUID NOT NULL REFERENCES infinity_runtime.task_attempts(attempt_id),
    object_key TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    content_type TEXT NOT NULL,
    file_size_bytes BIGINT NOT NULL CHECK (file_size_bytes > 0),
    checksum_sha256 CHAR(64) NOT NULL CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$'),
    manifest_json JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'published' CHECK (status = 'published'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    published_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE infinity_runtime.tasks
    ADD CONSTRAINT tasks_result_artifact_fk
    FOREIGN KEY (result_artifact_id) REFERENCES infinity_runtime.artifacts(artifact_id);
