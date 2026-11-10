// Who keeps an altar: co-keepers (invited by email), a successor (who agrees in advance), and the takeover
// that lets the successor inherit an altar whose owner has gone quiet.
//
// Takeover rules, all in RULES (rules.mjs):
//   1. The successor must have accepted. Naming someone gives them no access; agreeing makes them a co-keeper.
//   2. The owner must not have been seen for `inactiveAfter` (a year).
//   3. The successor asks. The owner is emailed and has `claimWait` (30 days) to stop it, and simply
//      signing in at any time cancels it, so a person who is only grieving quietly is never overtaken.
//   4. After the wait, the successor completes it. They become owner; the old owner stays on as a co-keeper.
//      Upgrades the old owner's platinum plan was providing are written onto the altar so the family keeps them.
// Nothing needs a scheduled job: each step is a request someone makes.

import { json, readJson, isResponse, normalizeEmail, sha256Hex, newToken, newId, DAY } from './util.mjs';
import * as store from './store.mjs';
import { requireUser } from './auth.mjs';
import { queueMail, inviteMessage, viewShareMessage, successorAskMessage, claimNoticeMessage, claimCancelledMessage, handoverMessage, successorNamedMessage } from './mail.mjs';
import { RULES } from './rules.mjs';
import { FEATURES } from './validate.mjs';

// Signed in, and one of `roles` on this altar; otherwise a Response to send back.
export async function asRole(request, env, deps, id, roles) {
  const s = await requireUser(request, env, deps);
  if (isResponse(s)) return s;
  const role = await store.getRole(env.DB, id, s.user.id);
  return role && roles.includes(role) ? { ...s, role } : json({ error: 'forbidden' }, 403);
}

// ---------- the team ----------
export async function handleTeam(request, env, deps, id) {
  const s = await asRole(request, env, deps, id, ['owner', 'keeper']);
  if (isResponse(s)) return s;
  const members = (await store.listMembers(env.DB, id)).map(m => ({ userId: m.user_id, email: m.email, role: m.role }));
  // Which upgrades apply here (bought for the altar, or through the owner's platinum plan), so the page can
  // switch the matching options on in the editor. The server still enforces every limit on save.
  const entitlements = await store.getEntitlements(env.DB, id, FEATURES);
  const slug = await store.currentSlug(env.DB, id);
  if (s.role !== 'owner') return json({ role: s.role, members, entitlements, slug });
  const now = deps.now();
  const successor = await store.getSuccessor(env.DB, id);
  const claim = await store.getClaim(env.DB, id);
  const handover = await store.getHandover(env.DB, id);
  return json({
    role: 'owner',
    members,
    entitlements,
    slug,
    invites: (await store.listInvites(env.DB, id, now)).map(i => ({ id: i.id, email: i.email, expiresAt: i.expires_at })),
    handover: handover ? { email: handover.to_email, expiresAt: handover.expires_at } : null,
    successor: successor ? { email: successor.email, accepted: !!successor.accepted_user_id, waitMonths: monthsFor(successor.inactive_ms), auto: !!successor.auto_transfer } : null,
    claim: claim && !claim.cancelled_at && !claim.completed_at ? { requestedAt: claim.requested_at, executesAt: claim.executes_at } : null,
  });
}

// The optional note that travels with a shared link or invitation. It is plain text in an email that goes out
// from our domain to someone the owner chose, so it is short and cannot carry a web address.
// Returns the cleaned note ('' for none), or an error code.
const LINKISH = /https?:|www\.|\b[a-z0-9-]{2,}\.(?:com|net|org|io|co|app|me|ly|xyz|info|gg|dev|site|online|top|link|click)\b/i;
export function cleanNote(v) {
  if (v == null || v === '') return { note: '' };
  if (typeof v !== 'string') return { error: 'bad_note' };
  const note = v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\r\n?/g, '\n').trim();
  if (note.length > RULES.noteMax) return { error: 'note_too_long' };
  if (LINKISH.test(note)) return { error: 'note_has_link' };
  return { note };
}

// The loved one's name as the owner typed it into the altar, made safe for a subject line.
export async function altarName(env, id) {
  try {
    const row = await store.getAltar(env.DB, id);
    const name = row?.state ? JSON.parse(row.state).name : '';
    const clean = typeof name === 'string' ? name.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) : '';
    return clean === RULES.starterName ? '' : clean; // the placeholder is not a loved one's name
  } catch { return ''; }
}

