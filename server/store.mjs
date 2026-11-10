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
// `created` is true only for the request that made the account (a second device racing it gets false).
export async function findOrCreateUser(db, { id, email, now }) {
  const r = await run(db, 'INSERT OR IGNORE INTO users (id, email, created_at, last_seen_at) VALUES (?, ?, ?, ?)', id, email, now, now);
  const user = await findUserByEmail(db, email);
  return user && { ...user, created: r?.meta?.changes > 0 };
}
export const touchUser = (db, id, now) => run(db, 'UPDATE users SET last_seen_at = ? WHERE id = ?', now, id);
export async function setPlan(db, id, plan) {
  return (await run(db, 'UPDATE users SET plan = ? WHERE id = ?', plan, id)).meta.changes > 0;
}
export const clearPlan = (db, id) => run(db, "UPDATE users SET plan = NULL WHERE id = ? AND plan = 'platinum'", id);

// Everything about a person goes in one transaction: their sessions, memberships, invitations they sent,
// successor and takeover rows (all by cascade), and the sign-in records and invitations addressed to their email.
// Ofrendas they own are dealt with first (owners.mjs): passed on to the people who keep them, or deleted if nobody does.
// Payment records hold no personal data and stay.
export const deleteAccount = (db, { userId, email }) => db.batch([
  stmt(db, 'DELETE FROM login_challenges WHERE email = ?', email),
  stmt(db, 'DELETE FROM invites WHERE email = ?', email),
  stmt(db, 'DELETE FROM successors WHERE email = ?', email),
  stmt(db, 'DELETE FROM users WHERE id = ?', userId),
]);
// The ofrendas this person owns, and how many other people are on each.
export const ownedAltars = (db, userId) =>
  all(db, `SELECT m.altar_id AS id, (SELECT COUNT(*) FROM altar_members o WHERE o.altar_id = m.altar_id AND o.user_id != m.user_id) AS others
    FROM altar_members m WHERE m.user_id = ? AND m.role = 'owner'`, userId);

// ---------- changing an email address ----------
// Starts (or restarts) a change. False when this person has asked too often this hour.
export async function startEmailChange(db, { userId, newEmail, codeHash, now, ttl, maxPerHour }) {
  const r = await run(db, `INSERT INTO email_changes (user_id, new_email, code_hash, created_at, expires_at, window_start)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (user_id) DO UPDATE SET new_email = excluded.new_email, code_hash = excluded.code_hash, created_at = excluded.created_at,
      expires_at = excluded.expires_at, attempts = 0,
      sends = CASE WHEN excluded.created_at - email_changes.window_start < 3600000 THEN email_changes.sends + 1 ELSE 1 END,
      window_start = CASE WHEN excluded.created_at - email_changes.window_start < 3600000 THEN email_changes.window_start ELSE excluded.created_at END
    WHERE excluded.created_at - email_changes.window_start >= 3600000 OR email_changes.sends < ?`,
    userId, newEmail, codeHash, now, now + ttl, now, maxPerHour);
  return r.meta.changes > 0;
}
// Every guess counts, right or wrong.
export const countEmailChangeAttempt = (db, { userId, now, maxAttempts }) =>
  one(db, 'UPDATE email_changes SET attempts = attempts + 1 WHERE user_id = ? AND expires_at > ? AND attempts < ? RETURNING new_email, code_hash', userId, now, maxAttempts);
export const getPendingEmailChange = (db, userId, now) =>
  one(db, 'SELECT new_email, expires_at FROM email_changes WHERE user_id = ? AND expires_at > ?', userId, now);
export const cancelEmailChange = (db, userId) => run(db, 'DELETE FROM email_changes WHERE user_id = ?', userId);

