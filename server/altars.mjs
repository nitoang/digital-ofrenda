// Creating, reading, saving and deleting altars. Saving applies validateOfrenda with entitlements read from
// OUR database (per-altar upgrades, or the owner's platinum plan), never from the request.

import { json, readBody, readJson, newId, isResponse, normalizeSlug } from './util.mjs';
import { validateOfrenda, FEATURES } from './validate.mjs';
import * as store from './store.mjs';
import { requireUser } from './auth.mjs';
import { RULES } from './rules.mjs';
import { retireOwner } from './owners.mjs';

export const MAX_BODY_BYTES = 2_500_000;

export async function handleCreate(request, env, deps) {
  const s = await requireUser(request, env, deps);
  if (isResponse(s)) return s;
  if (s.user.plan !== 'platinum' && (await store.countOwnedAltars(env.DB, s.user.id)) >= RULES.freeAltars) {
    return json({ error: 'altar_limit', message: `Free accounts can own ${RULES.freeAltars} ofrendas.`, upgrade: 'platinum' }, 402);
  }
  for (let i = 0; i < 3; i++) {
    const id = newId();
    try { await store.createAltar(env.DB, { id, userId: s.user.id, now: deps.now() }); return json({ id }, 201); }
    catch (e) { if (!/unique|constraint/i.test(String(e?.message))) throw e; } // an ID collision: try another
  }
  return json({ error: 'try_again' }, 503);
}

// Public: anyone with the link can view. Returns only the altar, never who keeps it.
export async function handleGet(env, id) {
  const altar = await store.getAltar(env.DB, id);
  return altar?.state
    ? new Response(altar.state, { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
    : json({ error: 'not_found' }, 404);
}

export async function handleSave(request, env, deps, id) {
  const s = await requireUser(request, env, deps);
  if (isResponse(s)) return s;
  if (!(await store.getRole(env.DB, id, s.user.id))) return json({ error: 'forbidden' }, 403);
  if (await store.altarLockedFor(env.DB, id, s.user.id, RULES.freeAltars)) {
    return json({ error: 'ofrenda_locked', message: `Free accounts can own ${RULES.freeAltars} ofrendas, so this one can be viewed but not changed until you upgrade.`, upgrade: 'platinum' }, 402);
  }

  const body = await readBody(request, MAX_BODY_BYTES);
  if (body === null) return json({ error: 'too_large' }, 413);
  let input;
  try { input = JSON.parse(body); } catch { return json({ error: 'bad_json' }, 400); }

  const altar = await store.getAltar(env.DB, id);
  let previous = null;
  try { previous = altar?.state ? JSON.parse(altar.state) : null; } catch { /* unreadable old state: treat as empty */ }
  const entitlements = await store.getEntitlements(env.DB, id, FEATURES);
  const r = validateOfrenda(input, { entitlements, previous });
  if (!r.ok) return json({ error: r.code, message: r.message, ...(r.feature ? { upgrade: r.feature } : {}) }, r.status);

  await store.saveState(env.DB, id, JSON.stringify(r.state), deps.now());
  return json({ ok: true });
}

export async function handleDelete(request, env, deps, id) {
  const s = await requireUser(request, env, deps);
  if (isResponse(s)) return s;
  if ((await store.getRole(env.DB, id, s.user.id)) !== 'owner') return json({ error: 'forbidden' }, 403);
  return json({ ok: true, outcome: await retireOwner(env, deps, id, s.user) });
}

// Public: which ofrenda does this vanity name point to? Anyone with the name can already view it, so this says nothing new.
export async function handleByName(env, name) {
  const slug = normalizeSlug(name);
  const id = slug && (await store.altarIdForSlug(env.DB, slug));
  return id ? json({ id, slug: await store.currentSlug(env.DB, id) }, 200, { 'cache-control': 'no-store' }) : json({ error: 'not_found' }, 404);
}

// The owner picks the name. It is only an extra address: the original link keeps working, and so do the
// owner's earlier names.
export async function handleSetSlug(request, env, deps, id) {
  const s = await requireUser(request, env, deps);
  if (isResponse(s)) return s;
  if ((await store.getRole(env.DB, id, s.user.id)) !== 'owner') return json({ error: 'forbidden' }, 403);
  const body = await readJson(request);
  if (isResponse(body)) return body;
  const slug = normalizeSlug(body.slug);
  if (!slug) return json({ error: 'bad_name', message: 'Use 3 to 40 letters, numbers and single hyphens, like abuela-rosa.' }, 400);
  const r = await store.setSlug(env.DB, { altarId: id, slug, now: deps.now(), max: RULES.slugsPerAltar });
  if (r === 'taken') return json({ error: 'name_taken', message: 'That name is already used. Try another.' }, 409);
  if (r === 'limit') return json({ error: 'too_many_names', message: `An ofrenda can use up to ${RULES.slugsPerAltar} names over its life, counting old ones. Take one of them back instead.` }, 409);
  return json({ slug });
}

// What the signed-in page needs: who I am, my altars, and any takeover I could start or have started.
export async function handleMe(request, env, deps) {
  const s = await requireUser(request, env, deps);
  if (isResponse(s)) return s;
  const successorOf = (await store.altarsWhereSuccessor(env.DB, s.user.id)).map(r => ({
    id: r.id,
    claim: r.executes_at && !r.cancelled_at && !r.completed_at ? { executesAt: r.executes_at } : null,
  }));
  const rows = await store.altarsForUser(env.DB, s.user.id);
  let owned = 0; // rows are oldest first, so the ones past the free limit are the locked ones
  const altars = rows.map(r => r.role === 'owner' ? { ...r, locked: s.user.plan !== 'platinum' && ++owned > RULES.freeAltars } : r);
  return json({ user: { id: s.user.id, email: s.user.email, plan: s.user.plan ?? null }, altars, successorOf });
}
