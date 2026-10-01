-- Treehouse CRM. Run ONCE in its own D1 database (CRM_DB), never in APP_DB or the points
-- database. Pseudonymous by design: customers are known only by their GrowFlow record ID.
-- No names, phone numbers, emails, addresses, license numbers or full birth dates are stored;
-- names are looked up live from GrowFlow for display and never saved.

-- One row per GrowFlow customer seen in purchase history.
CREATE TABLE IF NOT EXISTS crm_customers (
  id TEXT PRIMARY KEY,                 -- GrowFlow customer objectId
  first_seen INTEGER NOT NULL,         -- first completed order (ms)
  last_visit INTEGER,                  -- latest completed order (ms); kept after line detail expires
  birth_month INTEGER,                 -- 1-12 only, for birthday segments
  customer_type TEXT,                  -- Medical / Recreational
  points REAL,                         -- latest loyalty balance from GrowFlow
  app_linked INTEGER NOT NULL DEFAULT 0, -- has a linked My Treehouse account
  app_push INTEGER NOT NULL DEFAULT 0,   -- has a device subscribed to notifications
  updated_at INTEGER NOT NULL
);

-- Completed orders, as lean facts. No items, staff, payments or notes.
CREATE TABLE IF NOT EXISTS crm_orders (
  id TEXT PRIMARY KEY,                 -- GrowFlow order objectId
  customer_id TEXT NOT NULL,
  completed_at INTEGER NOT NULL,       -- ms
  total_cents INTEGER NOT NULL,
  is_preorder INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS crm_orders_customer ON crm_orders(customer_id, completed_at);
CREATE INDEX IF NOT EXISTS crm_orders_completed ON crm_orders(completed_at);

-- Purchase lines: date, category group, brand, amount, returned. No product names or packages.
CREATE TABLE IF NOT EXISTS crm_lines (
  id TEXT PRIMARY KEY,                 -- GrowFlow order item objectId
  customer_id TEXT NOT NULL,
  sold_at INTEGER NOT NULL,            -- ms
  category_group TEXT NOT NULL,        -- flower, concentrate, edible, topical, seed, clone, other
  category_id TEXT,
  brand_id TEXT,
  net_cents INTEGER NOT NULL,
  returned INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS crm_lines_customer ON crm_lines(customer_id, sold_at);
CREATE INDEX IF NOT EXISTS crm_lines_group ON crm_lines(category_group, sold_at);
CREATE INDEX IF NOT EXISTS crm_lines_brand ON crm_lines(brand_id, sold_at);

-- Display names for brands and categories (business data, not personal data).
CREATE TABLE IF NOT EXISTS crm_brands (id TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS crm_categories (id TEXT PRIMARY KEY, name TEXT NOT NULL, category_group TEXT NOT NULL);

-- Incremental sync position per GrowFlow source.
CREATE TABLE IF NOT EXISTS crm_sync_state (
  source TEXT PRIMARY KEY,             -- orders, lines, customers
  since TEXT NOT NULL,                 -- updatedAt (ISO) of the last record processed
  last_id TEXT NOT NULL DEFAULT '',    -- objectId of that record; resume strictly after (since, last_id)
  caught_up_at INTEGER,                -- last time this source reached the present
  updated_at INTEGER NOT NULL
);

-- Saved segment definitions (rules only, never customer lists).
CREATE TABLE IF NOT EXISTS crm_segments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  definition TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Who did what, when. Details hold segment rules and counts, never customer data.
CREATE TABLE IF NOT EXISTS crm_audit (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS crm_audit_at ON crm_audit(at);

-- Request counters for the CRM's own GrowFlow budget.
CREATE TABLE IF NOT EXISTS crm_limits (key TEXT PRIMARY KEY, hits INTEGER NOT NULL, expires_at INTEGER NOT NULL);
