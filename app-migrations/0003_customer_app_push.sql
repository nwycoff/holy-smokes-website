-- Run ONCE in APP_DB after 0002 (ALTER TABLE cannot be repeated). Not in the live points database.
-- Order-ready notifications: each device's push subscription, and whether an order's
-- "ready" notification has gone out. Subscriptions hold no names or order details.
ALTER TABLE app_preorders ADD COLUMN notified_ready INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS app_push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS app_push_subscriptions_user ON app_push_subscriptions(user_id, created_at);