// Switches the address and signs out every other device, in one transaction. The UNIQUE column makes this
// fail if somebody else already has the new address.
export const applyEmailChange = (db, { userId, newEmail, keepSession }) => db.batch([
  stmt(db, 'UPDATE users SET email = ? WHERE id = ?', newEmail, userId),
  stmt(db, 'DELETE FROM email_changes WHERE user_id = ?', userId),
  stmt(db, 'DELETE FROM sessions WHERE user_id = ? AND id_hash != ?', userId, keepSession),
]);

// ---------- purchases and refunds ----------
export const recordPurchase = (db, { paymentIntent, feature, reference, now }) =>
  run(db, 'INSERT OR IGNORE INTO purchases (payment_intent, feature, reference, paid_at) VALUES (?, ?, ?, ?)', paymentIntent, feature, reference, now);
export const getPurchase = (db, paymentIntent) => one(db, 'SELECT feature, reference, refunded_at FROM purchases WHERE payment_intent = ?', paymentIntent);
export const markRefunded = (db, paymentIntent, now) =>
  run(db, 'UPDATE purchases SET refunded_at = ? WHERE payment_intent = ? AND refunded_at IS NULL', now, paymentIntent);
export async function countUnrefunded(db, feature, reference) {
  const r = await one(db, 'SELECT COUNT(*) AS n FROM purchases WHERE feature = ? AND reference = ? AND refunded_at IS NULL', feature, reference);
  return r ? Number(r.n) : 0;
}
export const removeFeature = (db, altarId, name) => run(db, 'DELETE FROM features WHERE altar_id = ? AND name = ?', altarId, name);

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

// Expired sign-in records are of no use to anyone, so each new sign-in request tidies up behind itself.
// Used ones are kept a day for the per-address rate limit, which only looks back an hour.
export const purgeExpired = (db, now) => db.batch([
  stmt(db, 'DELETE FROM login_challenges WHERE expires_at < ? AND created_at < ?', now - 86_400_000, now - 86_400_000),
  stmt(db, 'DELETE FROM sessions WHERE expires_at < ?', now),
  stmt(db, 'DELETE FROM email_changes WHERE expires_at < ?', now - 86_400_000),
  stmt(db, 'DELETE FROM view_shares WHERE created_at < ?', now - 86_400_000),
]);

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
export const getOwners = (db, altarId) =>
  all(db, "SELECT u.id, u.email, u.plan, u.last_seen_at FROM altar_members m JOIN users u ON u.id = m.user_id WHERE m.altar_id = ? AND m.role = 'owner' ORDER BY m.added_at, u.email", altarId);

// A free account owns up to `limit` ofrendas. When it ends up with more (an ofrenda was passed on to it), the
// newest ones are locked: viewable, but not editable until the person upgrades or makes room. Worked out each
// time from the memberships, so there is nothing to keep in step: upgrading or deleting another ofrenda unlocks.
export async function ownerLocked(db, altarId, userId, limit) {
  const me = await one(db, "SELECT m.added_at, u.plan FROM altar_members m JOIN users u ON u.id = m.user_id WHERE m.altar_id = ? AND m.user_id = ? AND m.role = 'owner'", altarId, userId);
  if (!me || me.plan === 'platinum') return false;
  const before = await one(db, "SELECT COUNT(*) AS n FROM altar_members WHERE user_id = ? AND role = 'owner' AND (added_at < ? OR (added_at = ? AND altar_id < ?))", userId, me.added_at, me.added_at, altarId);
  return Number(before.n) >= limit;
}
// Keepers edit through the owners: the ofrenda is locked for them only if every owner is locked.
export async function altarLockedFor(db, altarId, userId, limit) {
  const role = await getRole(db, altarId, userId);
  if (role === 'owner') return ownerLocked(db, altarId, userId, limit);
  const owners = await getOwners(db, altarId);
  for (const o of owners) if (!(await ownerLocked(db, altarId, o.id, limit))) return false;
  return owners.length > 0;
}

