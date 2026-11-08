// Data layer for the Worker: plain SQL against Cloudflare D1. `db` is the D1 binding (or anything with the
// same prepare/bind/first/run/all/batch shape; tests run these exact statements on SQLite). Every value is a
// bound parameter, never concatenated. Anything that must happen once (using a token, claiming a handover)
// is a single UPDATE ... RETURNING, so two simultaneous requests cannot both win.

const one = (db, sql, ...args) => db.prepare(sql).bind(...args).first();
const run = (db, sql, ...args) => db.prepare(sql).bind(...args).run();
const all = async (db, sql, ...args) => (await db.prepare(sql).bind(...args).all()).results;
const stmt = (db, sql, ...args) => db.prepare(sql).bind(...args);

// ---------- users ----------
export const getUser = (db, id) => one(db, 'SELECT id, email, plan, last_seen_at FROM users WHERE id = ?', id);
export const findUserByEmail = (db, email) => one(db, 'SELECT id, email, plan, last_seen_at FROM users WHERE email = ?', email);
export async function findOrCreateUser(db, { id, email, now }) {
  await run(db, 'INSERT OR IGNORE INTO users (id, email, created_at, last_seen_at) VALUES (?, ?, ?, ?)', id, email, now, now);
  return findUserByEmail(db, email);
}
export const touchUser = (db, id, now) => run(db, 'UPDATE users SET last_seen_at = ? WHERE id = ?', now, id);
export async function setPlan(db, id, plan) {
  return (await run(db, 'UPDATE users SET plan = ? WHERE id = ?', plan, id)).meta.changes > 0;
}

// ---------- sign-in ----------
export const addLoginChallenge = (db, { challenge, linkHash, codeHash, email, now, ttl }) =>
  run(db, 'INSERT INTO login_challenges (challenge_id, link_hash, code_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
    challenge, linkHash, codeHash, email, now, now + ttl);

export async function countLoginChallengesSince(db, email, since) {
  const r = await one(db, 'SELECT COUNT(*) AS n FROM login_challenges WHERE email = ? AND created_at > ?', email, since);
  return r ? Number(r.n) : 0;
}

export const redeemLoginLink = (db, { linkHash, now }) =>
  one(db, 'UPDATE login_challenges SET used_at = ? WHERE link_hash = ? AND used_at IS NULL AND expires_at > ? RETURNING email', now, linkHash, now);

// Every guess counts, right or wrong, and stops working after maxAttempts.
export const countLoginAttempt = (db, { challenge, now, maxAttempts }) =>
  one(db, 'UPDATE login_challenges SET attempts = attempts + 1 WHERE challenge_id = ? AND used_at IS NULL AND expires_at > ? AND attempts < ? RETURNING code_hash, email',
    challenge, now, maxAttempts);

export const useLoginChallenge = (db, { challenge, now }) =>
  one(db, 'UPDATE login_challenges SET used_at = ? WHERE challenge_id = ? AND used_at IS NULL RETURNING email', now, challenge);

// ---------- sessions ----------
export const createSession = (db, { idHash, userId, now, ttl }) =>
  run(db, 'INSERT INTO sessions (id_hash, user_id, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?, ?)', idHash, userId, now, now, now + ttl);
export const getSession = (db, idHash, now) =>
  one(db, 'SELECT s.last_used_at, u.id AS user_id, u.email, u.plan, u.last_seen_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ? AND s.expires_at > ?', idHash, now);
export const renewSession = (db, idHash, now, ttl) =>
  run(db, 'UPDATE sessions SET last_used_at = ?, expires_at = ? WHERE id_hash = ?', now, now + ttl, idHash);
export const deleteSession = (db, idHash) => run(db, 'DELETE FROM sessions WHERE id_hash = ?', idHash);
export const deleteSessionsForUser = (db, userId) => run(db, 'DELETE FROM sessions WHERE user_id = ?', userId);

