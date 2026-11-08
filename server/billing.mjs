// Stripe webhook: unlocks what was bought. Two kinds of purchase:
//   metadata.feature = "extraPhotos" | "sevenTiers"  client_reference_id = the ALTAR id   (per altar)
//   metadata.feature = "platinum"                     client_reference_id = the USER id    (whole account)
// checkout.mjs sets both when it creates the Checkout session. Anything unknown or missing unlocks nothing.
// A card payment arrives as checkout.session.completed with payment_status "paid". A delayed payment method
// arrives as completed/"unpaid" (ignored) and later as checkout.session.async_payment_succeeded (accepted).

import { json, readBody, timingSafeEqual } from './util.mjs';
import { FEATURES } from './validate.mjs';
import * as store from './store.mjs';

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const PAID_EVENTS = ['checkout.session.completed', 'checkout.session.async_payment_succeeded'];
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');

// Stripe signs "<timestamp>.<raw body>" with HMAC-SHA256; the header looks like "t=...,v1=...,v1=...".
export async function verifyStripe(rawBody, header, secret, now = Date.now(), toleranceSec = 300) {
  const pairs = (header || '').split(',').map(p => p.split('='));
  const sigs = pairs.filter(p => p[0] === 'v1' && p[1]).map(p => p[1]);
  const t = Number(pairs.find(p => p[0] === 't')?.[1]);
  if (!Number.isFinite(t) || !sigs.length || Math.abs(now / 1000 - t) > toleranceSec) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${rawBody}`)));
  return sigs.some(s => timingSafeEqual(s, mac));
}

export async function handleStripe(request, env, deps) {
  const raw = await readBody(request, 1_000_000);
  if (raw === null || !env.STRIPE_WEBHOOK_SECRET) return json({ error: 'bad_request' }, 400);
  if (!(await verifyStripe(raw, request.headers.get('stripe-signature'), env.STRIPE_WEBHOOK_SECRET, deps.now()))) return json({ error: 'bad_signature' }, 400);
  let event;
  try { event = JSON.parse(raw); } catch { return json({ error: 'bad_json' }, 400); }
  const s = event?.data?.object;
  const feature = s?.metadata?.feature;
  if (PAID_EVENTS.includes(event?.type) && s?.payment_status === 'paid' && ID_RE.test(s.client_reference_id || '')) {
    let ok = true; // idempotent: Stripe may deliver twice
    if (feature === 'platinum') ok = await store.setPlan(env.DB, s.client_reference_id, 'platinum');
    else if (FEATURES.includes(feature)) ok = await store.grantFeature(env.DB, s.client_reference_id, feature, deps.now());
    if (!ok) console.error('paid checkout for something that does not exist:', feature, s.client_reference_id); // 200 anyway: a retry would not help
  }
  return json({ received: true });
}
