// Example Cloudflare Worker that receives DigitalOfrenda.storage.save() calls and enforces the
// free-tier limits on the server. It is a starting point, not a drop-in product.
//
// Bindings (see wrangler.example.toml):
//   OFRENDAS  KV namespace. Keys:
//               ofrenda:<id>  the saved altar (JSON)
//               owner:<id>    SHA-256 hex of that altar's edit token. YOU create this when someone starts an
//                             altar (signup flow). No owner record = nobody can write (fail closed).
//               feature:<id>:<name>  "1" once that upgrade is bought; <name> is extraPhotos or sevenTiers.
//                             Only the Stripe webhook sets it, from the session's metadata.feature.
//   STRIPE_WEBHOOK_SECRET  secret from the Stripe dashboard (whsec_...)
//   ALLOW_ORIGIN           optional, e.g. "https://example.com"; CORS is off unless set
//
// Routes:
//   GET  /ofrendas/:id           public read
//   PUT  /ofrendas/:id           write; needs "Authorization: Bearer <edit token>"
//   POST /stripe/webhook         Stripe checkout.session.completed; client_reference_id = the altar id
//
// KV is eventually consistent and has no transactions, so two simultaneous saves can race; for strict
// guarantees use a Durable Object or D1 and do the read-validate-write inside one transaction.

import { validateOfrenda, FEATURES } from './validate.mjs';

export const MAX_BODY_BYTES = 2_500_000;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra } });

const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const sha256Hex = async s => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
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

async function canWrite(request, env, id) {
  const m = /^Bearer (.{16,200})$/.exec(request.headers.get('authorization') || '');
  const expected = await env.OFRENDAS.get('owner:' + id);
  if (!m || !expected) return false;
  return timingSafeEqual(await sha256Hex(m[1]), expected);
}

async function handleSave(request, env, id) {
  if (!(await canWrite(request, env, id))) return json({ error: 'forbidden' }, 403);

  const body = await readBody(request, MAX_BODY_BYTES);
  if (body === null) return json({ error: 'too_large' }, 413);
  let input;
  try { input = JSON.parse(body); } catch { return json({ error: 'bad_json' }, 400); }

  // Paid status and the existing photo count come from OUR storage, never from the request.
  const [flags, previous] = await Promise.all([
    Promise.all(FEATURES.map(f => env.OFRENDAS.get(`feature:${id}:${f}`))),
    env.OFRENDAS.get('ofrenda:' + id, 'json'),
  ]);
  const entitlements = Object.fromEntries(FEATURES.map((f, i) => [f, flags[i] === '1']));
  const r = validateOfrenda(input, { entitlements, previous });
  if (!r.ok) return json({ error: r.code, message: r.message, ...(r.feature ? { upgrade: r.feature } : {}) }, r.status);

  await env.OFRENDAS.put('ofrenda:' + id, JSON.stringify(r.state));
  return json({ ok: true });
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

async function handleStripe(request, env) {
  const raw = await readBody(request, 1_000_000);
  if (raw === null || !env.STRIPE_WEBHOOK_SECRET) return json({ error: 'bad_request' }, 400);
  if (!(await verifyStripe(raw, request.headers.get('stripe-signature'), env.STRIPE_WEBHOOK_SECRET))) return json({ error: 'bad_signature' }, 400);
  let event;
  try { event = JSON.parse(raw); } catch { return json({ error: 'bad_json' }, 400); }
  const s = event?.data?.object;
  // metadata.feature is set by YOUR server when it creates the Checkout session (or on the Payment Link).
  // An unknown or missing feature unlocks nothing.
  if (event?.type === 'checkout.session.completed' && s?.payment_status === 'paid' && ID_RE.test(s.client_reference_id || '') && FEATURES.includes(s.metadata?.feature)) {
    await env.OFRENDAS.put(`feature:${s.client_reference_id}:${s.metadata.feature}`, '1'); // idempotent: Stripe may deliver twice
  }
  return json({ received: true });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = env.ALLOW_ORIGIN
      ? { 'access-control-allow-origin': env.ALLOW_ORIGIN, 'access-control-allow-methods': 'GET, PUT, OPTIONS', 'access-control-allow-headers': 'authorization, content-type', vary: 'origin' }
      : {};
    if (request.method === 'OPTIONS') return new Response(null, { status: cors['access-control-allow-origin'] ? 204 : 403, headers: cors });

    let res;
    if (url.pathname === '/stripe/webhook' && request.method === 'POST') {
      res = await handleStripe(request, env);
    } else {
      const m = /^\/ofrendas\/([^/]+)$/.exec(url.pathname);
      if (!m || !ID_RE.test(m[1])) res = json({ error: 'not_found' }, 404);
      else if (request.method === 'GET') {
        const data = await env.OFRENDAS.get('ofrenda:' + m[1]);
        res = data ? new Response(data, { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } }) : json({ error: 'not_found' }, 404);
      } else if (request.method === 'PUT') res = await handleSave(request, env, m[1]);
      else res = json({ error: 'method_not_allowed' }, 405, { allow: 'GET, PUT, OPTIONS' });
    }
    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
    return res;
  },
};
