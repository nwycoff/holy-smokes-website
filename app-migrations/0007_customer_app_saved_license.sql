-- Run ONCE in APP_DB after 0006 (ALTER TABLE cannot be repeated). Not in the live points database.
-- Optional, opt-in saved medical license number: AES-256-GCM ciphertext bound to the account
-- (key: APP_LICENSE_KEY secret) and the last four characters shown to the customer.
-- Deleted with the account row when the customer removes their rewards connection.
ALTER TABLE app_users ADD COLUMN license_enc TEXT;
ALTER TABLE app_users ADD COLUMN license_hint TEXT;
