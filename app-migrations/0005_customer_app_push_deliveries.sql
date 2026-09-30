-- Run in APP_DB after 0003 (0004 is the staff enrollment migration). Not in the live points database.
-- One row per (order, device): whether its "ready" notification is being sent, was
-- accepted by the push service, failed (and when it may be retried), or the device is gone.
CREATE TABLE IF NOT EXISTS app_push_deliveries (
  preorder_id TEXT NOT NULL REFERENCES app_preorders(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL,
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  retry_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (preorder_id, endpoint)
);
