// Data layer for the Worker: plain SQL against Cloudflare D1. `db` is the D1 binding (or anything with the
// same prepare/bind/first/run/all shape; tests run these exact statements on SQLite). All values are bound
// parameters, never concatenated.

export const createAltar = (db, { id, tokenHash, email, now }) =>
  db.prepare('INSERT INTO altars (id, token_hash, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, tokenHash, email, now, now).run();

export const getAltar = (db, id) =>
  db.prepare('SELECT id, token_hash, email, email_verified_at, state FROM altars WHERE id = ?').bind(id).first();

export const saveState = (db, id, stateJson, now) =>
  db.prepare('UPDATE altars SET state = ?, updated_at = ? WHERE id = ?').bind(stateJson, now, id).run();

export async function getEntitlements(db, id, featureNames) {
  const { results } = await db.prepare('SELECT name FROM features WHERE altar_id = ?').bind(id).all();
  const have = new Set(results.map(r => r.name));
  return Object.fromEntries(featureNames.map(f => [f, have.has(f)]));
}

// Returns true if the altar exists (and the feature is now granted); granting twice is harmless.
export async function grantFeature(db, id, name, now) {
  const r = await db.prepare('INSERT OR IGNORE INTO features (altar_id, name, granted_at) SELECT id, ?, ? FROM altars WHERE id = ?')
    .bind(name, now, id).run();
  if (r.meta.changes > 0) return true;
  return !!(await db.prepare('SELECT 1 AS x FROM altars WHERE id = ?').bind(id).first());
}

// Replace the edit token, which locks out the old one, and cancel recovery links still waiting in inboxes.
export async function replaceToken(db, id, tokenHash, now) {
  await db.batch([
    db.prepare('UPDATE altars SET token_hash = ?, updated_at = ? WHERE id = ?').bind(tokenHash, now, id),
    db.prepare("UPDATE email_tokens SET used_at = ? WHERE altar_id = ? AND purpose = 'recover' AND used_at IS NULL").bind(now, id),
  ]);
}

export const markVerified = (db, id, now) =>
  db.prepare('UPDATE altars SET email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?').bind(now, id).run();

export const addEmailToken = (db, { tokenHash, altarId, purpose, email, now, ttl }) =>
  db.prepare('INSERT INTO email_tokens (token_hash, altar_id, purpose, email, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(tokenHash, altarId, purpose, email, now, now + ttl).run();

export async function countEmailTokensSince(db, email, purpose, since) {
  const r = await db.prepare('SELECT COUNT(*) AS n FROM email_tokens WHERE email = ? AND purpose = ? AND created_at > ?')
    .bind(email, purpose, since).first();
  return r ? Number(r.n) : 0;
}

// Atomic single use: one UPDATE claims the token, so two simultaneous requests cannot both succeed.
export const redeemEmailToken = (db, { tokenHash, altarId, purpose, now }) =>
  db.prepare('UPDATE email_tokens SET used_at = ? WHERE token_hash = ? AND altar_id = ? AND purpose = ? AND used_at IS NULL AND expires_at > ? RETURNING email')
    .bind(now, tokenHash, altarId, purpose, now).first();

export async function verifiedAltarsByEmail(db, email, limit) {
  const { results } = await db.prepare('SELECT id FROM altars WHERE email = ? AND email_verified_at IS NOT NULL ORDER BY updated_at DESC LIMIT ?')
    .bind(email, limit).all();
  return results.map(r => r.id);
}
