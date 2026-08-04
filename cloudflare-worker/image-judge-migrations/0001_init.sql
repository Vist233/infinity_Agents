-- ImageJudge API Worker D1 初始迁移
-- 用户映射、每日用量、撤销会话、幂等记录（文档 §9.3）

CREATE TABLE IF NOT EXISTS users (
  sub         TEXT PRIMARY KEY,
  email       TEXT,
  name        TEXT,
  created_at  INTEGER NOT NULL
);

-- 每日额度：以 (user_sub, quota_date) 唯一键配合事务原子递增（文档 §9.2）
CREATE TABLE IF NOT EXISTS usage_daily (
  user_sub        TEXT NOT NULL,
  quota_date      TEXT NOT NULL,           -- UTC 日期 yyyy-mm-dd
  accepted_count  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_sub, quota_date)
);

-- 平台代理会话（refresh token）；可撤销、可轮换
CREATE TABLE IF NOT EXISTS sessions (
  jti         TEXT PRIMARY KEY,
  user_sub    TEXT NOT NULL,
  issued_at   INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  revoked     INTEGER NOT NULL DEFAULT 0,
  replaced_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_sub);

-- 短期幂等记录（也可放 KV；此处保留 D1 侧审计）
CREATE TABLE IF NOT EXISTS idempotency (
  client_request_id TEXT NOT NULL,
  user_sub          TEXT NOT NULL,
  server_request_id TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  PRIMARY KEY (user_sub, client_request_id)
);
