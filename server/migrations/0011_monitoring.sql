-- Watching the service: when scheduled jobs last ran, and when we last emailed the operator about each kind of
-- problem (so one outage is one email, not hundreds). Nothing here is about a person.
CREATE TABLE job_runs (
  name       TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  ok_at      INTEGER,               -- the last run that finished with nothing failing
  failed_at  INTEGER,               -- set when the latest run failed or had failing steps; cleared by a clean run
  error      TEXT                   -- a short description, never an address or a token
);

CREATE TABLE alerts (
  kind         TEXT PRIMARY KEY,
  last_sent_at INTEGER NOT NULL,
  suppressed   INTEGER NOT NULL DEFAULT 0   -- how many more happened during the cool-down, said in the next email
);
