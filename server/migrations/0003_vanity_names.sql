-- Vanity names: /a/abuela-rosa as another address for an ofrenda. Apply with:
--   npx wrangler d1 migrations apply digital-ofrenda
-- Every name an ofrenda has ever had stays here, so old links keep working and nobody else can take over a
-- name that was already shared. The newest row is the current name (the one shown when sharing).
CREATE TABLE altar_slugs (
  slug       TEXT PRIMARY KEY,                -- lower-case letters, digits and single hyphens
  altar_id   TEXT NOT NULL REFERENCES altars (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
CREATE INDEX altar_slugs_altar ON altar_slugs (altar_id, created_at);
