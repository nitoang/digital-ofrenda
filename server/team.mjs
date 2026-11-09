// Who keeps an altar: co-keepers (invited by email), a successor (who agrees in advance), and the takeover
// that lets the successor inherit an altar whose owner has gone quiet.
//
// Takeover rules, all in RULES (rules.mjs):
//   1. The successor must have accepted. Naming someone gives them no access at all.
//   2. The owner must not have been seen for `inactiveAfter` (180 days).
//   3. The successor asks. The owner is emailed and has `claimWait` (30 days) to stop it, and simply
//      signing in at any time cancels it, so a person who is only grieving quietly is never overtaken.
//   4. After the wait, the successor completes it. They become owner; the old owner stays on as a co-keeper.
//      Upgrades the old owner's platinum plan was providing are written onto the altar so the family keeps them.
// Nothing needs a scheduled job: each step is a request someone makes.

import { json, readJson, isResponse, normalizeEmail, sha256Hex, newToken, newId, DAY } from './util.mjs';
import * as store from './store.mjs';
import { requireUser } from './auth.mjs';
import { queueMail, inviteMessage, successorAskMessage, claimNoticeMessage, claimCancelledMessage, handoverMessage } from './mail.mjs';
import { RULES } from './rules.mjs';
import { FEATURES } from './validate.mjs';

// Signed in, and one of `roles` on this altar; otherwise a Response to send back.
async function asRole(request, env, deps, id, roles) {
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
  return json({
    role: 'owner',
    members,
    entitlements,
    slug,
    invites: (await store.listInvites(env.DB, id, now)).map(i => ({ id: i.id, email: i.email, expiresAt: i.expires_at })),
    successor: successor ? { email: successor.email, accepted: !!successor.accepted_user_id } : null,
    claim: claim && !claim.cancelled_at && !claim.completed_at ? { requestedAt: claim.requested_at, executesAt: claim.executes_at } : null,
  });
}

export async function handleInvite(request, env, deps, id) {
  const s = await asRole(request, env, deps, id, ['owner']);
  if (isResponse(s)) return s;
  const body = await readJson(request);
  if (isResponse(body)) return body;
  const email = normalizeEmail(body.email);
  if (!email) return json({ error: 'bad_email', message: 'Enter a valid email address.' }, 400);
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
  queueMail(deps, () => deps.mailer.send(inviteMessage({ to: email, from: s.user.email, link: `${env.APP_URL}/invite#i=${token}` })));
  return json({ id: inviteId }, 201);
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
  if (userId === s.user.id && s.role === 'owner') return json({ error: 'owner_cannot_leave', message: 'Hand the ofrenda to someone else or delete it.' }, 400);
  if (userId !== s.user.id && s.role !== 'owner') return json({ error: 'forbidden' }, 403);
  return (await store.removeMember(env.DB, id, userId)) ? json({ ok: true }) : json({ error: 'not_found' }, 404);
}

// ---------- successor ----------
export async function handleSetSuccessor(request, env, deps, id) {
  const s = await asRole(request, env, deps, id, ['owner']);
  if (isResponse(s)) return s;
  const body = await readJson(request);
  if (isResponse(body)) return body;
  const email = normalizeEmail(body.email);
  if (!email) return json({ error: 'bad_email', message: 'Enter a valid email address.' }, 400);
  if (email === s.user.email) return json({ error: 'bad_email', message: 'Choose someone other than yourself.' }, 400);
  const now = deps.now();
  const current = await store.getSuccessor(env.DB, id);
  if (current && now - current.designated_at < 3_600_000) return json({ error: 'too_soon' }, 429); // no re-sending to one inbox in a loop
  const token = newToken();
  await store.setSuccessor(env.DB, { altarId: id, email, tokenHash: await sha256Hex(token), designatedBy: s.user.id, now });
  await store.cancelClaim(env.DB, id, now); // a different successor cannot ride on an old request
  queueMail(deps, () => deps.mailer.send(successorAskMessage({ to: email, from: s.user.email, link: `${env.APP_URL}/successor#s=${token}` })));
  return json({ ok: true });
}

export async function handleClearSuccessor(request, env, deps, id) {
  const s = await asRole(request, env, deps, id, ['owner']);
  if (isResponse(s)) return s;
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
  return row ? json({ id: row.altar_id }) : json({ error: 'invalid_or_expired' }, 400);
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
  const owner = await store.getOwner(env.DB, id);
  if (!owner || owner.id === s.user.id) return json({ error: 'not_found' }, 404);
  const now = deps.now();
  const eligibleAt = owner.last_seen_at + RULES.inactiveAfter;
  if (now < eligibleAt) return json({ error: 'owner_active', eligibleAt }, 403);
  const executesAt = now + RULES.claimWait;
  if (!(await store.createClaim(env.DB, { altarId: id, requestedBy: s.user.id, now, executesAt }))) return json({ error: 'claim_in_progress' }, 409);
  queueMail(deps, () => deps.mailer.send(claimNoticeMessage({ to: owner.email, from: s.user.email, executesAt })));
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
  const owner = await store.getOwner(env.DB, id);
  if (!claim || claim.cancelled_at || claim.completed_at || !owner) return json({ error: 'no_claim' }, 409);
  const now = deps.now();
  if (claim.requested_by !== s.user.id) return json({ error: 'forbidden' }, 403);
  if (now < claim.executes_at) return json({ error: 'too_early', executesAt: claim.executes_at }, 403);
  if (owner.last_seen_at > claim.requested_at) { // belt and braces: activity normally cancels the claim already
    await store.cancelClaim(env.DB, id, now);
    return json({ error: 'owner_active' }, 409);
  }
  if (!(await store.finishClaim(env.DB, { altarId: id, now }))) return json({ error: 'no_claim' }, 409);
  try {
    await store.handOver(env.DB, { altarId: id, oldOwnerId: owner.id, newOwnerId: s.user.id, now, grants: owner.plan === 'platinum' ? FEATURES : [] });
  } catch (e) {
    await store.reopenClaim(env.DB, id);
    throw e;
  }
  queueMail(deps, () => deps.mailer.send(handoverMessage({ to: owner.email, role: 'keeper' })));
  queueMail(deps, () => deps.mailer.send(handoverMessage({ to: s.user.email, role: 'owner' })));
  return json({ ok: true, role: 'owner' });
}