// ---------- altars ----------
export const createAltar = (db, { id, userId, now }) => db.batch([
  stmt(db, 'INSERT INTO altars (id, created_at, updated_at) VALUES (?, ?, ?)', id, now, now),
  stmt(db, "INSERT INTO altar_members (altar_id, user_id, role, added_at) VALUES (?, ?, 'owner', ?)", id, userId, now),
]);
export async function countOwnedAltars(db, userId) {
  const r = await one(db, "SELECT COUNT(*) AS n FROM altar_members WHERE user_id = ? AND role = 'owner'", userId);
  return r ? Number(r.n) : 0;
}
export const getAltar = (db, id) => one(db, 'SELECT id, state FROM altars WHERE id = ?', id);
export const saveState = (db, id, stateJson, now) => run(db, 'UPDATE altars SET state = ?, updated_at = ? WHERE id = ?', stateJson, now, id);
export const deleteAltar = (db, id) => run(db, 'DELETE FROM altars WHERE id = ?', id);
export async function getRole(db, altarId, userId) {
  return (await one(db, 'SELECT role FROM altar_members WHERE altar_id = ? AND user_id = ?', altarId, userId))?.role ?? null;
}
export const getOwner = (db, altarId) =>
  one(db, "SELECT u.id, u.email, u.plan, u.last_seen_at FROM altar_members m JOIN users u ON u.id = m.user_id WHERE m.altar_id = ? AND m.role = 'owner'", altarId);
export const altarsForUser = (db, userId) =>
  all(db, 'SELECT altar_id AS id, role FROM altar_members WHERE user_id = ? ORDER BY added_at, altar_id', userId);

// Upgrades bought for this altar, plus everything if its owner has the platinum plan.
export async function getEntitlements(db, altarId, names) {
  const owner = await getOwner(db, altarId);
  if (owner?.plan === 'platinum') return Object.fromEntries(names.map(n => [n, true]));
  const have = new Set((await all(db, 'SELECT name FROM features WHERE altar_id = ?', altarId)).map(r => r.name));
  return Object.fromEntries(names.map(n => [n, have.has(n)]));
}

// True if the altar exists (and the feature is now granted); granting twice is harmless.
export async function grantFeature(db, altarId, name, now) {
  const r = await run(db, 'INSERT OR IGNORE INTO features (altar_id, name, granted_at) SELECT id, ?, ? FROM altars WHERE id = ?', name, now, altarId);
  if (r.meta.changes > 0) return true;
  return !!(await one(db, 'SELECT 1 AS x FROM altars WHERE id = ?', altarId));
}

// ---------- co-keepers ----------
export const listMembers = (db, altarId) =>
  all(db, "SELECT u.id AS user_id, u.email, m.role FROM altar_members m JOIN users u ON u.id = m.user_id WHERE m.altar_id = ? ORDER BY m.role = 'owner' DESC, m.added_at, u.email", altarId);
export async function removeMember(db, altarId, userId) { // only co-keepers can be removed, never the owner
  return (await run(db, "DELETE FROM altar_members WHERE altar_id = ? AND user_id = ? AND role = 'keeper'", altarId, userId)).meta.changes > 0;
}

