-- =============================================================================
-- Aelora Scoring System — Database Schema
-- Run this in the Supabase SQL editor to create the scoring tables.
-- =============================================================================

-- User profiles, keyed by Discord snowflake ID
CREATE TABLE IF NOT EXISTS user_profiles (
  discord_user_id      TEXT PRIMARY KEY,
  total_points         INTEGER NOT NULL DEFAULT 0,
  current_streak       INTEGER NOT NULL DEFAULT 0,
  longest_streak       INTEGER NOT NULL DEFAULT 0,
  last_completion_date DATE,
  created_at           TIMESTAMPTZ DEFAULT NOW(),
  updated_at           TIMESTAMPTZ DEFAULT NOW()
);

-- All trackable life events across 5 categories
CREATE TABLE IF NOT EXISTS life_events (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  discord_user_id   TEXT NOT NULL REFERENCES user_profiles(discord_user_id) ON DELETE CASCADE,
  category          TEXT NOT NULL DEFAULT 'tasks'
                    CHECK (category IN ('tasks', 'health', 'finance', 'social', 'work')),
  title             TEXT NOT NULL,
  description       TEXT,
  source            TEXT NOT NULL DEFAULT 'manual'
                    CHECK (source IN ('google_tasks', 'google_calendar', 'manual', 'discord')),
  external_uid      TEXT,       -- Google Task ID or Calendar Event ID for sync
  priority          TEXT NOT NULL DEFAULT 'medium'
                    CHECK (priority IN ('low', 'medium', 'high')),
  due_date          TIMESTAMPTZ,
  completed         BOOLEAN NOT NULL DEFAULT FALSE,
  completed_at      TIMESTAMPTZ,
  -- Scoring metadata
  estimated_minutes INTEGER,
  size_label        TEXT CHECK (size_label IN ('micro', 'small', 'medium', 'large', 'epic')),
  impact_level      TEXT CHECK (impact_level IN ('trivial', 'low', 'moderate', 'high', 'critical')),
  irreversible      BOOLEAN DEFAULT FALSE,
  affects_others    BOOLEAN DEFAULT FALSE,
  smeq_estimate     FLOAT CHECK (smeq_estimate >= 0 AND smeq_estimate <= 150),
  tags              TEXT[],
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (discord_user_id, external_uid)
);

-- Immutable log of every scored completion
CREATE TABLE IF NOT EXISTS scoring_events (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  discord_user_id       TEXT NOT NULL REFERENCES user_profiles(discord_user_id) ON DELETE CASCADE,
  life_event_id         UUID REFERENCES life_events(id) ON DELETE SET NULL,
  score_at_completion   INTEGER NOT NULL CHECK (score_at_completion >= 0 AND score_at_completion <= 100),
  points_awarded        INTEGER NOT NULL DEFAULT 0,
  urgency_component     INTEGER NOT NULL DEFAULT 0,
  impact_component      INTEGER NOT NULL DEFAULT 0,
  effort_component      INTEGER NOT NULL DEFAULT 0,
  context_component     INTEGER NOT NULL DEFAULT 0,
  smeq_actual           FLOAT CHECK (smeq_actual >= 0 AND smeq_actual <= 150),
  hours_until_due       FLOAT,
  streak_at_time        INTEGER NOT NULL DEFAULT 0,
  completed_at          TIMESTAMPTZ DEFAULT NOW()
);

-- Per-user per-category adaptive learning stats
CREATE TABLE IF NOT EXISTS category_stats (
  discord_user_id       TEXT NOT NULL REFERENCES user_profiles(discord_user_id) ON DELETE CASCADE,
  category              TEXT NOT NULL,
  completion_count      INTEGER NOT NULL DEFAULT 0,
  avg_score             FLOAT NOT NULL DEFAULT 50,
  avg_hours_to_complete FLOAT NOT NULL DEFAULT 24,
  avg_smeq_actual       FLOAT NOT NULL DEFAULT 65,
  personal_bias         FLOAT NOT NULL DEFAULT 1.0,
  updated_at            TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (discord_user_id, category)
);

-- Per-user unlocked achievements
CREATE TABLE IF NOT EXISTS achievements (
  discord_user_id TEXT NOT NULL REFERENCES user_profiles(discord_user_id) ON DELETE CASCADE,
  achievement_id  TEXT NOT NULL,
  unlocked_at     TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (discord_user_id, achievement_id)
);

-- Performance indexes
CREATE INDEX IF NOT EXISTS idx_life_events_user_cat
  ON life_events(discord_user_id, category);

CREATE INDEX IF NOT EXISTS idx_life_events_pending
  ON life_events(discord_user_id, completed)
  WHERE completed = FALSE;

CREATE INDEX IF NOT EXISTS idx_life_events_external_uid
  ON life_events(discord_user_id, external_uid)
  WHERE external_uid IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_scoring_events_user_time
  ON scoring_events(discord_user_id, completed_at DESC);

-- =============================================================================
-- Helper: auto-update updated_at timestamps
-- =============================================================================

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER user_profiles_updated_at
  BEFORE UPDATE ON user_profiles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE OR REPLACE TRIGGER life_events_updated_at
  BEFORE UPDATE ON life_events
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE OR REPLACE TRIGGER category_stats_updated_at
  BEFORE UPDATE ON category_stats
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
