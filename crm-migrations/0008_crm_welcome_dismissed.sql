-- Run ONCE in CRM_DB after 0007 (ALTER TABLE cannot be repeated).
-- When the customer removed their welcome-gift code from the app after using it.
ALTER TABLE crm_welcome_gifts ADD COLUMN dismissed_at INTEGER;