export const addInvite = (db, { id, tokenHash, altarId, email, invitedBy, now, ttl }) =>
  run(db, 'INSERT INTO invites (id, token_hash, altar_id, email, invited_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    id, tokenHash, altarId, email, invitedBy, now, now + ttl);
export const listInvites = (db, altarId, now) =>
  all(db, 'SELECT id, email, expires_at FROM invites WHERE altar_id = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at', altarId, now);
export async function countInvitesSince(db, email, since) {
  const r = await one(db, 'SELECT COUNT(*) AS n FROM invites WHERE email = ? AND created_at > ?', email, since);
  return r ? Number(r.n) : 0;
}
export const revokeInvite = async (db, altarId, id, now) =>
  (await run(db, 'UPDATE invites SET revoked_at = ? WHERE id = ? AND altar_id = ? AND used_at IS NULL AND revoked_at IS NULL', now, id, altarId)).meta.changes > 0;

// Accepting needs the signed-in user's email to be the one invited, so a forwarded email is useless.
export async function acceptInvite(db, { tokenHash, userId, email, now }) {
  const claimed = await one(db, 'UPDATE invites SET used_at = ? WHERE token_hash = ? AND email = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ? RETURNING altar_id',
    now, tokenHash, email, now);
  if (!claimed) return null;
  await run(db, "INSERT OR IGNORE INTO altar_members (altar_id, user_id, role, added_at) VALUES (?, ?, 'keeper', ?)", claimed.altar_id, userId, now);
  return claimed.altar_id;
}

// ---------- successor and handover ----------
// Naming a new successor replaces the old one and starts again from "not yet accepted".
export const setSuccessor = (db, { altarId, email, tokenHash, designatedBy, now }) =>
  run(db, 'INSERT OR REPLACE INTO successors (altar_id, email, token_hash, designated_by, designated_at) VALUES (?, ?, ?, ?, ?)', altarId, email, tokenHash, designatedBy, now);
export const getSuccessor = (db, altarId) =>
  one(db, 'SELECT altar_id, email, designated_at, accepted_user_id, accepted_at FROM successors WHERE altar_id = ?', altarId);
export const clearSuccessor = (db, altarId) => run(db, 'DELETE FROM successors WHERE altar_id = ?', altarId);
export const acceptSuccessor = (db, { tokenHash, userId, email, now }) =>
  one(db, 'UPDATE successors SET accepted_user_id = ?, accepted_at = ? WHERE token_hash = ? AND email = ? AND accepted_user_id IS NULL RETURNING altar_id',
    userId, now, tokenHash, email);
export const altarsWhereSuccessor = (db, userId) =>
  all(db, 'SELECT s.altar_id AS id, c.executes_at, c.cancelled_at, c.completed_at FROM successors s LEFT JOIN claims c ON c.altar_id = s.altar_id WHERE s.accepted_user_id = ?', userId);

export const getClaim = (db, altarId) =>
  one(db, 'SELECT altar_id, requested_by, requested_at, executes_at, cancelled_at, completed_at FROM claims WHERE altar_id = ?', altarId);

// Creates a claim unless one is already running (a finished or cancelled one is replaced).
export async function createClaim(db, { altarId, requestedBy, now, executesAt }) {
  const r = await run(db, `INSERT INTO claims (altar_id, requested_by, requested_at, executes_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (altar_id) DO UPDATE SET requested_by = excluded.requested_by, requested_at = excluded.requested_at,
      executes_at = excluded.executes_at, cancelled_at = NULL, completed_at = NULL
    WHERE claims.cancelled_at IS NOT NULL OR claims.completed_at IS NOT NULL`, altarId, requestedBy, now, executesAt);
  return r.meta.changes > 0;
}
export const cancelClaim = async (db, altarId, now) =>
  (await run(db, 'UPDATE claims SET cancelled_at = ? WHERE altar_id = ? AND cancelled_at IS NULL AND completed_at IS NULL', now, altarId)).meta.changes > 0;

// The owner is active again: cancel every running claim on altars they own. Returns who to tell.
export const cancelClaimsOwnedBy = (db, userId, now) =>
  all(db, `UPDATE claims SET cancelled_at = ? WHERE cancelled_at IS NULL AND completed_at IS NULL
    AND altar_id IN (SELECT altar_id FROM altar_members WHERE user_id = ? AND role = 'owner') RETURNING altar_id, requested_by`, now, userId);

export const finishClaim = (db, { altarId, now }) =>
  one(db, 'UPDATE claims SET completed_at = ? WHERE altar_id = ? AND completed_at IS NULL AND cancelled_at IS NULL AND executes_at <= ? RETURNING requested_by, requested_at',
    now, altarId, now);

// If the handover itself failed after the claim was marked finished, put the claim back so it can be retried.
export const reopenClaim = (db, altarId) => run(db, 'UPDATE claims SET completed_at = NULL WHERE altar_id = ?', altarId);

// One transaction: the old owner stays on as a co-keeper, the successor becomes owner, and any upgrades the
// old owner's platinum plan was providing are written onto the altar so the family keeps them.
export const handOver = (db, { altarId, oldOwnerId, newOwnerId, now, grants }) => db.batch([
  stmt(db, "UPDATE altar_members SET role = 'keeper' WHERE altar_id = ? AND user_id = ? AND role = 'owner'", altarId, oldOwnerId),
  stmt(db, "INSERT INTO altar_members (altar_id, user_id, role, added_at) VALUES (?, ?, 'owner', ?) ON CONFLICT (altar_id, user_id) DO UPDATE SET role = 'owner'", altarId, newOwnerId, now),
  stmt(db, 'DELETE FROM successors WHERE altar_id = ?', altarId),
  ...grants.map(name => stmt(db, 'INSERT OR IGNORE INTO features (altar_id, name, granted_at) VALUES (?, ?, ?)', altarId, name, now)),
]);