export async function handleInvite(request, env, deps, id) {
  const s = await asRole(request, env, deps, id, ['owner']);
  if (isResponse(s)) return s;
  const body = await readJson(request);
  if (isResponse(body)) return body;
  const email = normalizeEmail(body.email);
  if (!email) return json({ error: 'bad_email', message: 'Enter a valid email address.' }, 400);
  return sendInvite(env, deps, id, s, email, '');
}

// "View and edit": make the person a co-keeper (once they sign in with this address and accept).
async function sendInvite(env, deps, id, s, email, note) {
  const now = deps.now();
  const members = await store.listMembers(env.DB, id);
  const pending = await store.listInvites(env.DB, id, now);
  if (members.some(m => m.email === email)) return json({ error: 'already_member' }, 409);
  if (pending.some(i => i.email === email)) return json({ error: 'already_invited' }, 409);
  if (members.length - 1 + pending.length >= RULES.maxKeepers) return json({ error: 'too_many_keepers' }, 409);
  if ((await store.countInvitesSince(env.DB, email, now - DAY)) >= RULES.invitesPerEmailPerDay) return json({ error: 'too_many_invites' }, 429);

  const token = newToken();
  const inviteId = newId(8);
  await store.addInvite(env.DB, { id: inviteId, tokenHash: await sha256Hex(token), altarId: id, email, invitedBy: s.user.id, now, ttl: RULES.inviteTtl });
  const name = await altarName(env, id);
  queueMail(deps, () => deps.mailer.send(inviteMessage({ to: email, from: s.user.email, link: `${env.APP_URL}/invite#i=${token}`, name, note })));
  return json({ id: inviteId, access: 'edit' }, 201);
}

// "View only": email the link. Anyone who has the link can view an ofrenda, so this grants nothing new; it is a
// courtesy that says who it is from. Only a hash of the address is kept, to stop one inbox being flooded.
async function sendViewLink(env, deps, id, s, email, note) {
  const now = deps.now();
  const members = await store.listMembers(env.DB, id);
  if (members.some(m => m.email === email)) return json({ error: 'already_member' }, 409);
  const emailHash = await sha256Hex(email);
  if ((await store.countViewSharesToEmail(env.DB, emailHash, now - DAY)) >= RULES.sharesPerEmailPerDay) return json({ error: 'too_many_shares' }, 429);
  if ((await store.countViewSharesFromAltar(env.DB, id, now - DAY)) >= RULES.sharesPerAltarPerDay) return json({ error: 'share_limit' }, 429);

  await store.addViewShare(env.DB, { id: newId(8), altarId: id, sharedBy: s.user.id, emailHash, now });
  const ref = (await store.currentSlug(env.DB, id)) || id;
  const name = await altarName(env, id);
  queueMail(deps, () => deps.mailer.send(viewShareMessage({ to: email, from: s.user.email, link: `${env.APP_URL}/a/${ref}`, name, note })));
  return json({ access: 'view' }, 201);
}

// One door for sharing: the owner picks what the person can do.
//   access "view"  -> they get the link and can look
//   access "edit"  -> they are invited as a co-keeper and can look and edit
export async function handleShare(request, env, deps, id) {
  const s = await asRole(request, env, deps, id, ['owner']);
  if (isResponse(s)) return s;
  const body = await readJson(request);
  if (isResponse(body)) return body;
  if (body.access !== 'view' && body.access !== 'edit') return json({ error: 'bad_access', message: 'Choose view only, or view and edit.' }, 400);
  const email = normalizeEmail(body.email);
  if (!email) return json({ error: 'bad_email', message: 'Enter a valid email address.' }, 400);
  const cleaned = cleanNote(body.note);
  if (cleaned.error) return json({ error: cleaned.error }, 400);
  return body.access === 'edit' ? sendInvite(env, deps, id, s, email, cleaned.note) : sendViewLink(env, deps, id, s, email, cleaned.note);
}

export async function handleRevokeInvite(request, env, deps, id, inviteId) {
  const s = await asRole(request, env, deps, id, ['owner']);
  if (isResponse(s)) return s;
  return (await store.revokeInvite(env.DB, id, inviteId, deps.now())) ? json({ ok: true }) : json({ error: 'not_found' }, 404);
}

export async function handleAcceptInvite(request, env, deps) {
  const s = await requireUser(request, env, deps);
  if (isResponse(s)) return s;
  const body = await readJson(request);
  if (isResponse(body)) return body;
  if (typeof body.token !== 'string' || body.token.length > 200) return json({ error: 'invalid_or_expired' }, 400);
  const altarId = await store.acceptInvite(env.DB, { tokenHash: await sha256Hex(body.token), userId: s.user.id, email: s.user.email, now: deps.now() });
  return altarId ? json({ id: altarId }) : json({ error: 'invalid_or_expired' }, 400);
}

