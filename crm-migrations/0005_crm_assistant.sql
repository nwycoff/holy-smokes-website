-- Run in CRM_DB after 0004.
-- Campaign assistant: its runs (with cost), the suggestions it makes for people to approve or
-- dismiss, its notes on what has worked, and small bits of state (e.g. menu items it has seen).
-- It sees totals only; nothing here identifies a customer.
CREATE TABLE IF NOT EXISTS crm_assistant_runs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  trigger TEXT NOT NULL,
  requested_by TEXT,
  model TEXT,
  status TEXT NOT NULL,
  summary TEXT,
  cost_micro INTEGER NOT NULL DEFAULT 0,
  turns INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS crm_assistant_runs_created ON crm_assistant_runs(created_at);
CREATE TABLE IF NOT EXISTS crm_suggestions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  reasoning TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL,
  decided_by TEXT,
  decided_at INTEGER,
  decision_note TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS crm_suggestions_status ON crm_suggestions(status, created_at);
CREATE TABLE IF NOT EXISTS crm_assistant_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  run_id TEXT,
  text TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS crm_assistant_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
