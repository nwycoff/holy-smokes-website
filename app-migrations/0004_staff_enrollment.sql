-- Run once in the customer app's APP_DB, not the public points database.
CREATE TABLE IF NOT EXISTS app_staff_matches (
  ticket_hash TEXT PRIMARY KEY,
  staff_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS app_staff_matches_expiry ON app_staff_matches(expires_at);
-- Restricted staff audit: no patient license number, submitted name, or plaintext code.
-- Customer record ID is retained for owner investigations; never returned to the browser.
CREATE TABLE IF NOT EXISTS app_staff_audit (
  id TEXT PRIMARY KEY,
  staff_id TEXT NOT NULL,
  staff_email TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  event TEXT NOT NULL CHECK(event = 'code_issued'),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS app_staff_audit_created ON app_staff_audit(created_at);
