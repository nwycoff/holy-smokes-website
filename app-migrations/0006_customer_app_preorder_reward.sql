-- Run ONCE in APP_DB after 0005 (ALTER TABLE cannot be repeated). Not in the live points database.
-- The name of the loyalty reward a customer asked to use (e.g. "500 Points - $25 Off"), shown
-- back to them. Staff apply the reward at checkout; no points or discounts are stored here.
ALTER TABLE app_preorders ADD COLUMN reward_name TEXT;
