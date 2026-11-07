-- Cloudflare D1 (SQLite). Apply with:  npx wrangler d1 migrations apply digital-ofrenda
-- Timestamps are unix milliseconds.

CREATE TABLE altars (
  id                TEXT PRIMARY KEY,
  token_hash        TEXT NOT NULL,      -- SHA-256 (hex) of the edit token; the token itself is never stored
  email             TEXT NOT NULL,      -- lower-cased; used only for confirmation and recovery
  email_verified_at INTEGER,            -- NULL until the owner clicks the confirmation link
  state             TEXT,               -- cleaned altar JSON; NULL until the first save
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX altars_email ON altars (email);

-- Paid upgrades, one row per altar and feature (extraPhotos, sevenTiers). Only the Stripe webhook writes here.
CREATE TABLE features (
  altar_id   TEXT NOT NULL REFERENCES altars (id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  PRIMARY KEY (altar_id, name)
);

-- One-time links sent by email. Only the hash is stored.
CREATE TABLE email_tokens (
  token_hash TEXT PRIMARY KEY,
  altar_id   TEXT NOT NULL REFERENCES altars (id) ON DELETE CASCADE,
  purpose    TEXT NOT NULL CHECK (purpose IN ('verify', 'recover')),
  email      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER
);
CREATE INDEX email_tokens_email ON email_tokens (email, purpose, created_at);