// The owner removes a co-keeper, or a co-keeper removes themselves. The owner cannot be removed.
export async function handleRemoveMember(request, env, deps, id, userId) {
  const s = await asRole(request, env, deps, id, ['owner', 'keeper']);
  if (isResponse(s)) return s;
  if (userId !== s.user.id && s.role !== 'owner') return json({ error: 'forbidden' }, 403);
  if (userId !== s.user.id && (await store.getRole(env.DB, id, userId)) === 'owner') {
    return json({ error: 'owners_cannot_remove_owners', message: 'Owners can’t remove each other. Each owner can only step away themselves.' }, 403);
  }
  if (userId === s.user.id && s.role === 'owner') {
    return (await store.leaveAsOwner(env.DB, id, userId)) ? json({ ok: true })
      : json({ error: 'owner_cannot_leave', message: 'You are the only owner. Hand the ofrenda to someone else or delete it.' }, 400);
  }
  return (await store.removeMember(env.DB, id, userId)) ? json({ ok: true }) : json({ error: 'not_found' }, 404);
}

// ---------- successor ----------
const monthsFor = days => (days <= RULES.successorWaits[6] ? 6 : 12);
// How long the owner must be away, and whether the notice then starts by itself: 12 months and automatic unless
// they say otherwise. Returns {inactiveMs, auto} or {error}.
function readWait(body) {
  const months = body.waitMonths ?? 12;
  const inactiveMs = RULES.successorWaits[months];
  if (!inactiveMs) return { error: 'bad_wait' };
  if (body.auto !== undefined && typeof body.auto !== 'boolean') return { error: 'bad_wait' };
  return { inactiveMs, auto: body.auto ?? true };
}
const BAD_WAIT = () => json({ error: 'bad_wait', message: 'Choose 6 or 12 months, and on or off for automatic transfer.' }, 400);

export async function handleSetSuccessor(request, env, deps, id) {
  const s = await asRole(request, env, deps, id, ['owner']);
  if (isResponse(s)) return s;
  const body = await readJson(request);
  if (isResponse(body)) return body;
  const email = normalizeEmail(body.email);
  if (!email) return json({ error: 'bad_email', message: 'Enter a valid email address.' }, 400);
  if (email === s.user.email) return json({ error: 'bad_email', message: 'Choose someone other than yourself.' }, 400);
  const wait = readWait(body);
  if (wait.error) return BAD_WAIT();
  const now = deps.now();
  const current = await store.getSuccessor(env.DB, id);
  if (current && now - current.designated_at < 3_600_000) return json({ error: 'too_soon' }, 429); // no re-sending to one inbox in a loop
  const token = newToken();
  await store.revokeSuccessorAccess(env.DB, id); // a new request starts over: the old agreement, and its access, are gone
  await store.setSuccessor(env.DB, { altarId: id, email, tokenHash: await sha256Hex(token), designatedBy: s.user.id, now, ...wait });
  await store.cancelClaim(env.DB, id, now); // a different successor cannot ride on an old request
  queueMail(deps, () => deps.mailer.send(successorAskMessage({ to: email, from: s.user.email, link: `${env.APP_URL}/successor#s=${token}` })));
  queueMail(deps, () => deps.mailer.send(successorNamedMessage({ to: s.user.email, successor: email, ...wait })));
  return json({ ok: true });
}

// Change how long, and whether it starts by itself, without asking the successor again.
export async function handleSuccessorSettings(request, env, deps, id) {
  const s = await asRole(request, env, deps, id, ['owner']);
  if (isResponse(s)) return s;
  const body = await readJson(request);
  if (isResponse(body)) return body;
  const wait = readWait(body);
  if (wait.error) return BAD_WAIT();
  return (await store.updateSuccessorSettings(env.DB, { altarId: id, ...wait })) ? json({ ok: true }) : json({ error: 'not_found' }, 404);
}

export async function handleClearSuccessor(request, env, deps, id) {
  const s = await asRole(request, env, deps, id, ['owner']);
  if (isResponse(s)) return s;
  await store.revokeSuccessorAccess(env.DB, id);
  await store.clearSuccessor(env.DB, id);
  await store.cancelClaim(env.DB, id, deps.now());
  return json({ ok: true });
}

export async function handleAcceptSuccessor(request, env, deps) {
  const s = await requireUser(request, env, deps);
  if (isResponse(s)) return s;
  const body = await readJson(request);
  if (isResponse(body)) return body;
  if (typeof body.token !== 'string' || body.token.length > 200) return json({ error: 'invalid_or_expired' }, 400);
  const row = await store.acceptSuccessor(env.DB, { tokenHash: await sha256Hex(body.token), userId: s.user.id, email: s.user.email, now: deps.now() });
  if (!row) return json({ error: 'invalid_or_expired' }, 400);
  await store.grantSuccessorAccess(env.DB, row.altar_id, s.user.id, deps.now()); // agreeing makes them a co-keeper
  return json({ id: row.altar_id });
}

