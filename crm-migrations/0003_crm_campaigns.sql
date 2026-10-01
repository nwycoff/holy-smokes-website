-- Run in CRM_DB after 0002.
-- Deals & news campaigns: the message, its audience rules, and one row per customer (by GrowFlow
-- ID) saying whether they were sent it, held back to measure results, or skipped. Messages hold
-- no customer data. A test send has test_customer_id set and goes only to that record's phones.
CREATE TABLE IF NOT EXISTS crm_campaigns (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  topic TEXT NOT NULL,
  body TEXT NOT NULL,
  link TEXT NOT NULL,
  definition TEXT,
  audience_label TEXT NOT NULL,
  holdout_pct INTEGER NOT NULL,
  test_customer_id TEXT,
  status TEXT NOT NULL,
  send_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS crm_campaigns_due ON crm_campaigns(status, send_at);
CREATE TABLE IF NOT EXISTS crm_campaign_recipients (
  campaign_id TEXT NOT NULL REFERENCES crm_campaigns(id) ON DELETE CASCADE,
  customer_id TEXT NOT NULL,
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER NOT NULL DEFAULT 0,
  sent_at INTEGER,
  PRIMARY KEY (campaign_id, customer_id)
);
CREATE INDEX IF NOT EXISTS crm_campaign_recipients_customer ON crm_campaign_recipients(customer_id, state, sent_at);
-- Per CRM user: which customer record is their own, for test sends to their phone.
CREATE TABLE IF NOT EXISTS crm_settings (
  email TEXT PRIMARY KEY,
  test_customer_id TEXT,
  updated_at INTEGER NOT NULL
);
