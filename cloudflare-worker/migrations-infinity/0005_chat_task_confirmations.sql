-- A model tool call can pause for explicit user input without keeping a
-- Worker request open. The client renders the pending record inline in the
-- conversation, then resumes the same tool loop after task submission.

CREATE TABLE IF NOT EXISTS chat_task_confirmations (
  confirmation_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  tool_args_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'expired')),
  task_id TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE,
  UNIQUE(session_id, tool_call_id)
);

CREATE INDEX IF NOT EXISTS idx_chat_task_confirmations_owner
  ON chat_task_confirmations(user_id, session_id, status, expires_at);
