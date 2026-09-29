-- Run in APP_DB after 0001. Do not run in the live points database.
-- Keeps only what the app needs to show order status and enforce one open order.
-- Line items, names and birth dates are sent to GrowFlow and never stored here.
CREATE TABLE IF NOT EXISTS app_preorders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  order_id TEXT UNIQUE,
  order_number TEXT,
  status TEXT NOT NULL,
  open INTEGER NOT NULL,
  total_cents INTEGER NOT NULL,
  item_count INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  checked_at INTEGER NOT NULL
);
-- At most one open order per app account, enforced by the database.
CREATE UNIQUE INDEX IF NOT EXISTS app_preorders_one_open ON app_preorders(user_id) WHERE open = 1;
CREATE INDEX IF NOT EXISTS app_preorders_user ON app_preorders(user_id, created_at);
