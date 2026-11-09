-- A record that the owner emailed someone a view-only link, kept only to limit repeat emails.
-- The recipient's address is stored as a one-way hash, never in plain text, and rows are cleared after a day.
-- (Viewing needs no account, so there is nothing else to remember about the recipient.)
CREATE TABLE view_shares (
  id         TEXT PRIMARY KEY,
  altar_id   TEXT NOT NULL REFERENCES altars (id) ON DELETE CASCADE,
  shared_by  TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  email_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX view_shares_email ON view_shares (email_hash, created_at);
CREATE INDEX view_shares_altar ON view_shares (altar_id, created_at);
