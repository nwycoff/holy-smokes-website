-- Run ONCE in CRM_DB after 0005 (ALTER TABLE cannot be repeated).
-- When a customer tapped a campaign notification; whether a CRM user wants the assistant's
-- updates on their phone (their "test phone" record); and those updates, queued for the
-- notifier (which holds the notification key) to send.
ALTER TABLE crm_campaign_recipients ADD COLUMN tapped_at INTEGER;
ALTER TABLE crm_settings ADD COLUMN notify_assistant INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS crm_owner_alerts (
  id TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  sent_at INTEGER
);
