-- Run ONCE in CRM_DB after 0010 (ALTER TABLE cannot be repeated).
-- Which product each sale line was (GrowFlow product ID only), for the app and tablet's
-- "Most popular" sort.
ALTER TABLE crm_lines ADD COLUMN product_id TEXT;
CREATE INDEX IF NOT EXISTS crm_lines_sold_product ON crm_lines(sold_at, product_id);
-- Re-read the last 35 days of sale lines once so recent sales get their product.
UPDATE crm_sync_state SET since = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-35 days'), last_id = '~'
  WHERE source = 'lines' AND since > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-35 days');
