ALTER TABLE users ADD COLUMN morning_briefing_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN morning_briefing_timezone TEXT NOT NULL DEFAULT 'UTC';
ALTER TABLE users ADD COLUMN morning_briefing_hour INTEGER NOT NULL DEFAULT 8;
ALTER TABLE users ADD COLUMN morning_briefing_last_date TEXT;
ALTER TABLE users ADD COLUMN morning_briefing_last_sent_at INTEGER;
ALTER TABLE users ADD COLUMN morning_briefing_last_error TEXT;
