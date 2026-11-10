// The signed-in person's own account: changing the email address, and deleting the account.
//
// Changing email: POST /me/email {email} sends a 6-digit code to the NEW address; POST /me/email/confirm {code}
// switches it. Until the code is entered nothing changes, so nobody can point an account at an address they do
// not control. On success every other device is signed out and the OLD address is told, so a stolen session
// cannot quietly move an account away from its owner.
//
// Deleting: DELETE /me {email, deleteOfrendas?}. The email must be typed back as a check against a stray
// click. Ofrendas that other people keep are passed on to them (see owners.mjs). If you own ones nobody else
// keeps, you must say so: deleteOfrendas=true deletes those, and without it the request is refused with the
// counts so the page can ask.

import { json, readJson, isResponse, normalizeEmail, sha256Hex, newCode, timingSafeEqual } from './util.mjs';
import * as store from './store.mjs';
import { requireUser } from './auth.mjs';
import { queueMail, emailChangeCodeMessage, emailChangedNoticeMessage } from './mail.mjs';
import { RULES } from './rules.mjs';
import { retireOwner } from './owners.mjs';

const clearCookie = '__Host-session=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0';
const codeHash = (userId, email, code) => sha256Hex(`${userId}:${email}:${code}`);

export async function handleStartEmailChange(request, env, deps) {
  const s = await requireUser(request, env, deps);
  if (isResponse(s)) return s;
  const body = await readJson(request);
  if (isResponse(body)) return body;
  const email = normalizeEmail(body.email);
  if (!email) return json({ error: 'bad_email', message: 'Enter a valid email address.' }, 400);
  if (email === s.user.email) return json({ error: 'same_email', message: 'That is already your email address.' }, 400);

  const code = newCode();
  const now = deps.now();
  const ok = await store.startEmailChange(env.DB, {
    userId: s.user.id, newEmail: email, codeHash: await codeHash(s.user.id, email, code), now, ttl: RULES.emailChangeTtl, maxPerHour: RULES.emailChangesPerHour,
  });
  if (!ok) return json({ error: 'too_many', message: 'Too many tries. Please wait a while and try again.' }, 429);
  // The reply does not say whether the address already has an account; that only comes out, to someone who
  // can read that mailbox, when the code is entered.
  queueMail(deps, () => deps.mailer.send(emailChangeCodeMessage({ to: email, code })));
  return json({ sent: true, email, expiresAt: now + RULES.emailChangeTtl });
}

export async function handleConfirmEmailChange(request, env, deps) {
  const s = await requireUser(request, env, deps);
  if (isResponse(s)) return s;
  const body = await readJson(request);
  if (isResponse(body)) return body;
  const bad = () => json({ error: 'invalid_or_expired', message: 'That code is wrong or has expired.' }, 400);
  if (!/^\d{6}$/.test(String(body.code))) return bad();

  const pending = await store.countEmailChangeAttempt(env.DB, { userId: s.user.id, now: deps.now(), maxAttempts: RULES.emailChangeAttempts });
  if (!pending || !timingSafeEqual(await codeHash(s.user.id, pending.new_email, body.code), pending.code_hash)) return bad();

  try {
    await store.applyEmailChange(env.DB, { userId: s.user.id, newEmail: pending.new_email, keepSession: s.idHash });
  } catch (e) {
    if (!/unique|constraint/i.test(String(e?.message))) throw e;
    await store.cancelEmailChange(env.DB, s.user.id);
    return json({ error: 'email_unavailable', message: 'That email address is already used by another account.' }, 409);
  }
  queueMail(deps, () => deps.mailer.send(emailChangedNoticeMessage({ to: s.user.email, newEmail: pending.new_email })));
  return json({ email: pending.new_email });
}

export async function handleDeleteAccount(request, env, deps) {
  const s = await requireUser(request, env, deps);
  if (isResponse(s)) return s;
  const body = await readJson(request);
  if (isResponse(body)) return body;
  if (normalizeEmail(body.email) !== s.user.email) return json({ error: 'email_mismatch', message: 'Type your email address exactly to confirm.' }, 400);

  // Ofrendas other people keep are passed on to them, never erased. Only the ones nobody else keeps are deleted,
  // and the person has to say so.
  const owned = await store.ownedAltars(env.DB, s.user.id);
  const erased = owned.filter(a => a.others === 0).length;
  if (erased > 0 && body.deleteOfrendas !== true) {
    return json({ error: 'owns_ofrendas', owned: erased, handedOn: owned.length - erased,
      message: 'You own ofrendas that nobody else keeps. Deleting your account deletes them. Ofrendas other people keep are passed on to them instead.' }, 409);
  }
  for (const a of owned) await retireOwner(env, deps, a.id, s.user);
  await store.deleteAccount(env.DB, { userId: s.user.id, email: s.user.email });
  return json({ ok: true }, 200, { 'set-cookie': clearCookie });
}
