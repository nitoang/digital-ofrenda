// Where photos live. With an R2 bucket bound as PHOTOS, photos are kept there and the ofrenda's saved state in D1 holds
// only a short path for each, so a row stays small however many photos there are (D1 rows top out near 2 MB, which
// capped a whole altar at about five photos). Without the binding nothing changes: photos stay inline in D1, as before.
//
//   key in R2     photos/<altarId>/<sha256 of the image bytes>      (the same image twice is stored once)
//   path in state /ofrendas/<altarId>/photos/<sha256>               (what the page puts in <img src>)
//   GET that path serves the image, to anyone who may open the ofrenda (private ofrendas keep their photos private too)
//
// Saving is the same PUT as always. The page may still send a new photo as an inline image: the server checks it (the same
// rules as ever), stores it, and swaps in the path; the reply lists the paths it chose so the page stops re-sending the image.
// A path in a save is accepted only if it names a photo of THIS ofrenda that really exists.

import { PHOTO_PATH_RE, photoPath } from './validate.mjs';
import { canView } from './access.mjs';
import * as store from './store.mjs';

const INLINE = /^data:image\/(jpeg|png|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/;
const TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const HASH = /^[a-f0-9]{64}$/;
const keyFor = (altarId, hash) => `photos/${altarId}/${hash}`;
const prefixFor = altarId => `photos/${altarId}/`;
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');

export class MissingPhoto extends Error {}

const bytesOf = b64 => Uint8Array.from(atob(b64), c => c.charCodeAt(0));
const parse = state => { try { return typeof state === 'string' ? JSON.parse(state) : state; } catch { return null; } };
const photoItems = state => (Array.isArray(state?.items) ? state.items.filter(i => i && i.type === 'photo' && typeof i.src === 'string') : []);

// The hashes of the stored photos a state refers to.
export function photoHashes(state) {
  const out = new Set();
  for (const i of photoItems(parse(state))) { const m = PHOTO_PATH_RE.exec(i.src); if (m) out.add(m[2]); }
  return out;
}
export const hasPhotoPaths = state => photoHashes(state).size > 0;
export const hasInlinePhotos = state => photoItems(parse(state)).some(i => i.src.startsWith('data:'));

// Moves a cleaned state's inline photos into the bucket and returns { state, saved: {itemId: path} }. Throws MissingPhoto
// if the state names a stored photo that is not there.
export async function externalizePhotos(env, altarId, state) {
  const saved = {};
  for (const item of photoItems(state)) {
    const inline = INLINE.exec(item.src);
    if (inline) {
      const bytes = bytesOf(inline[2]);
      const hash = hex(await crypto.subtle.digest('SHA-256', bytes));
      const key = keyFor(altarId, hash);
      if (!(await env.PHOTOS.head(key))) await env.PHOTOS.put(key, bytes, { httpMetadata: { contentType: `image/${inline[1]}` } });
      item.src = photoPath(altarId, hash);
      saved[item.id] = item.src;
    } else {
      const m = PHOTO_PATH_RE.exec(item.src);
      if (!m || m[1] !== altarId || !(await env.PHOTOS.head(keyFor(altarId, m[2])))) throw new MissingPhoto(item.id);
    }
  }
  return { state, saved };
}

// After a save: delete the stored photos that the ofrenda no longer uses. `before` is every state that could have held a
// photo (the one replaced and the one just written); `current` is what is stored now, read back after the write, so a
// photo another save has just put back into use is never deleted from under it.
export async function collectGarbage(env, altarId, before, current) {
  const keep = photoHashes(current);
  const doomed = [];
  for (const state of before) for (const h of photoHashes(state)) if (!keep.has(h)) doomed.push(keyFor(altarId, h));
  if (doomed.length) await env.PHOTOS.delete([...new Set(doomed)]);
}

// Every photo of an ofrenda, for when it is deleted.
export async function deleteAltarPhotos(env, altarId) {
  if (!env.PHOTOS) return;
  let cursor;
  do {
    const page = await env.PHOTOS.list({ prefix: prefixFor(altarId), cursor, limit: 500 });
    if (page.objects.length) await env.PHOTOS.delete(page.objects.map(o => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

// A state with each stored photo turned back into an inline image, for files people download (they must stand alone).
export async function inlinePhotos(env, altarId, state) {
  if (!env.PHOTOS || !state) return state;
  for (const item of photoItems(state)) {
    const m = PHOTO_PATH_RE.exec(item.src);
    if (!m || m[1] !== altarId) continue;
    const obj = await env.PHOTOS.get(keyFor(altarId, m[2]));
    if (!obj) { delete item.src; continue; } // the file is gone: an empty frame beats a broken link
    const type = obj.httpMetadata?.contentType;
    const bytes = new Uint8Array(await obj.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    item.src = `data:${TYPES.has(type) ? type : 'image/jpeg'};base64,${btoa(bin)}`;
  }
  return state;
}

// GET /ofrendas/:id/photos/:hash
export async function handleGetPhoto(request, env, deps, altarId, hash) {
  const miss = () => new Response(JSON.stringify({ error: 'not_found' }), { status: 404, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow' } });
  if (!env.PHOTOS || !HASH.test(hash)) return miss();
  const altar = await store.getAltar(env.DB, altarId);
  if (!altar || !(await canView(request, env, deps, altar))) return miss();
  const etag = `"${hash}"`;
  const headers = {
    etag,
    // Private, and checked every time (a cheap 304 when nothing changed): turning an ofrenda private must cut off its photos at once.
    'cache-control': 'private, no-cache',
    'x-content-type-options': 'nosniff', 'x-robots-tag': 'noindex, nofollow',
    'content-security-policy': "default-src 'none'; sandbox", 'cross-origin-resource-policy': 'same-origin',
  };
  if (request.headers.get('if-none-match') === etag) {
    if (await env.PHOTOS.head(keyFor(altarId, hash))) return new Response(null, { status: 304, headers });
    return miss();
  }
  const obj = await env.PHOTOS.get(keyFor(altarId, hash));
  if (!obj) return miss();
  const type = obj.httpMetadata?.contentType;
  return new Response(obj.body, { headers: { ...headers, 'content-type': TYPES.has(type) ? type : 'application/octet-stream' } });
}

// Moves one ofrenda's inline photos into the bucket (the daily job calls this). Returns true if it changed anything.
// The row is only rewritten if nobody saved it meanwhile; otherwise it is simply tried again on the next run.
export async function migrateAltarPhotos(env, row) {
  const state = parse(row.state);
  if (!state || !hasInlinePhotos(state)) return false;
  await externalizePhotos(env, row.id, state);
  return store.replaceState(env.DB, row.id, row.state, JSON.stringify(state));
}
