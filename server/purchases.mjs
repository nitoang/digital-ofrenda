// A person's purchase history: GET /me/purchases (signed in), and the same list inside the account export.
// Only their own purchases. The payment reference (Stripe's pi_...) is shown so they can find the receipt Stripe emailed
// and quote it if they write to us. No card detail is ever held here.

import { json, isResponse } from './util.mjs';
import * as store from './store.mjs';
import { requireUser } from './auth.mjs';

const iso = ms => (ms == null ? null : new Date(ms).toISOString());
// Stripe's dispute statuses that mean it is over and went our way (or the bank refunded it anyway); anything else but 'lost' is still open.
const SETTLED = new Set(['won', 'warning_closed', 'charge_refunded']);

export function statusOf(p) {
  if (p.dispute_status === 'lost') return 'dispute_lost';
  if (p.refunded_at != null) return 'refunded';
  if (p.dispute_status && !SETTLED.has(p.dispute_status)) return 'disputed';
  if (p.amount_refunded > 0) return 'partly_refunded';
  return 'paid';
}

export const describePurchase = p => ({
  payment: p.payment_intent,
  feature: p.feature,
  ofrenda: p.feature === 'platinum' ? null : p.reference, // what an ofrenda upgrade was bought for; Platinum is for the account
  paid: iso(p.paid_at),
  amount: p.amount ?? null,
  currency: p.currency ?? null,
  refunded: p.refunded_at != null ? (p.amount ?? p.amount_refunded) : p.amount_refunded, // the whole payment once fully refunded
  status: statusOf(p),
});

export async function handlePurchases(request, env, deps) {
  const s = await requireUser(request, env, deps);
  if (isResponse(s)) return s;
  return json({ purchases: (await store.listPurchasesFor(env.DB, s.user.id)).map(describePurchase) });
}
