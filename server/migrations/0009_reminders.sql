-- Settings the owner chooses with the successor: how long they must be away (milliseconds) before a takeover can start, and
-- whether it then starts by itself. The default is a year, automatic.
ALTER TABLE successors ADD COLUMN inactive_ms INTEGER NOT NULL DEFAULT 31536000000;
ALTER TABLE successors ADD COLUMN auto_transfer INTEGER NOT NULL DEFAULT 1;
-- A takeover the daily job started (and will finish itself) versus one the successor asked for. reminders_sent counts
-- the reminder emails already sent, so a repeated run never sends one twice.
ALTER TABLE claims ADD COLUMN auto INTEGER NOT NULL DEFAULT 0;
ALTER TABLE claims ADD COLUMN reminders_sent INTEGER NOT NULL DEFAULT 0;
ALTER TABLE handovers ADD COLUMN reminders_sent INTEGER NOT NULL DEFAULT 0;
