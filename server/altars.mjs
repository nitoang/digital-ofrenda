// Creating, reading, saving and deleting altars. Saving applies validateOfrenda with entitlements read from
// OUR database (per-altar upgrades, or the owner's platinum plan), never from the request.

import { json, readBody, newId, isResponse } from './util.mjs';
import { validateOfrenda, FEATURES } from './validate.mjs';
import * as store from './store.mjs';
import { requireUser } from './auth.mjs';
import { RULES } from './rules.mjs';

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
  await store.deleteAltar(env.DB, id);
  return json({ ok: true });
}

// What the signed-in page needs: who I am, my altars, and any takeover I could start or have started.
export async function handleMe(request, env, deps) {
  const s = await requireUser(request, env, deps);
  if (isResponse(s)) return s;
  const successorOf = (await store.altarsWhereSuccessor(env.DB, s.user.id)).map(r => ({
    id: r.id,
    claim: r.executes_at && !r.cancelled_at && !r.completed_at ? { executesAt: r.executes_at } : null,
  }));
  return json({ user: { id: s.user.id, email: s.user.email, plan: s.user.plan ?? null }, altars: await store.altarsForUser(env.DB, s.user.id), successorOf });
}
