// Example Cloudflare Worker for digital-ofrenda: signup, email confirmation and recovery, saving, and
// the Stripe webhook that unlocks paid upgrades. A starting point, not a drop-in product.
//
// Bindings (see wrangler.example.toml):
//   DB                      D1 database; schema in migrations/0001_init.sql
//   MAILER                  service binding to a Worker that sends email (see mail.mjs)
//   APP_URL                 your site, e.g. "https://ofrenda.example.com" (used for links in emails)
//   TURNSTILE_SECRET        Cloudflare Turnstile secret; signup and recovery refuse requests without a valid
//                           token. Set TURNSTILE_DISABLED="1" instead ONLY for local development.
//   STRIPE_WEBHOOK_SECRET   whsec_... from Stripe
//   ALLOW_ORIGIN            optional CORS origin; CORS is off unless set
//
// Routes:
//   POST /ofrendas                       {email, turnstile}     -> 201 {id, token}   token is shown once
//   GET  /ofrendas/:id                                          -> altar JSON (public)
//   PUT  /ofrendas/:id                   Bearer edit token      -> save (limits enforced)
//   POST /ofrendas/:id/verify            {token}                -> confirm the email address
//   POST /ofrendas/:id/verify/resend     Bearer edit token      -> send the confirmation email again
//   POST /ofrendas/:id/rotate            Bearer edit token      -> new edit token; the old one stops working
//   POST /recover                        {email, turnstile}     -> always 200; emails recovery links
//   POST /ofrendas/:id/recover           {token}                -> new edit token (from the emailed link)
//   POST /stripe/webhook                 Stripe signature       -> grants checkout.session metadata.feature
//
// Rate limiting by IP belongs at the edge: add a Cloudflare rate-limiting rule for POST /ofrendas and /recover.
// What is limited here is per email address, so one inbox cannot be flooded.

import { validateOfrenda, FEATURES } from './validate.mjs';
import * as store from './store.mjs';
import { mailerFromEnv, verifyMessage, recoverMessage } from './mail.mjs';

export const MAX_BODY_BYTES = 2_500_000;
const SMALL_BODY = 10_000;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const HOUR = 3_600_000;
export const TOKEN_RULES = Object.freeze({
  verifyTtl: 24 * HOUR,
  recoverTtl: 30 * 60_000,
  verifyPerEmailPerHour: 3,
  recoverTokensPerEmailPerHour: 20,
  recoverLinksPerEmail: 10,
});

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra } });

const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const sha256Hex = async s => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const newToken = () => b64url(crypto.getRandomValues(new Uint8Array(32))); // 256 bits
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'; // 32 symbols, so a 5-bit mask has no modulo bias
const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), b => ID_ALPHABET[b & 31]).join('');

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// Read at most `max` bytes, refusing early on Content-Length and again while streaming (the header can lie).
async function readBody(request, max) {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { all.set(c, o); o += c.length; }
  return new TextDecoder().decode(all);
}

// Small JSON bodies for the signup/recovery routes. Returns the object, or a Response to send back.
async function readJson(request) {
  const raw = await readBody(request, SMALL_BODY);
  if (raw === null) return json({ error: 'too_large' }, 413);
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : json({ error: 'bad_json' }, 400);
  } catch { return json({ error: 'bad_json' }, 400); }
}

