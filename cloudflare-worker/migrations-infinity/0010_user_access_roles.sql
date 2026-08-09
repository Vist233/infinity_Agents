-- Product-side projection of the verified Zhang Auth role.
-- Worker control requests carry a machine credential, not a browser JWT, so
-- the current role must be available without trusting a Worker-supplied value.
CREATE TABLE IF NOT EXISTS user_access_roles (
  user_id TEXT PRIMARY KEY,
  role TEXT NOT NULL DEFAULT 'user',
  updated_at INTEGER NOT NULL
);
