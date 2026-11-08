-- Cloudflare D1 (SQLite). Apply with:  npx wrangler d1 migrations apply digital-ofrenda
-- Timestamps are unix milliseconds. Every secret (sign-in links and codes, session ids, invite and
-- successor tokens) is stored only as a SHA-256 hash.

-- A person. A row exists only after they proved they control the email address by signing in.
CREATE TABLE users (
  id           TEXT PRIMARY KEY,
  email        TEXT NOT NULL UNIQUE,           -- lower-cased
  plan         TEXT CHECK (plan IN ('platinum')),  -- account-wide upgrade: unlimited altars, photos and options
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL                -- drives the inactive-owner rule for successors
);

-- One pending sign-in. The emailed link and the 6-digit code are two ways to redeem the same row, once.
CREATE TABLE login_challenges (
  challenge_id TEXT PRIMARY KEY,
  link_hash    TEXT NOT NULL UNIQUE,
  code_hash    TEXT NOT NULL,
  email        TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  used_at      INTEGER,
  attempts     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX login_challenges_email ON login_challenges (email, created_at);

CREATE TABLE sessions (
  id_hash      TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions (user_id);

CREATE TABLE altars (
  id         TEXT PRIMARY KEY,
  state      TEXT,                             -- cleaned altar JSON; NULL until the first save
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Who can edit an altar. Exactly one owner; any number of co-keepers (the app caps them).
CREATE TABLE altar_members (
  altar_id TEXT NOT NULL REFERENCES altars (id) ON DELETE CASCADE,
  user_id  TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role     TEXT NOT NULL CHECK (role IN ('owner', 'keeper')),
  added_at INTEGER NOT NULL,
  PRIMARY KEY (altar_id, user_id)
);
CREATE UNIQUE INDEX altar_one_owner ON altar_members (altar_id) WHERE role = 'owner';
CREATE INDEX altar_members_user ON altar_members (user_id);

-- Per-altar paid upgrades (extraPhotos, sevenTiers). Only the Stripe webhook, or a handover, writes here.
CREATE TABLE features (
  altar_id   TEXT NOT NULL REFERENCES altars (id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  PRIMARY KEY (altar_id, name)
);

-- Invitations to be a co-keeper. Bound to the invited email address.
CREATE TABLE invites (
  id         TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  altar_id   TEXT NOT NULL REFERENCES altars (id) ON DELETE CASCADE,
  email      TEXT NOT NULL,
  invited_by TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER,
  revoked_at INTEGER
);
CREATE INDEX invites_altar ON invites (altar_id);
CREATE INDEX invites_email ON invites (email, created_at);

-- The person who may take over an altar if its owner goes quiet. Needs their own consent first.
CREATE TABLE successors (
  altar_id         TEXT PRIMARY KEY REFERENCES altars (id) ON DELETE CASCADE,
  email            TEXT NOT NULL,
  token_hash       TEXT NOT NULL UNIQUE,
  designated_by    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  designated_at    INTEGER NOT NULL,
  accepted_user_id TEXT REFERENCES users (id) ON DELETE CASCADE,
  accepted_at      INTEGER
);

-- A successor's request to take over. Waits out a notice period; the owner coming back cancels it.
CREATE TABLE claims (
  altar_id     TEXT PRIMARY KEY REFERENCES altars (id) ON DELETE CASCADE,
  requested_by TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  requested_at INTEGER NOT NULL,
  executes_at  INTEGER NOT NULL,
  cancelled_at INTEGER,
  completed_at INTEGER
);