function normalizeEmail(v) {
  if (typeof v !== 'string') return null;
  const e = v.trim().toLowerCase();
  if (e.length > 254 || !/^[^\s@<>(),;:"\\]{1,64}@[^\s@<>(),;:"\\]{1,190}\.[^\s@<>(),;:"\\.]{2,}$/.test(e)) return null;
  return e;
}

async function authorized(request, altar) {
  const m = /^Bearer ([A-Za-z0-9_-]{16,200})$/.exec(request.headers.get('authorization') || '');
  if (!m || !altar) return false;
  return timingSafeEqual(await sha256Hex(m[1]), altar.token_hash);
}

const misconfigured = what => { console.error('digital-ofrenda worker is missing configuration: ' + what); return json({ error: 'misconfigured' }, 500); };
const appUrlOk = env => /^(https:\/\/[a-z0-9.-]+(:\d+)?|http:\/\/localhost(:\d+)?)$/i.test(env.APP_URL || '');

// Fail closed: without a Turnstile secret these routes refuse everything, unless development mode is explicit.
async function turnstileOk(request, env, deps, token) {
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

function checkSignupConfig(env, deps) {
  if (!env.DB) return misconfigured('DB');
  if (!appUrlOk(env)) return misconfigured('APP_URL');
  if (!deps.mailer) return misconfigured('MAILER');
  if (!env.TURNSTILE_SECRET && env.TURNSTILE_DISABLED !== '1') return misconfigured('TURNSTILE_SECRET');
  return null;
}

// Create a one-time token, email its link, and never let a mail failure break the request.
function queueMail(deps, work) {
  deps.defer(Promise.resolve().then(work).catch(e => console.error('email not sent:', e?.message)));
}

async function sendVerification(env, deps, altar) {
  const now = deps.now();
  const recent = await store.countEmailTokensSince(env.DB, altar.email, 'verify', now - HOUR);
  if (recent >= TOKEN_RULES.verifyPerEmailPerHour) return false;
  const token = newToken();
  await store.addEmailToken(env.DB, { tokenHash: await sha256Hex(token), altarId: altar.id, purpose: 'verify', email: altar.email, now, ttl: TOKEN_RULES.verifyTtl });
  queueMail(deps, () => deps.mailer.send(verifyMessage({ to: altar.email, link: `${env.APP_URL}/a/${altar.id}#v=${token}` })));
  return true;
}

async function handleCreate(request, env, deps) {
  const bad = checkSignupConfig(env, deps);
  if (bad) return bad;
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const email = normalizeEmail(body.email);
  if (!email) return json({ error: 'bad_email', message: 'Enter a valid email address.' }, 400);
  if (!(await turnstileOk(request, env, deps, body.turnstile))) return json({ error: 'turnstile_failed' }, 403);

  const token = newToken();
  const tokenHash = await sha256Hex(token);
  const now = deps.now();
  let id = null;
  for (let i = 0; i < 3 && !id; i++) {
    const candidate = newId();
    try { await store.createAltar(env.DB, { id: candidate, tokenHash, email, now }); id = candidate; }
    catch (e) { if (!/unique|constraint/i.test(String(e?.message))) throw e; } // an ID collision: try another
  }
  if (!id) return json({ error: 'try_again' }, 503);
  const emailQueued = await sendVerification(env, deps, { id, email });
  return json({ id, token, emailQueued }, 201);
}

async function handleSave(request, env, deps, id) {
  const altar = await store.getAltar(env.DB, id);
  if (!(await authorized(request, altar))) return json({ error: 'forbidden' }, 403);

  const body = await readBody(request, MAX_BODY_BYTES);
  if (body === null) return json({ error: 'too_large' }, 413);
  let input;
  try { input = JSON.parse(body); } catch { return json({ error: 'bad_json' }, 400); }

  // Entitlements and the stored altar come from OUR database, never from the request.
  let previous = null;
  try { previous = altar.state ? JSON.parse(altar.state) : null; } catch { /* unreadable old state: treat as empty */ }
  const entitlements = await store.getEntitlements(env.DB, id, FEATURES);
  const r = validateOfrenda(input, { entitlements, previous });
  if (!r.ok) return json({ error: r.code, message: r.message, ...(r.feature ? { upgrade: r.feature } : {}) }, r.status);

  await store.saveState(env.DB, id, JSON.stringify(r.state), deps.now());
  return json({ ok: true });
}

async function handleVerify(request, env, deps, id) {
  const body = await readJson(request);
  if (body instanceof Response) return body;
  if (typeof body.token !== 'string' || body.token.length > 200) return json({ error: 'invalid_or_expired' }, 400);
  const now = deps.now();
  const claimed = await store.redeemEmailToken(env.DB, { tokenHash: await sha256Hex(body.token), altarId: id, purpose: 'verify', now });
  if (!claimed) return json({ error: 'invalid_or_expired' }, 400);
  await store.markVerified(env.DB, id, now);
  return json({ ok: true });
}

async function handleResend(request, env, deps, id) {
  const bad = checkSignupConfig(env, deps);
  if (bad) return bad;
  const altar = await store.getAltar(env.DB, id);
  if (!(await authorized(request, altar))) return json({ error: 'forbidden' }, 403);
  if (altar.email_verified_at) return json({ verified: true });
  return json({ verified: false, emailQueued: await sendVerification(env, deps, altar) });
}

async function handleRotate(request, env, deps, id) {
  const altar = await store.getAltar(env.DB, id);
  if (!(await authorized(request, altar))) return json({ error: 'forbidden' }, 403);
  const token = newToken();
  await store.replaceToken(env.DB, id, await sha256Hex(token), deps.now());
  return json({ token });
}

// The response never depends on whether the email is known, and the work runs after the response is sent,
// so neither the body nor the timing tells a stranger which addresses have altars.
async function handleRecoverRequest(request, env, deps) {
  const bad = checkSignupConfig(env, deps);
  if (bad) return bad;
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const email = normalizeEmail(body.email);
  if (!email) return json({ error: 'bad_email', message: 'Enter a valid email address.' }, 400);
  if (!(await turnstileOk(request, env, deps, body.turnstile))) return json({ error: 'turnstile_failed' }, 403);

  queueMail(deps, async () => {
    const now = deps.now();
    const ids = await store.verifiedAltarsByEmail(env.DB, email, TOKEN_RULES.recoverLinksPerEmail); // only confirmed addresses
    if (!ids.length) return;
    const recent = await store.countEmailTokensSince(env.DB, email, 'recover', now - HOUR);
    if (recent + ids.length > TOKEN_RULES.recoverTokensPerEmailPerHour) return;
    const links = [];
    for (const id of ids) {
      const token = newToken();
      await store.addEmailToken(env.DB, { tokenHash: await sha256Hex(token), altarId: id, purpose: 'recover', email, now, ttl: TOKEN_RULES.recoverTtl });
      links.push(`${env.APP_URL}/a/${id}#r=${token}`);
    }
    await deps.mailer.send(recoverMessage({ to: email, links }));
  });
  return json({ ok: true });
}

async function handleRecoverRedeem(request, env, deps, id) {
  const body = await readJson(request);
  if (body instanceof Response) return body;
  if (typeof body.token !== 'string' || body.token.length > 200) return json({ error: 'invalid_or_expired' }, 400);
  const now = deps.now();
  const claimed = await store.redeemEmailToken(env.DB, { tokenHash: await sha256Hex(body.token), altarId: id, purpose: 'recover', now });
  if (!claimed) return json({ error: 'invalid_or_expired' }, 400);
  const token = newToken();
  await store.replaceToken(env.DB, id, await sha256Hex(token), now);
  return json({ token });
}

// Stripe signs "<timestamp>.<raw body>" with HMAC-SHA256; header looks like "t=...,v1=...,v1=...".
export async function verifyStripe(rawBody, header, secret, now = Date.now(), toleranceSec = 300) {
  const pairs = (header || '').split(',').map(p => p.split('='));
  const sigs = pairs.filter(p => p[0] === 'v1' && p[1]).map(p => p[1]);
  const t = Number(pairs.find(p => p[0] === 't')?.[1]);
  if (!Number.isFinite(t) || !sigs.length || Math.abs(now / 1000 - t) > toleranceSec) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${rawBody}`)));
  return sigs.some(s => timingSafeEqual(s, mac));
}

async function handleStripe(request, env, deps) {
  const raw = await readBody(request, 1_000_000);
  if (raw === null || !env.STRIPE_WEBHOOK_SECRET) return json({ error: 'bad_request' }, 400);
  if (!(await verifyStripe(raw, request.headers.get('stripe-signature'), env.STRIPE_WEBHOOK_SECRET, deps.now()))) return json({ error: 'bad_signature' }, 400);
  let event;
  try { event = JSON.parse(raw); } catch { return json({ error: 'bad_json' }, 400); }
  const s = event?.data?.object;
  // metadata.feature is set by YOUR server when it creates the Checkout session (or on the Payment Link).
  // An unknown or missing feature unlocks nothing.
  if (event?.type === 'checkout.session.completed' && s?.payment_status === 'paid' && ID_RE.test(s.client_reference_id || '') && FEATURES.includes(s.metadata?.feature)) {
    const granted = await store.grantFeature(env.DB, s.client_reference_id, s.metadata.feature, deps.now()); // idempotent: Stripe may deliver twice
    if (!granted) console.error('paid checkout for an altar that does not exist:', s.client_reference_id); // 200 anyway: a retry would not help
  }
  return json({ received: true });
}

const ALLOWED = { '': 'GET, PUT', verify: 'POST', 'verify/resend': 'POST', rotate: 'POST', recover: 'POST' };

export const createHandler = (deps = {}) => async (request, env) => {
  const d = { now: Date.now, fetch: globalThis.fetch.bind(globalThis), defer: p => p, mailer: mailerFromEnv(env), ...deps };
  const url = new URL(request.url);
  const cors = env.ALLOW_ORIGIN
    ? { 'access-control-allow-origin': env.ALLOW_ORIGIN, 'access-control-allow-methods': 'GET, PUT, POST, OPTIONS', 'access-control-allow-headers': 'authorization, content-type', vary: 'origin' }
    : {};
  if (request.method === 'OPTIONS') return new Response(null, { status: cors['access-control-allow-origin'] ? 204 : 403, headers: cors });

  let res;
  try {
    const m = /^\/ofrendas\/([^/]+)(?:\/(verify\/resend|verify|rotate|recover))?$/.exec(url.pathname);
    const method = request.method;
    if (url.pathname === '/stripe/webhook' && method === 'POST') res = await handleStripe(request, env, d);
    else if (!env.DB) res = misconfigured('DB');
    else if (url.pathname === '/ofrendas' && method === 'POST') res = await handleCreate(request, env, d);
    else if (url.pathname === '/recover' && method === 'POST') res = await handleRecoverRequest(request, env, d);
    else if (!m || !ID_RE.test(m[1])) res = json({ error: 'not_found' }, 404);
    else {
      const [, id, sub = ''] = m;
      const key = `${method} ${sub}`;
      if (key === 'GET ') {
        const altar = await store.getAltar(env.DB, id);
        res = altar?.state ? new Response(altar.state, { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } }) : json({ error: 'not_found' }, 404);
      } else if (key === 'PUT ') res = await handleSave(request, env, d, id);
      else if (key === 'POST verify') res = await handleVerify(request, env, d, id);
      else if (key === 'POST verify/resend') res = await handleResend(request, env, d, id);
      else if (key === 'POST rotate') res = await handleRotate(request, env, d, id);
      else if (key === 'POST recover') res = await handleRecoverRedeem(request, env, d, id);
      else res = json({ error: 'method_not_allowed' }, 405, { allow: ALLOWED[sub] });
    }
  } catch (e) {
    console.error('unhandled error:', e?.stack || e);
    res = json({ error: 'server_error' }, 500);
  }
  for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
  return res;
};

export default {
  fetch: (request, env, ctx) => createHandler({ defer: p => ctx.waitUntil(p) })(request, env),
};
