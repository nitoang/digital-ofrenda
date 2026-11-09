// Passwordless sign-in and sessions.
//
// Sign-in and sign-up are one flow. You enter an email, we send a link and a 6-digit code (two ways to use
// the same one-time challenge), and redeeming either proves you control the address. A user row is created
// only at that moment, so no account ever exists for an address nobody has proven. The reply to "start" does
// not depend on whether the address is known, so it reveals nothing.
//
// A session is a random 256-bit value in a __Host- cookie (Secure, HttpOnly, SameSite=Lax, no Domain). Only
// its hash is stored. It lasts RULES.sessionTtl and is renewed when used, since people return after months.
//
// Known limit: a sign-in link signs in whichever browser opens it. If someone talks you into opening a link
// they requested, you'd be signed in to THEIR account; the page shows the email you were signed in as.

import { json, readJson, isResponse, normalizeEmail, sha256Hex, newToken, newId, newCode, timingSafeEqual } from './util.mjs';
import * as store from './store.mjs';
import { queueMail, signInMessage, claimCancelledMessage } from './mail.mjs';
import { RULES } from './rules.mjs';

const COOKIE = '__Host-session';
const cookie = (value, maxAgeSec) => `${COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}`;
const SESSION_RE = new RegExp(`(?:^|;\\s*)${COOKIE}=([A-Za-z0-9_-]{43})(?:;|$)`);

// Fail closed: without a Turnstile secret these requests are refused, unless development mode is explicit.
export async function turnstileOk(request, env, deps, token) {
  if (env.TURNSTILE_DISABLED === '1' && !env.TURNSTILE_SECRET) return true;
  if (typeof token !== 'string' || !token || token.length > 2048) return false;
  const form = new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token });
  const ip = request.headers.get('cf-connecting-ip');
  if (ip) form.set('remoteip', ip);
  try {
    const res = await deps.fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
    return (await res.json()).success === true;
  } catch { return false; }
}

// The owner showing up again cancels any takeover request, and the would-be successor is told.
export async function noteActivity(env, deps, userId) {
  const now = deps.now();
  await store.touchUser(env.DB, userId, now);
  for (const c of await store.cancelClaimsOwnedBy(env.DB, userId, now)) {
    const requester = await store.getUser(env.DB, c.requested_by);
    if (requester) queueMail(deps, () => deps.mailer.send(claimCancelledMessage({ to: requester.email })));
  }
}

// The signed-in user for this request, or null.
export async function sessionFrom(request, env, deps) {
  const m = SESSION_RE.exec(request.headers.get('cookie') || '');
  if (!m) return null;
  const idHash = await sha256Hex(m[1]);
  const now = deps.now();
  const row = await store.getSession(env.DB, idHash, now);
  if (!row) return null;
  if (now - row.last_used_at > RULES.sessionRenewAfter) await store.renewSession(env.DB, idHash, now, RULES.sessionTtl);
  if (now - row.last_seen_at > RULES.seenAfter) await noteActivity(env, deps, row.user_id);
  return { idHash, user: { id: row.user_id, email: row.email, plan: row.plan } };
}

// For routes that need a signed-in user: the session, or a 401 Response to send back.
export async function requireUser(request, env, deps) {
  return (await sessionFrom(request, env, deps)) ?? json({ error: 'sign_in_required' }, 401);
}

export async function handleStart(request, env, deps) {
  const body = await readJson(request);
  if (isResponse(body)) return body;
  const email = normalizeEmail(body.email);
  if (!email) return json({ error: 'bad_email', message: 'Enter a valid email address.' }, 400);
  if (!(await turnstileOk(request, env, deps, body.turnstile))) return json({ error: 'turnstile_failed' }, 403);

  const now = deps.now();
  await store.purgeExpired(env.DB, now);
  const challenge = newToken();
  // Over the limit we answer exactly the same way but send nothing, so the limit itself leaks nothing either.
  if ((await store.countLoginChallengesSince(env.DB, email, now - 3_600_000)) < RULES.loginsPerEmailPerHour) {
    const linkToken = newToken();
    const code = newCode();
    await store.addLoginChallenge(env.DB, {
      challenge, linkHash: await sha256Hex(linkToken), codeHash: await sha256Hex(`${challenge}:${code}`), email, now, ttl: RULES.loginTtl,
    });
    queueMail(deps, () => deps.mailer.send(signInMessage({ to: email, link: `${env.APP_URL}/signin#t=${linkToken}`, code })));
  }
  return json({ challenge });
}

async function startSession(env, deps, email) {
  const now = deps.now();
  const user = await store.findOrCreateUser(env.DB, { id: newId(), email, now });
  await noteActivity(env, deps, user.id);
  const token = newToken();
  await store.createSession(env.DB, { idHash: await sha256Hex(token), userId: user.id, now, ttl: RULES.sessionTtl });
  return json({ email: user.email, plan: user.plan ?? null }, 200, { 'set-cookie': cookie(token, Math.floor(RULES.sessionTtl / 1000)) });
}

export async function handleRedeemLink(request, env, deps) {
  const body = await readJson(request);
  if (isResponse(body)) return body;
  if (typeof body.token !== 'string' || body.token.length > 200) return json({ error: 'invalid_or_expired' }, 400);
  const claimed = await store.redeemLoginLink(env.DB, { linkHash: await sha256Hex(body.token), now: deps.now() });
  if (!claimed) return json({ error: 'invalid_or_expired' }, 400);
  return startSession(env, deps, claimed.email);
}

export async function handleRedeemCode(request, env, deps) {
  const body = await readJson(request);
  if (isResponse(body)) return body;
  if (typeof body.challenge !== 'string' || body.challenge.length > 100 || !/^\d{6}$/.test(String(body.code))) {
    return json({ error: 'invalid_or_expired' }, 400);
  }
  const now = deps.now();
  const row = await store.countLoginAttempt(env.DB, { challenge: body.challenge, now, maxAttempts: RULES.codeAttempts });
  if (!row || !timingSafeEqual(await sha256Hex(`${body.challenge}:${body.code}`), row.code_hash)) return json({ error: 'invalid_or_expired' }, 400);
  const claimed = await store.useLoginChallenge(env.DB, { challenge: body.challenge, now });
  if (!claimed) return json({ error: 'invalid_or_expired' }, 400);
  return startSession(env, deps, claimed.email);
}

export async function handleLogout(request, env, deps) {
  const s = await sessionFrom(request, env, deps);
  if (s) await store.deleteSession(env.DB, s.idHash);
  return json({ ok: true }, 200, { 'set-cookie': cookie('', 0) });
}

export async function handleLogoutEverywhere(request, env, deps) {
  const s = await requireUser(request, env, deps);
  if (isResponse(s)) return s;
  await store.deleteSessionsForUser(env.DB, s.user.id);
  return json({ ok: true }, 200, { 'set-cookie': cookie('', 0) });
}
