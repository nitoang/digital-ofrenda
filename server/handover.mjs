// Handing an ofrenda to someone else. The recipient becomes an owner and the person handing it over stays one.
//
//   - The recipient already has an account (a co-keeper, or anyone): it happens at once.
//   - They have no account: it waits (RULES.handoverWait) and takes effect the first time they sign in with that address.
//   - A free account that already owns RULES.freeAltars ofrendas cannot be handed another until they upgrade.
//   - The owner must type the word "handover", and an account may start RULES.handoversPerDay a day.
// What happens if a new person never signs up is decided by the scheduled reminders, not here.

import { json, readJson, isResponse, normalizeEmail, newId } from './util.mjs';
import * as store from './store.mjs';
import { asRole, altarName } from './team.mjs';
import { queueMail, handoverOfferMessage, handoverReceivedMessage, handoverAcceptedMessage } from './mail.mjs';
import { RULES } from './rules.mjs';

const atLimit = (user, owned) => user.plan !== 'platinum' && owned >= RULES.freeAltars;

export async function handleHandover(request, env, deps, id) {
  const s = await asRole(request, env, deps, id, ['owner']);
  if (isResponse(s)) return s;
  const body = await readJson(request);
  if (isResponse(body)) return body;
  if (typeof body.confirm !== 'string' || body.confirm.trim().toLowerCase() !== RULES.handoverWord) {
    return json({ error: 'confirm_required', message: `Type “${RULES.handoverWord}” to confirm.` }, 400);
  }
  const email = normalizeEmail(body.email);
  if (!email) return json({ error: 'bad_email', message: 'Enter a valid email address.' }, 400);
  if (email === s.user.email) return json({ error: 'bad_email', message: 'Choose someone other than yourself.' }, 400);

  const now = deps.now();
  if (await store.getHandover(env.DB, id)) return json({ error: 'handover_pending', message: 'A handover is already waiting. Cancel it first to choose someone else.' }, 409);
  if ((await store.countHandoversSince(env.DB, s.user.id, now - 86_400_000)) >= RULES.handoversPerDay) {
    return json({ error: 'too_many_handovers', message: `You can hand over up to ${RULES.handoversPerDay} ofrendas a day. Please try again tomorrow.` }, 429);
  }
  const name = await altarName(env, id);
  const recipient = await store.findUserByEmail(env.DB, email);

  if (recipient) {
    if ((await store.getRole(env.DB, id, recipient.id)) === 'owner') return json({ error: 'already_owner', message: 'They already own this ofrenda.' }, 409);
    if (atLimit(recipient, await store.countOwnedAltars(env.DB, recipient.id))) {
      return json({ error: 'recipient_at_limit', message: `They already own ${RULES.freeAltars} ofrendas, the most a free account can. They need to upgrade before you can hand this one over.` }, 409);
    }
    await store.addOwner(env.DB, { altarId: id, userId: recipient.id, now });
    await store.logHandover(env.DB, { id: newId(8), userId: s.user.id, now });
    const ref = (await store.currentSlug(env.DB, id)) || id;
    queueMail(deps, () => deps.mailer.send(handoverReceivedMessage({ to: email, from: s.user.email, link: `${env.APP_URL}/a/${ref}`, name })));
    return json({ status: 'done' }, 201);
  }

  // A few waiting handovers to one new address would leave them over the free limit once they sign up.
  if ((await store.countHandoversTo(env.DB, email, now)) + 1 >= RULES.freeAltars) {
    return json({ error: 'recipient_at_limit', message: 'That person already has as many handovers waiting as a free account can hold.' }, 409);
  }
  const expiresAt = now + RULES.handoverWait;
  if (!(await store.createHandover(env.DB, { altarId: id, toEmail: email, fromUserId: s.user.id, now, expiresAt }))) return json({ error: 'handover_pending' }, 409);
  await store.logHandover(env.DB, { id: newId(8), userId: s.user.id, now });
  queueMail(deps, () => deps.mailer.send(handoverOfferMessage({ to: email, from: s.user.email, link: `${env.APP_URL}/signin`, name })));
  return json({ status: 'pending', expiresAt }, 201);
}

export async function handleCancelHandover(request, env, deps, id) {
  const s = await asRole(request, env, deps, id, ['owner']);
  if (isResponse(s)) return s;
  return (await store.cancelHandover(env.DB, id)) ? json({ ok: true }) : json({ error: 'not_found' }, 404);
}

// Called when an address signs in for the first time: any handover waiting for it takes effect.
export async function applyWaitingHandovers(env, deps, user) {
  const now = deps.now();
  for (const h of await store.takeHandoversFor(env.DB, user.email, now)) {
    await store.addOwner(env.DB, { altarId: h.altar_id, userId: user.id, now });
    const giver = await store.getUser(env.DB, h.from_user_id);
    if (giver) queueMail(deps, () => deps.mailer.send(handoverAcceptedMessage({ to: giver.email, who: user.email })));
  }
}
