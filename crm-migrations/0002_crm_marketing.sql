-- Run ONCE in CRM_DB after 0001 (ALTER TABLE cannot be repeated).
-- Whether a customer has opted in to "Deals & news" in the app and has a device to receive it.
ALTER TABLE crm_customers ADD COLUMN app_marketing INTEGER NOT NULL DEFAULT 0;
