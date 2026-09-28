-- Deliberately stores no customer records, names, patient IDs, or balances.
CREATE TABLE IF NOT EXISTS rewards_limits (
  key TEXT PRIMARY KEY,
  hits INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS rewards_limits_expiry ON rewards_limits(expires_at);

CREATE TABLE IF NOT EXISTS rewards_backoff (
  key TEXT PRIMARY KEY,
  until_at INTEGER NOT NULL
);
