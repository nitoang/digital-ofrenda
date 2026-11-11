-- Optional tips by email, sent by the daily job to people who have been away for a long time. They are separate from
-- the account emails (sign-in, security, handovers), which always go out.
--   nudges_off     1 once the person turned the tips off (in My ofrendas, or from the link in any tip).
--   nudges_sent    how many tips they have had since they last signed in. Signing in sets it back to 0.
--   last_nudge_at  when the latest one went out, so two never arrive close together.
--   unsub_token    a random value made when the first tip is sent. The link in every tip carries it, so one click
--                  turns the tips off without signing in. It can do nothing else.
ALTER TABLE users ADD COLUMN nudges_off INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN nudges_sent INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN last_nudge_at INTEGER;
ALTER TABLE users ADD COLUMN unsub_token TEXT;
CREATE UNIQUE INDEX users_unsub_token ON users (unsub_token) WHERE unsub_token IS NOT NULL;
