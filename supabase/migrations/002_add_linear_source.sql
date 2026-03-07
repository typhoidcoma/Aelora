-- Add 'linear' as a valid source for life_events
ALTER TABLE life_events DROP CONSTRAINT IF EXISTS life_events_source_check;
ALTER TABLE life_events ADD CONSTRAINT life_events_source_check
  CHECK (source IN ('google_tasks', 'google_calendar', 'manual', 'discord', 'linear'));
