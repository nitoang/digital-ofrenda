-- An owner can hand an ofrenda to someone. If that person already has an account it happens at once; if not, it waits
-- here until they first sign in with the address it was sent to. The previous owner stays on as an owner.
CREATE TABLE handovers (
  altar_id     TEXT PRIMARY KEY REFERENCES altars (id) ON DELETE CASCADE,
  to_email     TEXT NOT NULL,
  from_user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL      -- how long it waits for the person to sign up
);
CREATE INDEX handovers_email ON handovers (to_email);

-- Every handover an account starts, so it can only start a few a day. Holds no one else's details.
CREATE TABLE handover_log (
  id      TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  at      INTEGER NOT NULL
);
CREATE INDEX handover_log_user ON handover_log (user_id, at);
