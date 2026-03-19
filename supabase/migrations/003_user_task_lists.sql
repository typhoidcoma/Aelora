-- Add per-user Google Task list mapping
-- Each Discord user gets their own Google Task list (auto-created on first use)
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS google_task_list_id TEXT DEFAULT NULL;
