-- Run in CRM_DB after 0006.
-- Welcome gift: one code per customer record, issued when they first have Deals & news on with a
-- phone set up, and sent to that phone. The offer itself (on/off, what the gift is, the message,
-- an end date) is stored in crm_assistant_state under the key 'welcome_gift'.
CREATE TABLE IF NOT EXISTS crm_welcome_gifts (
  customer_id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  sent_at INTEGER
);
