-- Run ONCE in CRM_DB after 0003 (ALTER TABLE cannot be repeated).
-- Automatic messages: a segment, a message and how often one person may get it. Each day at
-- 11 am Central, people who match (and opted in to the topic) and haven't had it within
-- cooldown_days (0 = only ever once) are sent it as a campaign batch tagged with automation_id.
CREATE TABLE IF NOT EXISTS crm_automations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  topic TEXT NOT NULL,
  body TEXT NOT NULL,
  link TEXT NOT NULL,
  definition TEXT,
  audience_label TEXT NOT NULL,
  holdout_pct INTEGER NOT NULL,
  cooldown_days INTEGER NOT NULL,
  active INTEGER NOT NULL,
  last_run_on TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
ALTER TABLE crm_campaigns ADD COLUMN automation_id TEXT;
CREATE INDEX IF NOT EXISTS crm_campaigns_automation ON crm_campaigns(automation_id, started_at);
