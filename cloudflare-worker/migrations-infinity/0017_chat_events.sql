-- PAPER-02: canonical conversation event ledger.
-- This migration is additive and safe to re-run. New chat writers are cut over
-- in a later card; the legacy text table remains readable during migration.

CREATE TABLE IF NOT EXISTS chat_events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL CHECK (length(turn_id) BETWEEN 1 AND 255),
  event_type TEXT NOT NULL CHECK (event_type IN (
    'user_message', 'assistant_message', 'tool_call', 'tool_result',
    'system_status', 'error'
  )),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool', 'system')),
  content TEXT CHECK (content IS NULL OR length(content) <= 32768),
  tool_call_id TEXT CHECK (tool_call_id IS NULL OR length(tool_call_id) <= 255),
  tool_name TEXT CHECK (tool_name IS NULL OR length(tool_name) <= 128),
  tool_arguments_json TEXT CHECK (tool_arguments_json IS NULL OR length(tool_arguments_json) <= 16384),
  result_summary TEXT CHECK (result_summary IS NULL OR length(result_summary) <= 4096),
  result_object_key TEXT CHECK (result_object_key IS NULL OR length(result_object_key) <= 512),
  result_sha256 TEXT CHECK (result_sha256 IS NULL OR length(result_sha256) = 64),
  result_bytes INTEGER CHECK (result_bytes IS NULL OR (result_bytes >= 0 AND result_bytes <= 2147483648)),
  status TEXT CHECK (status IS NULL OR length(status) <= 32),
  created_at INTEGER NOT NULL,
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

CREATE INDEX IF NOT EXISTS idx_chat_events_session_event
  ON chat_events(session_id, event_id);
CREATE INDEX IF NOT EXISTS idx_chat_events_turn
  ON chat_events(session_id, turn_id, event_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_events_tool_call
  ON chat_events(session_id, tool_call_id)
  WHERE event_type = 'tool_call' AND tool_call_id IS NOT NULL;

-- Legacy rows have text only. Give them stable identities and an explicit
-- marker; do not manufacture historical tool calls or results.
INSERT INTO chat_events (session_id, turn_id, event_type, role, content, status, created_at)
SELECT
  m.session_id,
  'legacy:' || CAST(m.id AS TEXT),
  CASE m.role WHEN 'user' THEN 'user_message' ELSE 'assistant_message' END,
  m.role,
  m.content,
  'legacy',
  m.created_at
FROM chat_messages AS m
WHERE m.role IN ('user', 'assistant')
  AND NOT EXISTS (
    SELECT 1
    FROM chat_events AS e
    WHERE e.session_id = m.session_id
      AND e.turn_id = 'legacy:' || CAST(m.id AS TEXT)
  );