// An owner steps away while another owner remains. False if they are the last owner (the guard is in the SQL).
export async function leaveAsOwner(db, altarId, userId) {
  return (await run(db, `DELETE FROM altar_members WHERE altar_id = ? AND user_id = ? AND role = 'owner'
    AND (SELECT COUNT(*) FROM altar_members WHERE altar_id = ? AND role = 'owner') > 1`, altarId, userId, altarId)).meta.changes > 0;
}
// The last owner leaves and the people who keep the ofrenda become its owners. They join the end of their own
// list (added_at = now), so an ofrenda passed to them never pushes an older one of theirs into the locked part.
export const passOn = (db, { altarId, fromUserId, heirIds, now, grants }) => db.batch([
  ...heirIds.map(id => stmt(db, `INSERT INTO altar_members (altar_id, user_id, role, added_at) VALUES (?, ?, 'owner', ?)
    ON CONFLICT (altar_id, user_id) DO UPDATE SET role = 'owner', via_successor = 0, added_at = excluded.added_at`, altarId, id, now)),
  stmt(db, 'DELETE FROM altar_members WHERE altar_id = ? AND user_id = ?', altarId, fromUserId),
  stmt(db, 'DELETE FROM successors WHERE altar_id = ?', altarId),
  stmt(db, 'DELETE FROM handovers WHERE altar_id = ?', altarId),
  stmt(db, 'UPDATE claims SET cancelled_at = ? WHERE altar_id = ? AND cancelled_at IS NULL AND completed_at IS NULL', now, altarId),
  ...grants.map(name => stmt(db, 'INSERT OR IGNORE INTO features (altar_id, name, granted_at) VALUES (?, ?, ?)', altarId, name, now)),
]);
export const altarsForUser = (db, userId) =>
  all(db, `SELECT m.altar_id AS id, m.role, (SELECT slug FROM altar_slugs s WHERE s.altar_id = m.altar_id ORDER BY s.created_at DESC, s.rowid DESC LIMIT 1) AS slug
    FROM altar_members m WHERE m.user_id = ? ORDER BY m.added_at, m.altar_id`, userId);

// ---------- vanity names ----------
export const currentSlug = async (db, altarId) =>
  (await one(db, 'SELECT slug FROM altar_slugs WHERE altar_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', altarId))?.slug ?? null;
export const altarIdForSlug = async (db, slug) => (await one(db, 'SELECT altar_id FROM altar_slugs WHERE slug = ?', slug))?.altar_id ?? null;

// Makes `slug` this altar's current name. Returns 'ok', 'taken' (someone else's, now or before) or 'limit'.
// One of its own earlier names can be taken back. The primary key makes two simultaneous claims safe.
export async function setSlug(db, { altarId, slug, now, max }) {
  const owner = await altarIdForSlug(db, slug);
  if (owner && owner !== altarId) return 'taken';
  if (owner) { await run(db, 'UPDATE altar_slugs SET created_at = ? WHERE slug = ?', now, slug); return 'ok'; }
  const have = await one(db, 'SELECT COUNT(*) AS n FROM altar_slugs WHERE altar_id = ?', altarId);
  if (Number(have.n) >= max) return 'limit';
  try { await run(db, 'INSERT INTO altar_slugs (slug, altar_id, created_at) VALUES (?, ?, ?)', slug, altarId, now); }
  catch (e) { if (/unique|constraint/i.test(String(e?.message))) return 'taken'; throw e; }
  return 'ok';
}

