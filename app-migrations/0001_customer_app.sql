-- Use a NEW D1 database bound as APP_DB. Do not run in the live points database.
CREATE TABLE IF NOT EXISTS app_users (
  id TEXT PRIMARY KEY,
  identity_hash TEXT NOT NULL UNIQUE,
  customer_id TEXT UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS app_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS app_sessions_expiry ON app_sessions(expires_at);
CREATE TABLE IF NOT EXISTS app_logins (
  state_hash TEXT PRIMARY KEY,
  verifier TEXT NOT NULL,
  nonce TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS app_enrollments (
  code_hash TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS app_cache (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS app_locks (
  key TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
-- Same audited atomic counter implementation as the points service; separate DB.
CREATE TABLE IF NOT EXISTS rewards_limits (
  key TEXT PRIMARY KEY, hits INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS rewards_limits_expiry ON rewards_limits(expires_at);
CREATE TABLE IF NOT EXISTS rewards_backoff (
  key TEXT PRIMARY KEY, until_at INTEGER NOT NULL
);
