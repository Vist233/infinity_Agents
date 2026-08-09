-- Bind tasks created from an inline chat confirmation to that confirmation.
-- The partial unique index prevents one confirmation card from producing two
-- queued tasks while preserving direct Task Center submissions (NULL values).
ALTER TABLE tasks ADD COLUMN chat_confirmation_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_chat_confirmation
  ON tasks(chat_confirmation_id)
  WHERE chat_confirmation_id IS NOT NULL;

-- The browser may retry a chat POST after a dropped stream. Keep the request
-- identity server-side so a retry can replay the pending card instead of
-- consuming quota and creating another model turn.
CREATE TABLE IF NOT EXISTS chat_request_idempotency (
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  client_request_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('processing', 'confirmation', 'completed')),
  confirmation_id TEXT,
  response_text TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, client_request_id),
  FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_chat_request_idempotency_session
  ON chat_request_idempotency(user_id, session_id, updated_at DESC);
