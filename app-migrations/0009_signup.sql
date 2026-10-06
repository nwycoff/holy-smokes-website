-- APP_DB only. No GrowFlow writes, patient identifiers, emails or passwords.
CREATE TABLE IF NOT EXISTS app_signup_visits (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  user_id TEXT UNIQUE REFERENCES app_users(id) ON DELETE CASCADE,
  verified_at INTEGER,
  linked_at INTEGER,
  reachable_at INTEGER
);
CREATE INDEX IF NOT EXISTS app_signup_visits_created ON app_signup_visits(created_at);
CREATE TABLE IF NOT EXISTS app_signup_logins (
  state_hash TEXT PRIMARY KEY REFERENCES app_logins(state_hash) ON DELETE CASCADE,
  visit_id TEXT NOT NULL REFERENCES app_signup_visits(id) ON DELETE CASCADE
);
-- A short-lived proof of a signed, unverified Auth0 login. Never an app session.
CREATE TABLE IF NOT EXISTS app_email_verifications (
  token_hash TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS app_email_verifications_expiry ON app_email_verifications(expires_at);
