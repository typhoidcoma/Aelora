-- Add per-user Google Calendar mapping
-- Each Discord user gets their own secondary Google Calendar (auto-created on first use)
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS google_calendar_id TEXT DEFAULT NULL;
