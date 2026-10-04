-- Run ONCE in CRM_DB after 0008 (ALTER TABLE cannot be repeated).
-- Visit ratings from the app. One row per rated visit (a completed GrowFlow order): stars, an
-- optional message, whether they want a manager to contact them, whether they went on to the
-- Google review link, and whether staff have followed up. crm_feedback_prefs keeps each
-- customer's asking schedule so they're asked sparingly. crm_settings gains a per-person switch
-- for low-rating alerts, and owner alerts say which switch they belong to.
CREATE TABLE IF NOT EXISTS crm_feedback (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  visit_at INTEGER NOT NULL,
  rating INTEGER NOT NULL,
  comment TEXT,
  contact INTEGER NOT NULL DEFAULT 0,
  google_at INTEGER,
  status TEXT NOT NULL DEFAULT 'new',
  handled_by TEXT,
  handled_at INTEGER,
  handled_note TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (customer_id, order_id)
);
CREATE INDEX IF NOT EXISTS crm_feedback_created ON crm_feedback(created_at);
CREATE TABLE IF NOT EXISTS crm_feedback_prefs (
  customer_id TEXT PRIMARY KEY,
  asked_order_id TEXT,
  asked_at INTEGER,
  snooze_until INTEGER,
  opted_out INTEGER NOT NULL DEFAULT 0,
  google_until INTEGER,
  first_push_at INTEGER
);
ALTER TABLE crm_settings ADD COLUMN notify_feedback INTEGER NOT NULL DEFAULT 0;
ALTER TABLE crm_owner_alerts ADD COLUMN audience TEXT NOT NULL DEFAULT 'assistant';
