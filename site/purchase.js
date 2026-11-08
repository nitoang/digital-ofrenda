// Coming back from Stripe. The browser returns to us a moment before Stripe's webhook may have told the server
// about the payment, so the page waits for the upgrade to show up instead of assuming it already has.

const FEATURES = ['extraPhotos', 'sevenTiers', 'platinum'];

// What the address says about a purchase: { kind: 'success', feature } or { kind: 'cancelled' } or null.
// The marker is removed from the address bar so a reload does not repeat the message.
export function purchaseReturn() {
  const q = new URLSearchParams(location.search);
  const up = q.get('upgraded'), cancelled = q.get('cancelled');
  if (!up && !cancelled) return null;
  history.replaceState(null, '', location.pathname);
  if (up && FEATURES.includes(up)) return { kind: 'success', feature: up };
  return cancelled ? { kind: 'cancelled' } : null;
}

// Keep checking until check() is true, up to about 30 seconds. Returns whether it ever was.
export async function waitUntil(check, { tries = 20, ms = 1500 } = {}) {
  for (let i = 0; i < tries; i++) {
    try { if (await check()) return true; } catch { /* try again */ }
    await new Promise(r => setTimeout(r, ms));
  }
  return false;
}

export const WAITING = 'Thank you! Your payment went through. Applying your upgrade…';
export const SLOW = 'Your payment went through, but the upgrade has not appeared yet. This can take a minute: reload this page shortly.';
export const CANCELLED = 'No problem. Nothing was charged.';
