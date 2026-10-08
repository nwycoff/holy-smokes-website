-- Run ONCE in CRM_DB after 0011 (ALTER TABLE cannot be repeated).
-- Day of the month of each customer's birthday (1-31), next to birth_month, so a birthday message
-- can arrive on the day. Still no birth year or full birth date.
ALTER TABLE crm_customers ADD COLUMN birth_day INTEGER;
-- Re-read every customer once so existing records get their birth day.
UPDATE crm_sync_state SET since = '2000-01-01T00:00:00.000Z', last_id = '~' WHERE source = 'customers';
