// "Download everything": GET /me/export gives the signed-in person one JSON file with their account and every
// ofrenda they own or keep, so nothing they made is locked in. Each altar's `state` is the same cleaned data
// the component's Export button produces (photos inline, even when the server keeps them in its photo store), so it can be loaded
// back with Import (one ofrenda at a time).
//
// Only their own data, plus what the team page already shows them: the email addresses of the people who keep
// the same ofrenda. Pending invitations and the successor are included for owners only (they manage them).
// Never included: sign-in codes, sessions, tokens (they are stored hashed), other people's accounts.

import { json, isResponse } from './util.mjs';
import * as store from './store.mjs';
import { requireUser } from './auth.mjs';
import { inlinePhotos } from './photos.mjs';
import { describePurchase } from './purchases.mjs';

const iso = ms => (ms == null ? null : new Date(ms).toISOString());

export async function handleExport(request, env, deps) {
  const s = await requireUser(request, env, deps);
  if (isResponse(s)) return s;
  const { user } = s;
  const now = deps.now();

  const ofrendas = [];
  for (const a of await store.exportAltars(env.DB, user.id)) {
    let state = null;
    try { state = a.state ? JSON.parse(a.state) : null; } catch { /* a damaged row exports as empty rather than failing the rest */ }
    state = await inlinePhotos(env, a.id, state); // photos kept in the bucket go into the file as inline images, so it stands alone
    const owner = a.role === 'owner';
    const entry = {
      id: a.id, role: a.role, name: a.slug || null, joined: iso(a.added_at), created: iso(a.created_at), updated: iso(a.updated_at),
      upgrades: (await store.listFeatures(env.DB, a.id)).map(f => ({ feature: f.name, granted: iso(f.granted_at) })),
      keepers: (await store.listMembers(env.DB, a.id)).map(m => ({ email: m.email, role: m.role })),
      daysYouVisited: owner ? undefined : await store.visitDays(env.DB, a.id, user.id),
      state,
    };
    if (owner) {
      entry.pendingInvitations = (await store.listInvites(env.DB, a.id, now)).map(i => ({ email: i.email, expires: iso(i.expires_at) }));
      const succ = await store.getSuccessor(env.DB, a.id);
      entry.successor = succ ? { email: succ.email, named: iso(succ.designated_at), accepted: iso(succ.accepted_at) } : null;
    }
    ofrendas.push(entry);
  }

  const body = {
    format: 'digital-ofrenda-account-export', version: 1, exported: iso(now),
    account: { id: user.id, email: user.email, plan: user.plan ?? null, created: iso(await store.getUserCreated(env.DB, user.id)), lastSeen: iso(user.last_seen_at) },
    purchases: (await store.listPurchasesFor(env.DB, user.id)).map(describePurchase),
    ofrendas,
  };
  const day = iso(now).slice(0, 10);
  return json(body, 200, { 'content-disposition': `attachment; filename="digital-ofrenda-export-${day}.json"` });
}