// Upgrades bought for this altar, plus everything if its owner has the platinum plan.
export async function getEntitlements(db, altarId, names) {
  const platinum = await one(db, "SELECT 1 AS x FROM altar_members m JOIN users u ON u.id = m.user_id WHERE m.altar_id = ? AND m.role = 'owner' AND u.plan = 'platinum'", altarId);
  if (platinum) return Object.fromEntries(names.map(n => [n, true]));
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
// View-only shares: only a hash of the address, only to rate-limit repeat emails (rows are purged after a day).
export const addViewShare = (db, { id, altarId, sharedBy, emailHash, now }) =>
  run(db, 'INSERT INTO view_shares (id, altar_id, shared_by, email_hash, created_at) VALUES (?, ?, ?, ?, ?)', id, altarId, sharedBy, emailHash, now);
export async function countViewSharesToEmail(db, emailHash, since) {
  const r = await one(db, 'SELECT COUNT(*) AS n FROM view_shares WHERE email_hash = ? AND created_at > ?', emailHash, since);
  return r ? Number(r.n) : 0;
}
export async function countViewSharesFromAltar(db, altarId, since) {
  const r = await one(db, 'SELECT COUNT(*) AS n FROM view_shares WHERE altar_id = ? AND created_at > ?', altarId, since);
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
export const setSuccessor = (db, { altarId, email, tokenHash, designatedBy, now, inactiveMs = 365 * 86_400_000, auto = true }) =>
  run(db, 'INSERT OR REPLACE INTO successors (altar_id, email, token_hash, designated_by, designated_at, inactive_ms, auto_transfer) VALUES (?, ?, ?, ?, ?, ?, ?)',
    altarId, email, tokenHash, designatedBy, now, inactiveMs, auto ? 1 : 0);
export const getSuccessor = (db, altarId) =>
  one(db, 'SELECT altar_id, email, designated_at, accepted_user_id, accepted_at, inactive_ms, auto_transfer FROM successors WHERE altar_id = ?', altarId);
// Changes how long, and whether it starts by itself, without asking the successor again.
export async function updateSuccessorSettings(db, { altarId, inactiveMs, auto }) {
  return (await run(db, 'UPDATE successors SET inactive_ms = ?, auto_transfer = ? WHERE altar_id = ?', inactiveMs, auto ? 1 : 0, altarId)).meta.changes > 0;
}
export const clearSuccessor = (db, altarId) => run(db, 'DELETE FROM successors WHERE altar_id = ?', altarId);
export const acceptSuccessor = (db, { tokenHash, userId, email, now }) =>
  one(db, 'UPDATE successors SET accepted_user_id = ?, accepted_at = ? WHERE token_hash = ? AND email = ? AND accepted_user_id IS NULL RETURNING altar_id',
    userId, now, tokenHash, email);
// A successor who agrees becomes a co-keeper. If they already keep the ofrenda some other way, nothing changes.
export const grantSuccessorAccess = (db, altarId, userId, now) =>
  run(db, "INSERT OR IGNORE INTO altar_members (altar_id, user_id, role, added_at, via_successor) VALUES (?, ?, 'keeper', ?, 1)", altarId, userId, now);
// Removing or replacing the successor ends the access they had only because of it.
export const revokeSuccessorAccess = (db, altarId) =>
  run(db, "DELETE FROM altar_members WHERE altar_id = ? AND via_successor = 1 AND role = 'keeper'", altarId);
export const altarsWhereSuccessor = (db, userId) =>
  all(db, 'SELECT s.altar_id AS id, c.executes_at, c.cancelled_at, c.completed_at FROM successors s LEFT JOIN claims c ON c.altar_id = s.altar_id WHERE s.accepted_user_id = ?', userId);

export const getClaim = (db, altarId) =>
  one(db, 'SELECT altar_id, requested_by, requested_at, executes_at, cancelled_at, completed_at, auto, reminders_sent FROM claims WHERE altar_id = ?', altarId);

// Creates a claim unless one is already running (a finished or cancelled one is replaced).
export async function createClaim(db, { altarId, requestedBy, now, executesAt, auto = false }) {
  const r = await run(db, `INSERT INTO claims (altar_id, requested_by, requested_at, executes_at, auto) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (altar_id) DO UPDATE SET requested_by = excluded.requested_by, requested_at = excluded.requested_at,
      executes_at = excluded.executes_at, auto = excluded.auto, reminders_sent = 0, cancelled_at = NULL, completed_at = NULL
    WHERE claims.cancelled_at IS NOT NULL OR claims.completed_at IS NOT NULL`, altarId, requestedBy, now, executesAt, auto ? 1 : 0);
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

// One transaction: the old owners stay on as co-keepers, the successor becomes owner, and any upgrades the
// old owner's platinum plan was providing are written onto the altar so the family keeps them.
export const handOver = (db, { altarId, newOwnerId, now, grants }) => db.batch([
  stmt(db, "UPDATE altar_members SET role = 'keeper' WHERE altar_id = ? AND role = 'owner'", altarId), // every owner had gone quiet
  stmt(db, "INSERT INTO altar_members (altar_id, user_id, role, added_at) VALUES (?, ?, 'owner', ?) ON CONFLICT (altar_id, user_id) DO UPDATE SET role = 'owner', via_successor = 0, added_at = excluded.added_at", altarId, newOwnerId, now),
  stmt(db, 'DELETE FROM successors WHERE altar_id = ?', altarId),
  ...grants.map(name => stmt(db, 'INSERT OR IGNORE INTO features (altar_id, name, granted_at) VALUES (?, ?, ?)', altarId, name, now)),
]);


// ---------- handovers ----------
export const getHandover = (db, altarId) => one(db, 'SELECT altar_id, to_email, from_user_id, created_at, expires_at FROM handovers WHERE altar_id = ?', altarId);
export async function countHandoversSince(db, userId, since) {
  const r = await one(db, 'SELECT COUNT(*) AS n FROM handover_log WHERE user_id = ? AND at > ?', userId, since);
  return Number(r.n);
}
// Makes `userId` an owner as well. The previous owner is untouched. Starts at the end of their list (added_at = now).
export const addOwner = (db, { altarId, userId, now }) => run(db, `INSERT INTO altar_members (altar_id, user_id, role, added_at) VALUES (?, ?, 'owner', ?)
  ON CONFLICT (altar_id, user_id) DO UPDATE SET role = 'owner', via_successor = 0, added_at = excluded.added_at`, altarId, userId, now);
export const logHandover = (db, { id, userId, now }) => run(db, 'INSERT INTO handover_log (id, user_id, at) VALUES (?, ?, ?)', id, userId, now);
// False if one is already waiting on this ofrenda.
export async function createHandover(db, { altarId, toEmail, fromUserId, now, expiresAt }) {
  return (await run(db, 'INSERT OR IGNORE INTO handovers (altar_id, to_email, from_user_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)', altarId, toEmail, fromUserId, now, expiresAt)).meta.changes > 0;
}
export const cancelHandover = async (db, altarId) => (await run(db, 'DELETE FROM handovers WHERE altar_id = ?', altarId)).meta.changes > 0;
// A new person has just signed in for the first time: take the handovers waiting for their address (one use each).
export const takeHandoversFor = (db, email, now) =>
  all(db, 'DELETE FROM handovers WHERE to_email = ? AND expires_at > ? RETURNING altar_id, from_user_id', email, now);
export async function countHandoversTo(db, email, now) {
  const r = await one(db, 'SELECT COUNT(*) AS n FROM handovers WHERE to_email = ? AND expires_at > ?', email, now);
  return Number(r.n);
}

// ---------- visits ----------
// Counts today for this person, once. False if today was already counted or they are an owner / the ofrenda is gone.
export async function recordVisit(db, { altarId, userId, day }) {
  const r = await run(db, `INSERT INTO altar_visits (altar_id, user_id, last_day)
    SELECT m.id, ?, ? FROM altars m WHERE m.id = ? AND NOT EXISTS (SELECT 1 FROM altar_members o WHERE o.altar_id = m.id AND o.user_id = ? AND o.role = 'owner')
    ON CONFLICT (altar_id, user_id) DO UPDATE SET days = days + 1, last_day = excluded.last_day WHERE altar_visits.last_day < excluded.last_day`,
    userId, day, altarId, userId);
  return r.meta.changes > 0;
}
// The signed-in people who opened it on the most days, ties included (never an owner). Empty if nobody has.
export async function topVisitors(db, altarId) {
  return all(db, `SELECT v.user_id, u.email, v.days FROM altar_visits v JOIN users u ON u.id = v.user_id
    WHERE v.altar_id = ? AND v.days = (SELECT MAX(days) FROM altar_visits x WHERE x.altar_id = v.altar_id AND NOT EXISTS
      (SELECT 1 FROM altar_members o WHERE o.altar_id = x.altar_id AND o.user_id = x.user_id AND o.role = 'owner'))
    AND NOT EXISTS (SELECT 1 FROM altar_members o WHERE o.altar_id = v.altar_id AND o.user_id = v.user_id AND o.role = 'owner')
    ORDER BY u.email`, altarId);
}


// ---------- the daily job ----------
// Ofrendas whose agreed successor may now be given the 30-day notice by the job: automatic transfer is on, no notice
// is running, and every owner has been away for the period chosen with the successor.
export const dueAutoTakeovers = (db, { now, limit }) =>
  all(db, `SELECT s.altar_id, s.accepted_user_id, s.inactive_ms FROM successors s
    WHERE s.accepted_user_id IS NOT NULL AND s.auto_transfer = 1
      AND NOT EXISTS (SELECT 1 FROM claims c WHERE c.altar_id = s.altar_id AND c.cancelled_at IS NULL AND c.completed_at IS NULL)
      AND EXISTS (SELECT 1 FROM altar_members m WHERE m.altar_id = s.altar_id AND m.role = 'owner')
      AND NOT EXISTS (SELECT 1 FROM altar_members m WHERE m.altar_id = s.altar_id AND m.role = 'owner' AND m.user_id = s.accepted_user_id)
      AND NOT EXISTS (SELECT 1 FROM altar_members m JOIN users u ON u.id = m.user_id
        WHERE m.altar_id = s.altar_id AND m.role = 'owner' AND u.last_seen_at > ? - s.inactive_ms)
    LIMIT ?`, now, limit);
export const runningClaims = (db, limit) =>
  all(db, 'SELECT altar_id, requested_by, requested_at, executes_at, auto, reminders_sent FROM claims WHERE cancelled_at IS NULL AND completed_at IS NULL LIMIT ?', limit);
// True for the one run that moves the count on (so two overlapping runs cannot both send the reminder).
export async function bumpClaimReminder(db, altarId, sent) {
  return (await run(db, 'UPDATE claims SET reminders_sent = reminders_sent + 1 WHERE altar_id = ? AND reminders_sent = ? AND cancelled_at IS NULL AND completed_at IS NULL', altarId, sent)).meta.changes > 0;
}
export const waitingHandovers = (db, limit) =>
  all(db, 'SELECT altar_id, to_email, from_user_id, created_at, expires_at, reminders_sent FROM handovers ORDER BY created_at LIMIT ?', limit);
export async function bumpHandoverReminder(db, altarId, sent) {
  return (await run(db, 'UPDATE handovers SET reminders_sent = reminders_sent + 1 WHERE altar_id = ? AND reminders_sent = ?', altarId, sent)).meta.changes > 0;
}
// Ends a waiting handover whose time is up. Returns it for the one run that removed it.
export const takeExpiredHandover = (db, { altarId, now }) =>
  one(db, 'DELETE FROM handovers WHERE altar_id = ? AND expires_at <= ? RETURNING altar_id, to_email, from_user_id', altarId, now);
export const listKeepers = (db, altarId) =>
  all(db, "SELECT u.id AS user_id, u.email FROM altar_members m JOIN users u ON u.id = m.user_id WHERE m.altar_id = ? AND m.role = 'keeper' ORDER BY m.added_at, u.email", altarId);
