// Starting a purchase. The browser asks for a feature; this asks Stripe for a Checkout Session and returns its
// address. The page never chooses a price, a reference or any metadata: those come only from here, which is
// what the webhook (billing.mjs) later trusts.
//
//   extraPhotos, sevenTiers  bought for one altar, by its owner      reference = the altar id
//   platinum                 bought for the signed-in account        reference = the user id
//
// Prices are made in your Stripe dashboard (one-time payments); this reads their ids from the environment, so
// no amount is ever written in code.

import { json, readJson, isResponse } from './util.mjs';
import { FEATURES } from './validate.mjs';
import * as store from './store.mjs';
import { requireUser } from './auth.mjs';

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const PRICE_VARS = { extraPhotos: 'STRIPE_PRICE_EXTRA_PHOTOS', sevenTiers: 'STRIPE_PRICE_SEVEN_TIERS', platinum: 'STRIPE_PRICE_PLATINUM' };
const STRIPE_SESSIONS = 'https://api.stripe.com/v1/checkout/sessions';
const CHECKOUT_PREFIX = 'https://checkout.stripe.com/';

export async function handleCheckout(request, env, deps) {
  const s = await requireUser(request, env, deps);
  if (isResponse(s)) return s;
  const body = await readJson(request);
  if (isResponse(body)) return body;

  const feature = body.feature;
  if (typeof feature !== 'string' || !Object.hasOwn(PRICE_VARS, feature)) return json({ error: 'bad_feature' }, 400);
  const price = env[PRICE_VARS[feature]];
  if (!env.STRIPE_SECRET_KEY || !price) return json({ error: 'checkout_unavailable', message: 'Purchases are not open yet.' }, 503);

  let reference, back;
  if (feature === 'platinum') {
    if (s.user.plan === 'platinum') return json({ error: 'already_unlocked', message: 'You already have Platinum.' }, 409);
    reference = s.user.id;
    back = '/my';
  } else {
    const altarId = typeof body.altarId === 'string' && ID_RE.test(body.altarId) ? body.altarId : null;
    if (!altarId) return json({ error: 'bad_altar' }, 400);
    const role = await store.getRole(env.DB, altarId, s.user.id);
    if (!role) return json({ error: 'forbidden' }, 403);
    if (role !== 'owner') return json({ error: 'owner_only', message: 'Only the owner can buy upgrades for this ofrenda.' }, 403);
    if ((await store.getEntitlements(env.DB, altarId, FEATURES))[feature]) {
      return json({ error: 'already_unlocked', message: 'This ofrenda already has that.' }, 409);
    }
    reference = altarId;
    back = `/a/${altarId}`;
  }

  const form = new URLSearchParams({
    mode: 'payment',
    'line_items[0][price]': price,
    'line_items[0][quantity]': '1',
    client_reference_id: reference,
    'metadata[feature]': feature,
    'metadata[user_id]': s.user.id, // who is buying, so the purchase shows up in their history
    // Also on the payment itself, so a later refund can be traced back to what it bought.
    'payment_intent_data[metadata][feature]': feature,
    'payment_intent_data[metadata][reference]': reference,
    customer_email: s.user.email,
    'payment_intent_data[receipt_email]': s.user.email, // Stripe emails the receipt itself
    success_url: `${env.APP_URL}${back}?upgraded=${feature}`, // says what was bought, so the page knows what to wait for
    cancel_url: `${env.APP_URL}${back}?cancelled=1`,
  });

  let res, data = null;
  try {
    res = await deps.fetch(STRIPE_SESSIONS, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: form,
    });
    data = await res.json().catch(() => null);
  } catch (e) {
    console.error('could not reach Stripe:', e?.message);
  }
  // Only ever send a person to Stripe's own checkout address.
  if (!res || !res.ok || typeof data?.url !== 'string' || !data.url.startsWith(CHECKOUT_PREFIX)) {
    console.error('Stripe would not create a checkout session:', res?.status, data?.error?.message);
    return json({ error: 'checkout_failed', message: 'We could not start the payment. Please try again in a moment.' }, 502);
  }
  return json({ url: data.url });
}