// ---------- takeover ----------
async function asSuccessor(request, env, deps, id) {
  const s = await requireUser(request, env, deps);
  if (isResponse(s)) return s;
  const succ = await store.getSuccessor(env.DB, id);
  return succ?.accepted_user_id === s.user.id ? s : json({ error: 'forbidden' }, 403);
}

export async function handleClaim(request, env, deps, id) {
  const s = await asSuccessor(request, env, deps, id);
  if (isResponse(s)) return s;
  const owners = await store.getOwners(env.DB, id);
  if (!owners.length || owners.some(o => o.id === s.user.id)) return json({ error: 'not_found' }, 404);
  const now = deps.now();
  const succ = await store.getSuccessor(env.DB, id);
  const eligibleAt = Math.max(...owners.map(o => o.last_seen_at)) + (succ?.inactive_ms ?? RULES.inactiveAfter); // every owner must have gone quiet
  if (now < eligibleAt) return json({ error: 'owner_active', eligibleAt }, 403);
  const executesAt = now + RULES.claimWait;
  if (!(await store.createClaim(env.DB, { altarId: id, requestedBy: s.user.id, now, executesAt }))) return json({ error: 'claim_in_progress' }, 409);
  for (const o of owners) queueMail(deps, () => deps.mailer.send(claimNoticeMessage({ to: o.email, from: s.user.email, executesAt })));
  return json({ executesAt }, 201);
}

// The owner stops it, or the successor withdraws it.
export async function handleCancelClaim(request, env, deps, id) {
  const s = await requireUser(request, env, deps);
  if (isResponse(s)) return s;
  const role = await store.getRole(env.DB, id, s.user.id);
  const succ = await store.getSuccessor(env.DB, id);
  const asOwner = role === 'owner';
  if (!asOwner && succ?.accepted_user_id !== s.user.id) return json({ error: 'forbidden' }, 403);
  const cancelled = await store.cancelClaim(env.DB, id, deps.now());
  if (cancelled && asOwner && succ?.accepted_user_id) {
    const them = await store.getUser(env.DB, succ.accepted_user_id);
    if (them) queueMail(deps, () => deps.mailer.send(claimCancelledMessage({ to: them.email })));
  }
  return json({ ok: true, cancelled });
}

export async function handleCompleteClaim(request, env, deps, id) {
  const s = await asSuccessor(request, env, deps, id);
  if (isResponse(s)) return s;
  const claim = await store.getClaim(env.DB, id);
  if (!claim || claim.cancelled_at || claim.completed_at) return json({ error: 'no_claim' }, 409);
  if (claim.requested_by !== s.user.id) return json({ error: 'forbidden' }, 403);
  if (deps.now() < claim.executes_at) return json({ error: 'too_early', executesAt: claim.executes_at }, 403);
  const r = await finishTakeover(env, deps, id, claim, s.user);
  return r === 'ok' ? json({ ok: true, role: 'owner' }) : json({ error: r === 'owner_active' ? 'owner_active' : 'no_claim' }, 409);
}

// Gives the ofrenda to the successor once the notice has run its course (used by the successor's own request and by
// the daily job). Returns 'ok', 'owner_active' (an owner came back, so it is cancelled) or 'no_claim'.
export async function finishTakeover(env, deps, id, claim, successor) {
  const owners = await store.getOwners(env.DB, id);
  if (!owners.length) return 'no_claim';
  const now = deps.now();
  if (owners.some(o => o.last_seen_at > claim.requested_at)) { // belt and braces: activity normally cancels the claim already
    await store.cancelClaim(env.DB, id, now);
    return 'owner_active';
  }
  if (!(await store.finishClaim(env.DB, { altarId: id, now }))) return 'no_claim';
  try {
    await store.handOver(env.DB, { altarId: id, newOwnerId: successor.id, now, grants: owners.some(o => o.plan === 'platinum') ? FEATURES : [] });
  } catch (e) {
    await store.reopenClaim(env.DB, id);
    throw e;
  }
  for (const o of owners) queueMail(deps, () => deps.mailer.send(handoverMessage({ to: o.email, role: 'keeper' })));
  queueMail(deps, () => deps.mailer.send(handoverMessage({ to: successor.email, role: 'owner' })));
  return 'ok';
}
