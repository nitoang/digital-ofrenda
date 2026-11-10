-- How many separate days a signed-in person has opened an ofrenda (at most one count a day). It is used for one
-- thing: choosing who should look after an ofrenda when a handover goes to someone who never signs up.
-- People who are not signed in are never counted. Owners are not counted. Deleted with the ofrenda or the account.
CREATE TABLE altar_visits (
  altar_id TEXT NOT NULL REFERENCES altars (id) ON DELETE CASCADE,
  user_id  TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  days     INTEGER NOT NULL DEFAULT 1,
  last_day INTEGER NOT NULL,                 -- the day number (ms since 1970 / 86400000) of the latest counted visit
  PRIMARY KEY (altar_id, user_id)
);
