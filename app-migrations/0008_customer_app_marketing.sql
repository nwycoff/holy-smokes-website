-- Run in APP_DB after 0007. Not in the live points database.
-- "Deals & news": marketing notification consent, separate from order-ready alerts.
-- One row per account with the topics chosen ('[]' = off), when it was last turned on and
-- when the customer was last asked, plus a log of every consent change and where it was made.
CREATE TABLE IF NOT EXISTS app_marketing_prefs (
  user_id TEXT PRIMARY KEY REFERENCES app_users(id) ON DELETE CASCADE,
  topics TEXT NOT NULL,
  opted_in_at INTEGER,
  asked_at INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS app_marketing_consent_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  at INTEGER NOT NULL,
  topics TEXT NOT NULL,
  source TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS app_marketing_consent_log_user ON app_marketing_consent_log(user_id, at);
