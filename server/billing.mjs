// Stripe webhook: unlocks what was bought. Two kinds of purchase:
//   metadata.feature = "extraPhotos" | "sevenTiers"  client_reference_id = the ALTAR id   (per altar)
//   metadata.feature = "platinum"                     client_reference_id = the USER id    (whole account)
// checkout.mjs sets both when it creates the Checkout session. Anything unknown or missing unlocks nothing.
// A card payment arrives as checkout.session.completed with payment_status "paid". A delayed payment method
// arrives as completed/"unpaid" (ignored) and later as checkout.session.async_payment_succeeded (accepted).
//
// Refunds: a payment we acted on is recorded in `purchases`. When Stripe says a charge was refunded IN FULL
// (charge.refunded with refunded=true; a partial refund changes nothing), the upgrade it paid for is taken away,
// unless another unrefunded payment still covers the same thing (someone who paid twice and got one back
// keeps what they paid for). Clearing an upgrade does not delete what an altar already holds: the next save is
// simply held to the free limits again.

import { json, readBody, timingSafeEqual } from './util.mjs';
import { FEATURES } from './validate.mjs';
import * as store from './store.mjs';

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const PAID_EVENTS = ['checkout.session.completed', 'checkout.session.async_payment_succeeded'];
const REFUND_EVENTS = ['charge.refunded'];
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
  if (!(await verifyStripe(raw, request.headers.get('stripe-signature'), env.STRIPE_WEBHOOK_SECRET, deps.now()))) {
    deps.alert?.('stripe_webhook_rejected', 'A request to /stripe/webhook failed signature checking. If this keeps happening, STRIPE_WEBHOOK_SECRET may not match the one in Stripe, and payments will not unlock anything.');
    return json({ error: 'bad_signature' }, 400);
  }
  let event;
  try { event = JSON.parse(raw); } catch { return json({ error: 'bad_json' }, 400); }
  const s = event?.data?.object;
  const feature = s?.metadata?.feature;
  if (PAID_EVENTS.includes(event?.type) && s?.payment_status === 'paid') {
    const known = ID_RE.test(s.client_reference_id || '') && (feature === 'platinum' || FEATURES.includes(feature));
    const pi = typeof s.payment_intent === 'string' && ID_RE.test(s.payment_intent) ? s.payment_intent : null;
    // Stripe does not promise order. A "paid" event that turns up after the refund of the same payment (a late retry)
    // must not hand the upgrade back, so a payment we already know was refunded unlocks nothing.
    if (known && pi && (await store.getPurchase(env.DB, pi))?.refunded_at) return json({ received: true });
    let ok = known; // idempotent: Stripe may deliver twice
    if (known && feature === 'platinum') ok = await store.setPlan(env.DB, s.client_reference_id, 'platinum');
    else if (known) ok = await store.grantFeature(env.DB, s.client_reference_id, feature, deps.now());
    // Money was taken and nothing was unlocked. 200 anyway (a retry would not help), but a person must look at it.
    if (!ok) {
      console.error('paid checkout for something that does not exist:', feature, s.client_reference_id);
      deps.alert?.('paid_not_delivered', `Stripe says a checkout was paid (payment ${typeof s.payment_intent === 'string' ? s.payment_intent : 'unknown'}) but it unlocked nothing: feature "${String(feature).slice(0, 30)}", reference "${String(s.client_reference_id).slice(0, 30)}". Check it in Stripe and refund or fix it by hand.`);
    } else if (pi) {
      await store.recordPurchase(env.DB, { paymentIntent: pi, feature, reference: s.client_reference_id, now: deps.now() });
    }
  } else if (REFUND_EVENTS.includes(event?.type) && s?.refunded === true) {
    await handleRefund(env, deps, s);
  }
  return json({ received: true });
}

// `charge` is Stripe's charge object. What was bought comes from our own record of the payment, or, for a
// payment we have no record of, from the metadata we put on it when creating the Checkout session.
async function handleRefund(env, deps, charge) {
  const pi = typeof charge.payment_intent === 'string' && ID_RE.test(charge.payment_intent) ? charge.payment_intent : null;
  const purchase = pi ? await store.getPurchase(env.DB, pi) : null;
  const feature = purchase?.feature ?? charge.metadata?.feature;
  const reference = purchase?.reference ?? charge.metadata?.reference;
  if (!(feature === 'platinum' || FEATURES.includes(feature)) || !ID_RE.test(reference || '')) {
    console.error('refund for a payment we cannot trace:', pi);
    deps.alert?.('refund_untraced', `Stripe refunded a payment (${pi || 'no payment id'}) that we cannot match to an upgrade, so nothing was taken back. Check it in Stripe.`);
    return; // 200 anyway: a retry would not help
  }
  // A refund that arrives first is written down too, so the "paid" event that follows it cannot unlock anything.
  if (pi && !purchase) await store.recordPurchase(env.DB, { paymentIntent: pi, feature, reference, now: deps.now() });
  if (pi) await store.markRefunded(env.DB, pi, deps.now());
  if ((await store.countUnrefunded(env.DB, feature, reference)) > 0) return; // another payment still covers it
  if (feature === 'platinum') await store.clearPlan(env.DB, reference);
  else await store.removeFeature(env.DB, reference, feature);
}
