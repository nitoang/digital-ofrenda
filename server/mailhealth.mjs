// What the email provider tells us after it accepted a message: it bounced, or the person marked it as spam.
// Resend posts these to POST /resend/webhook (signed with Svix, a header triple we verify here). We keep only a
// hash of the address and stop mailing it, which protects the sender's reputation: a domain that keeps mailing
// dead addresses or people who complained starts landing in spam for everyone.
//
//   email.bounced with bounce.type "Permanent"  -> 'bounce'     no mail at all (nothing can arrive)
//   email.suppressed                             -> 'bounce'     the provider refuses it too
//   email.complained                             -> 'complaint'  no mail, except sign-in and email-change codes
//   anything else (a Transient bounce such as a full mailbox, delivered, opened ...) does nothing
//
// The exception for complaints is deliberate. Someone who hit "spam" by accident must still be able to sign in,
// and a code only goes out when they ask for it on our own page.

import { json, readBody, sha256Hex, timingSafeEqual, normalizeEmail } from './util.mjs';
import * as store from './store.mjs';

const toBase64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
const fromBase64 = b64 => Uint8Array.from(atob(b64), c => c.charCodeAt(0));

// Svix signs "<id>.<timestamp>.<raw body>" with HMAC-SHA256 using the secret ("whsec_" + base64). The signature
// header holds one or more space-separated "v1,<base64>" values (more than one while a secret is being rotated).
export async function verifySvix({ id, timestamp, signature }, rawBody, secret, now = Date.now(), toleranceSec = 300) {
  const t = Number(timestamp);
  if (!id || !signature || !Number.isFinite(t) || Math.abs(now / 1000 - t) > toleranceSec) return false;
  let key;
  try { key = fromBase64(secret.replace(/^whsec_/, '')); } catch { return false; }
  const hmac = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = toBase64(await crypto.subtle.sign('HMAC', hmac, new TextEncoder().encode(`${id}.${timestamp}.${rawBody}`)));
  return signature.split(' ').some(part => { const [v, sig] = part.split(','); return v === 'v1' && !!sig && timingSafeEqual(sig, mac); });
}

function reasonFor(event) {
  if (event?.type === 'email.bounced' && event.data?.bounce?.type === 'Permanent') return 'bounce';
  if (event?.type === 'email.suppressed') return 'bounce';
  if (event?.type === 'email.complained') return 'complaint';
  return null;
}

export async function handleResendWebhook(request, env, deps) {
  if (!env.DB || !env.RESEND_WEBHOOK_SECRET) { console.error('digital-ofrenda worker is missing configuration: RESEND_WEBHOOK_SECRET'); return json({ error: 'misconfigured' }, 500); }
  const raw = await readBody(request, 200_000);
  if (raw === null) return json({ error: 'bad_request' }, 400);
  const h = request.headers;
  const signed = await verifySvix({ id: h.get('svix-id'), timestamp: h.get('svix-timestamp'), signature: h.get('svix-signature') }, raw, env.RESEND_WEBHOOK_SECRET, deps.now());
  if (!signed) return json({ error: 'bad_signature' }, 400);
  let event;
  try { event = JSON.parse(raw); } catch { return json({ error: 'bad_json' }, 400); }
  const reason = reasonFor(event);
  if (reason && Array.isArray(event.data?.to)) {
    for (const address of event.data.to.slice(0, 50)) {
      const email = normalizeEmail(address);
      if (email) await store.addSuppression(env.DB, { emailHash: await sha256Hex(email), reason, now: deps.now() });
    }
  }
  return json({ ok: true }); // 200 for everything we understood, including events we ignore, so the provider does not retry them
}

// Wraps a mailer so addresses on the list are skipped. A message marked `essential` (a sign-in or email-change
// code) still goes to someone who complained. The flag is removed before the message reaches the mailer. If the
// list cannot be read, the mail is sent: failing to send a sign-in code is worse than one avoidable bounce.
export function suppressing(mailer, db) {
  if (!mailer || !db) return mailer;
  return {
    async send({ essential, ...msg }) {
      let reason = null;
      try { reason = await store.getSuppression(db, await sha256Hex(String(msg.to).trim().toLowerCase())); }
      catch (e) { console.error('could not read the email suppression list:', e?.message); }
      if (reason === 'bounce' || (reason === 'complaint' && !essential)) { console.error('email skipped: the address is on the suppression list (' + reason + ')'); return; }
      return mailer.send(msg);
    },
  };
}
