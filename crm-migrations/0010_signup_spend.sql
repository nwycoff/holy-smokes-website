-- CRM_DB only. Business expenses for source reporting; no customer data.
CREATE TABLE IF NOT EXISTS crm_signup_spend (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  spent_at INTEGER NOT NULL,
  cents INTEGER NOT NULL CHECK (cents > 0 AND cents <= 1000000),
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS crm_signup_spend_date ON crm_signup_spend(spent_at);
